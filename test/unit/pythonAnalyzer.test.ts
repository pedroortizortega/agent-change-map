import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePython } from "../../src/analysis/pythonAnalyzer.js";

const snapshot = { repoId: "fixture", kind: "worktree" as const, contentDigest: "sha256:fixture" };
const extensionRoot = resolve(__dirname, "../..");

const analyze = (files: { path: string; content: string }[]) =>
  analyzePython({ type: "analyze", snapshot, files }, extensionRoot);

describe("Python AST analyzer", () => {
  it("extracts nested entities, imports, calls, and exact UTF-8 spans", async () => {
    const graph = await analyze([
      { path: "pkg/__init__.py", content: "" },
      { path: "pkg/sample.py", content: "import pkg.helpers\nfrom missing import item\n\ndef duplicate(): pass\nclass Container:\n    def duplicate(self): pass\n    def run(self, callback):\n        def nested(): return duplicate()\n        duplicate()\n        callback()\n        obj.dynamic()\n        return nested()\n" },
      { path: "pkg/helpers.py", content: "def helper():\n    return 'á'\n" },
    ]);
    expect(graph.nodes.map((node) => node.qualifiedName)).toEqual(expect.arrayContaining(["pkg", "pkg.sample", "pkg.sample.duplicate", "pkg.sample.Container", "pkg.sample.Container.run.nested"]));
    expect(graph.edges.filter((edge) => edge.kind === "import").map((edge) => [edge.importedName, edge.resolution.kind])).toEqual([["pkg.helpers", "resolved"], ["missing.item", "unresolved"]]);
    expect(graph.edges.filter((edge) => edge.kind === "call").map((edge) => edge.resolution.kind)).toEqual(expect.arrayContaining(["resolved", "unresolved"]));
    const helper = graph.nodes.find((node) => node.qualifiedName === "pkg.helpers.helper")!;
    expect(Buffer.from("def helper():\n    return 'á'\n").subarray(helper.span.startByte, helper.span.endByte).toString()).toBe("def helper():\n    return 'á'");
  });

  it("reports syntax diagnostics without discarding valid files", async () => {
    const graph = await analyze([{ path: "valid.py", content: "def valid():\n    return 1\n" }, { path: "broken.py", content: "def broken(:\n" }]);
    expect(graph.nodes.some((node) => node.qualifiedName === "valid.valid")).toBe(true);
    expect(graph.diagnostics).toEqual([expect.objectContaining({ path: "broken.py", severity: "error" })]);
  });

  it("resolves direct calls only through Python lexical scopes", async () => {
    const graph = await analyze([{ path: "local.py", content: "def helper(): pass\ndef run(): return helper()\n" }, { path: "other.py", content: "class Noise:\n    def helper(self): pass\n" }]);
    const call = graph.edges.find((edge) => edge.kind === "call");
    const helper = graph.nodes.find((node) => node.qualifiedName === "local.helper");
    expect(call?.resolution).toEqual({ kind: "resolved", target: helper?.id });
  });

  it("preserves exact evidence for empty files, trailing newlines, and real packages only", async () => {
    const graph = await analyze([{ path: "empty.py", content: "" }, { path: "pkg/mod.py", content: "x = 1\n" }]);
    expect(graph.nodes.find((node) => node.qualifiedName === "empty")?.span).toMatchObject({ endByte: 0, endLine: 1, endColumn: 0 });
    expect(graph.nodes.find((node) => node.qualifiedName === "pkg.mod")?.span).toMatchObject({ endByte: 6, endLine: 2, endColumn: 0 });
    expect(graph.nodes.some((node) => node.kind === "package")).toBe(false);
  });

  it("keeps legal same-scope redefinitions distinct and deterministic", async () => {
    const files = [{ path: "repeat.py", content: "def same(): pass\ndef same(): pass\n" }];
    const first = await analyze(files);
    const second = await analyze(files);
    const ids = first.nodes.filter((node) => node.qualifiedName === "repeat.same").map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(second.nodes.filter((node) => node.qualifiedName === "repeat.same").map((node) => node.id));
  });

  it("resolves from-imports to present symbols and leaves absent symbols unresolved", async () => {
    const graph = await analyze([{ path: "pkg/__init__.py", content: "" }, { path: "pkg/b.py", content: "def f(): pass\n" }, { path: "pkg/a.py", content: "from pkg.b import f, absent\n" }]);
    const symbol = graph.nodes.find((node) => node.qualifiedName === "pkg.b.f");
    const imports = graph.edges.filter((edge) => edge.kind === "import");
    expect(imports.find((edge) => edge.importedName === "pkg.b.f")?.resolution).toEqual({ kind: "resolved", target: symbol?.id });
    expect(imports.find((edge) => edge.importedName === "pkg.b.absent")?.resolution).toEqual({ kind: "unresolved" });
  });

  it("resolves relative from-imports within and across packages", async () => {
    const graph = await analyze([
      { path: "pkg/__init__.py", content: "" },
      { path: "pkg/b.py", content: "def f(): pass\n" },
      { path: "pkg/a.py", content: "from . import b\nfrom .b import f\n" },
    ]);
    const module = graph.nodes.find((node) => node.qualifiedName === "pkg.b");
    const symbol = graph.nodes.find((node) => node.qualifiedName === "pkg.b.f");
    const imports = graph.edges.filter((edge) => edge.kind === "import");
    expect(imports.find((edge) => edge.importedName === ".b")?.resolution).toEqual({ kind: "resolved", target: module?.id });
    expect(imports.find((edge) => edge.importedName === ".b.f")?.resolution).toEqual({ kind: "resolved", target: symbol?.id });
  });

  it("resolves direct calls to a name bound by a from-import", async () => {
    const graph = await analyze([
      { path: "pkg/__init__.py", content: "" },
      { path: "pkg/b.py", content: "def f(): pass\n" },
      { path: "pkg/a.py", content: "from pkg.b import f\nf()\n" },
    ]);
    const symbol = graph.nodes.find((node) => node.qualifiedName === "pkg.b.f");
    const call = graph.edges.find((edge) => edge.kind === "call");
    expect(call?.resolution).toEqual({ kind: "resolved", target: symbol?.id });
  });

  it("derives the analyzer only from an absolute extension installation root", async () => {
    await expect(analyzePython({ type: "analyze", snapshot, files: [{ path: "a.py", content: "" }] }, ".")).rejects.toThrow(/absolute extension root/);
  });

  it("resolves direct-name calls unchanged by the _lexical_candidates extraction (characterization guard)", async () => {
    const graph = await analyze([{ path: "local.py", content: "def helper(): pass\ndef run(): return helper()\n" }, { path: "other.py", content: "class Noise:\n    def helper(self): pass\n" }]);
    const call = graph.edges.find((edge) => edge.kind === "call");
    const helper = graph.nodes.find((node) => node.qualifiedName === "local.helper");
    expect(call?.resolution).toEqual({ kind: "resolved", target: helper?.id });
  });

  it("resolves instance-constructor calls unchanged by the _class_names extraction (characterization guard)", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run():\n    route = Route()\n    return route.get_info()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.get_info");
    expect(callAt(6)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("resolves a call through a locally constructed instance variable", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run():\n    route = Route()\n    return route.get_info()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.get_info");
    expect(callAt(6)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("reports ambiguous candidates when an instance variable is reassigned across branches", async () => {
    const graph = await analyze([{ path: "local.py", content: "class A:\n    def go(self): pass\n\nclass B:\n    def go(self): pass\n\ndef run(flag):\n    if flag:\n        x = A()\n    else:\n        x = B()\n    return x.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const goA = graph.nodes.find((node) => node.qualifiedName === "local.A.go");
    const goB = graph.nodes.find((node) => node.qualifiedName === "local.B.go");
    expect(callAt(12)?.resolution).toEqual({ kind: "ambiguous", candidates: [goA?.id, goB?.id].sort() });
  });

  it("keeps repeated assignment of the same class resolved rather than ambiguous", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run(flag):\n    x = Route()\n    if flag:\n        x = Route()\n    return x.get_info()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(8)?.resolution.kind).toBe("resolved");
  });

  it("leaves instance calls unresolved when the constructor class is unknown", async () => {
    const graph = await analyze([{ path: "local.py", content: "def run():\n    x = Unknown()\n    return x.method()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(3)?.resolution).toEqual({ kind: "unresolved" });
  });

  it("leaves instance calls unresolved when the bound class has no matching method", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run():\n    route = Route()\n    return route.missing()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(6)?.resolution).toEqual({ kind: "unresolved" });
  });

  it("leaves unsupported instance-binding shapes unresolved", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef factory():\n    return Route()\n\nclass Holder:\n    def __init__(self):\n        self.route = Route()\n    def run(self):\n        return self.route.get_info()\n\ndef chained():\n    return factory().get_info()\n\ndef tupled():\n    a, b = Route(), Route()\n    return a.get_info()\n\ndef rebound():\n    r = Route()\n    s = r\n    return s.get_info()\n\ndef chain_assigned():\n    p = q = Route()\n    return p.get_info()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    for (const line of [14, 18, 23, 27]) {
      expect(callAt(line)?.resolution).toEqual({ kind: "unresolved" });
    }
  });

  it("scopes instance bindings to the assignment's own scope", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef bind():\n    route = Route()\n\ndef other(route):\n    return route.get_info()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(8)?.resolution).toEqual({ kind: "unresolved" });
  });

  it("resolves instance calls to a class bound by a from-import", async () => {
    const graph = await analyze([
      { path: "pkg/__init__.py", content: "" },
      { path: "pkg/routes.py", content: "class Route4:\n    def get_info(self): pass\n" },
      { path: "pkg/app.py", content: "from pkg.routes import Route4\n\nclass Main:\n    def run(self):\n        instance = Route4()\n        print(instance.get_info())\n" },
    ]);
    const method = graph.nodes.find((node) => node.qualifiedName === "pkg.routes.Route4.get_info");
    // Line 6 is `print(instance.get_info())`, which contains two call edges (print, get_info);
    // disambiguate by column since `print(` is 6 characters wide.
    const call = graph.edges.find((edge) => edge.kind === "call" && edge.span.path === "pkg/app.py" && edge.span.startLine === 6 && edge.span.startColumn === 14);
    expect(call?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("resolves a call through a bare annotated variable", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef run():\n    x: Route\n    return x.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.go");
    expect(callAt(6)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("resolves a call through an annotated variable with an assigned value", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef run():\n    x: Route = Route()\n    return x.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.go");
    const constructor = graph.nodes.find((node) => node.qualifiedName === "local.Route");
    expect(callAt(6)?.resolution).toEqual({ kind: "resolved", target: method?.id });
    const constructorCall = graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === 5);
    expect(constructorCall?.resolution).toEqual({ kind: "resolved", target: constructor?.id });
  });

  it("resolves a call through an annotated function parameter", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef run(r: Route):\n    return r.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.go");
    expect(callAt(5)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("leaves quoted, generic, and unknown annotations unresolved", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef run():\n    x: \"Route\"\n    y: Optional[Route]\n    z: Unknown\n    x.go()\n    y.go()\n    z.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    for (const line of [8, 9, 10]) {
      expect(callAt(line)?.resolution).toEqual({ kind: "unresolved" });
    }
  });

  it("does not bind starred or keyword-collector parameter annotations", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef run(*args: Route, **kw: Route):\n    args.go()\n    kw.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    for (const line of [5, 6]) {
      expect(callAt(line)?.resolution).toEqual({ kind: "unresolved" });
    }
  });

  it("resolves a self-attribute call assigned in another method of the same class", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\nclass Holder:\n    def __init__(self):\n        self.route = Route()\n    def run(self):\n        return self.route.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.go");
    expect(callAt(8)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("resolves a self-attribute call bound by an attribute annotation", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\nclass Holder:\n    def __init__(self):\n        self.route: Route\n    def run(self):\n        return self.route.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route.go");
    expect(callAt(8)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("reports ambiguous candidates for a self-attribute bound to different classes", async () => {
    const graph = await analyze([{ path: "local.py", content: "class A:\n    def go(self): pass\n\nclass B:\n    def go(self): pass\n\nclass Holder:\n    def set_a(self):\n        self.attr = A()\n    def set_b(self):\n        self.attr = B()\n    def run(self):\n        return self.attr.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const goA = graph.nodes.find((node) => node.qualifiedName === "local.A.go");
    const goB = graph.nodes.find((node) => node.qualifiedName === "local.B.go");
    expect(callAt(13)?.resolution).toEqual({ kind: "ambiguous", candidates: [goA?.id, goB?.id].sort() });
  });

  it("keeps a self-attribute assigned the same class in two methods resolved", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route4:\n    def go(self): pass\n\nclass Holder:\n    def __init__(self):\n        self.route = Route4()\n    def reset(self):\n        self.route = Route4()\n    def run(self):\n        return self.route.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Route4.go");
    expect(callAt(10)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("leaves attribute calls unresolved for a receiver not named self", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\nclass Holder:\n    def m(this):\n        this.attr = Route()\n        return this.attr.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(7)?.resolution).toEqual({ kind: "unresolved" });
  });

  it("leaves self-attribute calls unresolved in staticmethods and nested functions", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\nclass Holder:\n    @staticmethod\n    def m(self):\n        self.a = Route()\n        return self.a.go()\n    def outer(self):\n        def inner(self):\n            self.b = Route()\n            return self.b.go()\n        return inner\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    expect(callAt(8)?.resolution).toEqual({ kind: "unresolved" });
    expect(callAt(12)?.resolution).toEqual({ kind: "unresolved" });
  });

  it("does not merge a class-body variable with a same-named self attribute", async () => {
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\nclass Other:\n    def go(self): pass\n\nclass A:\n    x = Route()\n    def m(self):\n        self.x = Other()\n    def run(self):\n        return self.x.go()\n" }]);
    const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
    const method = graph.nodes.find((node) => node.qualifiedName === "local.Other.go");
    expect(callAt(12)?.resolution).toEqual({ kind: "resolved", target: method?.id });
  });

  it("carries an addressable module path and qualified name for a top-level function", async () => {
    const graph = await analyze([{ path: "pkg/sample.py", content: "def run():\n    pass\n" }]);
    const entity = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.run");
    expect(entity?.target).toEqual({ module: "pkg.sample", dottedName: "run", callableKind: "function" });
  });

  it("resolves a class entity's target to itself with callableKind class (introspection consumer applies __init__)", async () => {
    const graph = await analyze([{ path: "pkg/sample.py", content: "class Widget:\n    def __init__(self):\n        pass\n" }]);
    const entity = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.Widget");
    expect(entity?.target).toEqual({ module: "pkg.sample", dottedName: "Widget", callableKind: "class" });
  });

  it("qualifies an instance method's target relative to its containing class, not an unrelated same-named method", async () => {
    const graph = await analyze([{ path: "pkg/sample.py", content: "class A:\n    def go(self):\n        pass\n\nclass B:\n    def go(self):\n        pass\n" }]);
    const methodA = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.A.go");
    const methodB = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.B.go");
    expect(methodA?.target).toEqual({ module: "pkg.sample", dottedName: "A.go", callableKind: "function" });
    expect(methodB?.target).toEqual({ module: "pkg.sample", dottedName: "B.go", callableKind: "function" });
  });

  it("gives nested and module-level defs distinct dottedNames", async () => {
    const graph = await analyze([{ path: "pkg/sample.py", content: "def outer():\n    def inner():\n        pass\n    return inner\n" }]);
    const outer = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.outer");
    const inner = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.outer.inner");
    expect(outer?.target).toEqual({ module: "pkg.sample", dottedName: "outer", callableKind: "function" });
    expect(inner?.target).toEqual({ module: "pkg.sample", dottedName: "outer.inner", callableKind: "function" });
  });

  it("emits identifierRoles spans for self, parameter, className, functionName, importedName, and builtin", async () => {
    const content = "from pkg.other import Helper\n\n\nclass Widget:\n    def method(self, amount):\n        helper = Helper()\n        return len(amount) + self.total\n\n\ndef factory():\n    return Widget()\n";
    const graph = await analyze([{ path: "pkg/sample.py", content }]);
    const bytes = Buffer.from(content, "utf8");
    const method = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.Widget.method")!;
    const textOf = (entity: typeof method, span: { start: number; end: number }) =>
      bytes.subarray(entity.span.startByte + span.start, entity.span.startByte + span.end).toString("utf8");
    const rolesByText = (entity: typeof method) =>
      (entity.identifierRoles ?? []).map((role) => ({ role: role.role, text: textOf(entity, role) }));
    expect(rolesByText(method)).toEqual(expect.arrayContaining([
      { role: "self", text: "self" },
      { role: "parameter", text: "amount" },
      { role: "importedName", text: "Helper" },
      { role: "builtin", text: "len" },
    ]));
    // `helper` is a plain local variable with no determinable role: it must simply be absent,
    // never emitted with a null/error role.
    expect((method.identifierRoles ?? []).some((role) => textOf(method, role) === "helper")).toBe(false);

    const factory = graph.nodes.find((node) => node.qualifiedName === "pkg.sample.factory")!;
    expect(rolesByText(factory)).toEqual(expect.arrayContaining([{ role: "className", text: "Widget" }]));
  });

  it("times out and bounds child output deterministically", async () => {
    const roots: string[] = [];
    const makeRoot = async (program: string) => {
      const root = await mkdtemp(resolve(tmpdir(), "agent-change-map-"));
      roots.push(root);
      await mkdir(resolve(root, "python"));
      await writeFile(resolve(root, "python/analyzer.py"), program);
      return root;
    };
    try {
      const request = { type: "analyze" as const, snapshot, files: [{ path: "a.py", content: "" }] };
      await expect(analyzePython(request, await makeRoot("import time\ntime.sleep(10)\n"), { timeoutMs: 20 })).rejects.toThrow("Python analyzer timed out after 20ms");
      await expect(analyzePython(request, await makeRoot("print('x' * 10000)\n"), { maxOutputBytes: 100 })).rejects.toThrow("Python analyzer stdout exceeded 100 bytes");
      await expect(analyzePython(request, await makeRoot("import sys\nsys.stderr.write('x' * 10000)\n"), { maxOutputBytes: 100 })).rejects.toThrow("Python analyzer stderr exceeded 100 bytes");
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
});
