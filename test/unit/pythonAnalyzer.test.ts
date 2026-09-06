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

  it("derives the analyzer only from an absolute extension installation root", async () => {
    await expect(analyzePython({ type: "analyze", snapshot, files: [{ path: "a.py", content: "" }] }, ".")).rejects.toThrow(/absolute extension root/);
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
