import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChangeMapSession, mergeGraphsForDisplay } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import { computeContentHash, createSourceId } from "../../src/navigation/sourceProvider.js";
import { performGuardedWrite, WriteConfirmationDeclinedError } from "../../src/editing/writeGuard.js";
import { OVERSIZED_THRESHOLDS } from "../../src/webviewProtocol.js";
import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import type { AnalysisGraph, Entity } from "../../src/protocol.js";
import type { RunResult, SnippetSource } from "../../src/execution/dockerRunner.js";

const rightSnapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:right" };
const content = "def f():\n    return 2\n";
const span = { path: "m.py", startByte: 0, endByte: content.indexOf(":") + 1, startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 };

function makeStore(): SnapshotStore {
  const store = new SnapshotStore();
  store.store({ snapshot: rightSnapshot, files: [{ path: "m.py", content, provenance: "tracked" }] });
  return store;
}

function makeDeps(store: SnapshotStore) {
  const posted: HostToWebviewMessage[] = [];
  const openSource = vi.fn();
  const performWrite = vi.fn();
  const runSnippet = vi.fn();
  const session = new ChangeMapSession({
    repoRoot: "/repo",
    store,
    draftStore: new DraftStore(),
    post: (message) => posted.push(message),
    openSource,
    performWrite,
    runSnippet,
  });
  return { session, posted, openSource, performWrite, runSnippet };
}

function entity(id: string, qualifiedName: string): Entity {
  return { id, kind: "function", qualifiedName, span };
}

describe("mergeGraphsForDisplay", () => {
  it("prefers the right side's shape and includes left-only removed entities", () => {
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a"), entity("f:b", "b")], edges: [], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    const merged = mergeGraphsForDisplay(left, right);
    expect(merged.nodes.map((n) => n.qualifiedName).sort()).toEqual(["a", "b"]);
  });
});

describe("ChangeMapSession comparison loading", () => {
  it("sends the full graph immediately when it is not oversized", () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
    expect(posted.map((m) => m.type)).toEqual(["graphSummary", "graph"]);
  });

  it("withholds the full graph behind explicit oversized consent", async () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    const nodes = Array.from({ length: OVERSIZED_THRESHOLDS.nodes + 1 }, (_, i) => entity(`f:${i}`, `q${i}`));
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes, edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
    expect(posted.map((m) => m.type)).toEqual(["graphSummary"]);
    expect(posted[0]).toMatchObject({ type: "graphSummary", oversized: true });

    await session.handleIntent({ type: "confirmOversized", confirmed: true });
    expect(posted.map((m) => m.type)).toEqual(["graphSummary", "graph"]);
  });
});

describe("ChangeMapSession navigation", () => {
  it("uses the relationship's exact right-side span rather than an endpoint source", async () => {
    const store = makeStore();
    const { session, posted, openSource } = makeDeps(store);
    const edgeSpan = { ...span, startByte: 4, endByte: 8, startColumn: 4, endColumn: 8 };
    const right: AnalysisGraph = {
      snapshot: rightSnapshot,
      nodes: [entity("f:a", "a")],
      edges: [{ kind: "call", source: "f:a", resolution: { kind: "resolved", target: "f:a" }, span: edgeSpan }],
      diagnostics: [],
    };
    session.loadComparison(undefined, right, []);
    const graphMessage = posted.find((message): message is Extract<HostToWebviewMessage, { type: "graph" }> => message.type === "graph");
    const relationshipSource = graphMessage?.edgeSources[0];
    expect(relationshipSource).toMatchObject({ side: "right", sourceId: { startByte: 4, endByte: 8 } });

    await session.handleIntent({ type: "navigate", sourceId: relationshipSource!.sourceId, side: relationshipSource!.side });
    expect(openSource).toHaveBeenCalledWith(relationshipSource!.sourceId, "right", content.slice(4, 8));
  });

  it("marks every extant line as an added op when a source has no comparison counterpart", async () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
    await session.handleIntent({ type: "inspectSources", nodeId: "f:a" });
    const message = posted.at(-1) as Extract<HostToWebviewMessage, { type: "sourcePair" }>;
    expect(message).toMatchObject({
      type: "sourcePair",
      sources: [expect.objectContaining({ side: "right" })],
      ops: [{ op: "added", rightLine: 1, text: "def f():" }],
    });
    expect(message.sources[0]).not.toHaveProperty("affectedLines");
  });

  it("navigates to an exact, resolvable source and opens it", async () => {
    const store = makeStore();
    const { session, posted, openSource } = makeDeps(store);
    const sourceId = createSourceId(rightSnapshot, "m.py", content, 0, content.indexOf("\n"));
    await session.handleIntent({ type: "navigate", sourceId, side: "right" });
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ type: "navigateResult", ok: true, sourceId, content: content.slice(0, content.indexOf("\n")) }]);
  });

  it("refuses to navigate to a stale source and never opens an approximate location", async () => {
    const store = makeStore();
    const { session, posted, openSource } = makeDeps(store);
    const sourceId = createSourceId(rightSnapshot, "m.py", content, 0, content.indexOf("\n"));
    const staleSourceId = { ...sourceId, contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    await session.handleIntent({ type: "navigate", sourceId: staleSourceId, side: "right" });
    expect(openSource).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "navigateResult", ok: false, sourceId: staleSourceId, reason: expect.stringContaining("changed") }]);
  });
});

describe("ChangeMapSession direct write", () => {
  it("requires an explicit confirmDirectWrite before the write proceeds, then reports the result", async () => {
    const store = makeStore();
    const { session, posted, performWrite } = makeDeps(store);
    performWrite.mockImplementation(async (request) => {
      const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: "a", nextContent: "b", isDestructive: true });
      if (!confirmed) throw new WriteConfirmationDeclinedError("declined");
      return { path: "/repo/m.py", previousContent: "a", newContent: "b", backupPath: "/repo/m.py.bak-1" };
    });

    const pending = session.handleIntent({
      type: "requestDirectWrite",
      requestId: "r1",
      repoRoot: "/repo",
      targetPath: "m.py",
      baseHash: "sha256:x",
      replacement: "b",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted.some((m) => m.type === "directWritePreview")).toBe(true);

    await session.handleIntent({ type: "confirmDirectWrite", requestId: "r1", confirmed: true });
    await pending;
    expect(posted.at(-1)).toEqual({ type: "directWriteResult", requestId: "r1", ok: true, path: "/repo/m.py" });
  });

  it("reports a declined confirmation instead of writing", async () => {
    const store = makeStore();
    const { session, posted, performWrite } = makeDeps(store);
    performWrite.mockImplementation(async (request) => {
      const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: "a", nextContent: "b", isDestructive: true });
      if (!confirmed) throw new WriteConfirmationDeclinedError("declined");
      throw new Error("should not reach write");
    });

    const pending = session.handleIntent({
      type: "requestDirectWrite",
      requestId: "r2",
      repoRoot: "/repo",
      targetPath: "m.py",
      baseHash: "sha256:x",
      replacement: "b",
    });
    await Promise.resolve();
    await Promise.resolve();
    await session.handleIntent({ type: "confirmDirectWrite", requestId: "r2", confirmed: false });
    await pending;
    expect(posted.at(-1)).toEqual({ type: "directWriteResult", requestId: "r2", ok: false, reason: "declined" });
  });
});

describe("ChangeMapSession execution", () => {
  it("requires an explicit confirmRun before invoking Docker, then streams lifecycle events and the final result", async () => {
    const store = makeStore();
    const { session, posted, runSnippet } = makeDeps(store);
    const source: SnippetSource = { variant: "current", path: "m.py", content: "print(1)" };
    session.setActiveSources({ current: source });
    const result: RunResult = { variant: "current", kind: "success", exitCode: 0, stdout: "1\n", stderr: "" };
    runSnippet.mockResolvedValue(result);

    await session.handleIntent({ type: "requestRun", requestId: "run1", variants: ["current"] });
    expect(posted.map((m) => m.type)).toEqual(["runConfirmationRequired"]);
    expect(runSnippet).not.toHaveBeenCalled();

    await session.handleIntent({ type: "confirmRun", requestId: "run1", confirmed: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    expect(runSnippet).toHaveBeenCalledTimes(1);
    const eventTypes = posted.filter((m) => m.type === "runEvent").map((m) => (m as { channel: string }).channel);
    expect(eventTypes).toEqual(["status", "stdout", "status"]);
    expect(posted.at(-1)).toEqual({ type: "runResult", requestId: "run1", results: [result] });
  });

  it("never invokes Docker when the run is declined", async () => {
    const store = makeStore();
    const { session, posted, runSnippet } = makeDeps(store);
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "print(1)" } });

    await session.handleIntent({ type: "requestRun", requestId: "run2", variants: ["current"] });
    await session.handleIntent({ type: "confirmRun", requestId: "run2", confirmed: false });
    expect(runSnippet).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "error", message: "Run declined for request run2" });
  });

  it("aborts the active run's signal on an explicit cancel intent", async () => {
    const store = makeStore();
    const { session, runSnippet } = makeDeps(store);
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "print(1)" } });
    let capturedSignal: AbortSignal | undefined;
    runSnippet.mockImplementation((_source: SnippetSource, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise(() => {});
    });

    await session.handleIntent({ type: "requestRun", requestId: "run3", variants: ["current"] });
    await session.handleIntent({ type: "confirmRun", requestId: "run3", confirmed: true });
    await Promise.resolve();
    await session.handleIntent({ type: "cancelRun", requestId: "run3" });
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("ChangeMapSession malformed input", () => {
  it("reports rejection instead of throwing on a malformed message", async () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    await session.handleIntent({ type: "navigate" });
    expect(posted[0]?.type).toBe("error");
  });
});


describe("ChangeMapSession trusted repository boundary", () => {
  it.each(["filesystem-root", "external-directory"])("refuses an external target with a forged %s without mutation", async (forgedRoot) => {
    const temp = await mkdtemp(join(tmpdir(), "change-map-boundary-"));
    try {
      const repoRoot = join(temp, "repo");
      await mkdir(repoRoot);
      const targetPath = join(temp, "external.py");
      await writeFile(targetPath, content);
      const posted: HostToWebviewMessage[] = [];
      const session = new ChangeMapSession({
        repoRoot,
        store: makeStore(),
        draftStore: new DraftStore(),
        openSource: vi.fn(),
        performWrite: performGuardedWrite,
        runSnippet: vi.fn(),
        post: (message) => {
          posted.push(message);
          // Even a compromised webview confirming every preview cannot widen authority.
          if (message.type === "directWritePreview") {
            queueMicrotask(() => { void session.handleIntent({ type: "confirmDirectWrite", requestId: message.requestId, confirmed: true }); });
          }
        },
      });
      await session.handleIntent({ type: "requestDirectWrite", requestId: "forged", repoRoot: forgedRoot === "filesystem-root" ? parse(temp).root : temp, targetPath, baseHash: computeContentHash(content), replacement: "attacker content" });
      expect(await readFile(targetPath, "utf8")).toBe(content);
      expect((await readdir(temp)).sort()).toEqual(["external.py", "repo"]);
      expect(posted).toEqual([{ type: "directWriteResult", requestId: "forged", ok: false, reason: expect.stringContaining("invalid") }]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("writes a legitimate relative target only after confirmation using the host repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "change-map-legitimate-"));
    try {
      const targetPath = join(repoRoot, "m.py");
      await writeFile(targetPath, content);
      const posted: HostToWebviewMessage[] = [];
      const session = new ChangeMapSession({
        repoRoot,
        store: makeStore(),
        draftStore: new DraftStore(),
        openSource: vi.fn(),
        performWrite: performGuardedWrite,
        runSnippet: vi.fn(),
        post: (message) => { posted.push(message); },
      });
      const pending = session.handleIntent({ type: "requestDirectWrite", requestId: "legitimate", repoRoot: parse(repoRoot).root, targetPath: "m.py", baseHash: computeContentHash(content), replacement: "updated" });
      await vi.waitFor(() => expect(posted.some((message) => message.type === "directWritePreview")).toBe(true));
      expect(await readFile(targetPath, "utf8")).toBe(content);
      await session.handleIntent({ type: "confirmDirectWrite", requestId: "legitimate", confirmed: true });
      await pending;
      expect(await readFile(targetPath, "utf8")).toBe("updated");
      expect(posted.at(-1)).toEqual({ type: "directWriteResult", requestId: "legitimate", ok: true, path: targetPath });
      const backups = (await readdir(repoRoot)).filter((name) => name.startsWith("m.py.bak-"));
      expect(backups).toHaveLength(1);
      expect(await readFile(join(repoRoot, backups[0]), "utf8")).toBe(content);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("audit regressions", () => {
  it("indexes identical snapshots and unchanged nodes", () => {
    const { session, posted } = makeDeps(makeStore());
    const graph: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    session.loadComparison(graph, graph, []);
    expect(posted.at(-1)).toMatchObject({ type: "graph", sourceIndex: { "f:a": { left: { posixPath: "m.py" }, right: { posixPath: "m.py" } } } });
  });
  it("freezes all sources before confirmation and streams before completion", async () => {
    const { session, posted, runSnippet } = makeDeps(makeStore());
    let release!: () => void;
    runSnippet.mockImplementation(async (source, options) => {
      options?.onOutput?.("stdout", "early");
      await new Promise<void>((resolve) => { release = resolve; });
      return { variant: source.variant, kind: "success", exitCode: 0, stdout: "early", stderr: "" };
    });
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "approved" } });
    await session.handleIntent({ type: "requestRun", requestId: "frozen", variants: ["current"] });
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "substituted" } });
    await session.handleIntent({ type: "confirmRun", requestId: "frozen", confirmed: true });
    await vi.waitFor(() => expect(runSnippet).toHaveBeenCalled());
    expect(runSnippet.mock.calls[0][0].content).toBe("approved");
    expect(posted.some(m => m.type === "runEvent" && m.data === "early")).toBe(true);
    expect(posted.some(m => m.type === "runResult")).toBe(false);
    release();
    await vi.waitFor(() => expect(posted.some(m => m.type === "runResult")).toBe(true));
    expect(posted.filter(m => m.type === "runEvent" && m.data === "early")).toHaveLength(1);
  });
  it("refreshes first and subsequent draft runs without renavigation", async () => {
    const { session, runSnippet } = makeDeps(makeStore());
    const graph: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    session.loadComparison(undefined, graph, []);
    const sourceId = createSourceId(rightSnapshot, "m.py", content, 0, span.endByte);
    await session.handleIntent({ type: "navigate", sourceId, side: "right" });
    runSnippet.mockImplementation(async source => ({ variant: source.variant, kind: "success", exitCode: 0, stdout: "", stderr: "" }));
    for (const replacement of ["first", "second"]) {
      await session.handleIntent({ type: "saveDraft", sourceId, content: replacement });
      await session.handleIntent({ type: "requestRun", requestId: replacement, variants: ["draft"] });
      await session.handleIntent({ type: "confirmRun", requestId: replacement, confirmed: true });
      await vi.waitFor(() => expect(runSnippet).toHaveBeenCalledWith(expect.objectContaining({ content: replacement }), expect.anything()));
    }
  });
  it("offers bounded section/filter requests before full rendering", async () => {
    const { session, posted } = makeDeps(makeStore());
    const graph: AnalysisGraph = { snapshot: rightSnapshot, nodes: Array.from({length: 301}, (_,i) => entity(`f:${i}`, `q${i}`)), edges: [], diagnostics: [] };
    session.loadComparison(undefined, graph, []);
    expect(posted[0]).toMatchObject({ sections: expect.arrayContaining([expect.objectContaining({ id: "f:0" })]) });
    await session.handleIntent({ type: "requestGraphView", scopeIds: ["f:0"], relationshipKinds: [], changeStatuses: [] });
    expect(posted.at(-1)).toMatchObject({ type: "graph", graph: { nodes: [expect.objectContaining({ id: "f:0" })] } });
  });
});

it.each(["DockerRunError", "DockerCleanupError"])("reports %s terminally without pretending cleanup succeeded", async name => {
  const { DockerRunError, DockerCleanupError } = await import("../../src/execution/dockerRunner.js");
  const { session, posted, runSnippet } = makeDeps(makeStore());
  session.setActiveSources({ current: { variant: "current", path: "m.py", content } });
  runSnippet.mockRejectedValue(name === "DockerRunError" ? new DockerRunError("unavailable") : new DockerCleanupError("unconfirmed"));
  await session.handleIntent({ type: "requestRun", requestId: "failure", variants: ["current"] });
  await session.handleIntent({ type: "confirmRun", requestId: "failure", confirmed: true });
  await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "runFailed", requestId: "failure", reason: expect.stringContaining(name) }));
  expect(posted.some(m => m.type === "runResult")).toBe(false);
});

it("preserves other file bytes when applying a snippet through the real writer", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "snippet-write-"));
  try {
    const full = "# prefix π\nprint('old')\n# suffix\n";
    const startByte = Buffer.byteLength("# prefix π\n");
    const endByte = startByte + Buffer.byteLength("print('old')\n");
    const store = new SnapshotStore(); store.store({ snapshot: rightSnapshot, files: [{ path: "m.py", content: full, provenance: "tracked" }] });
    await writeFile(join(repoRoot, "m.py"), full);
    const posted: HostToWebviewMessage[] = [];
    const session = new ChangeMapSession({ repoRoot, store, draftStore: new DraftStore(), openSource: vi.fn(), runSnippet: vi.fn(), performWrite: performGuardedWrite, post: m => posted.push(m) });
    const sourceId = createSourceId(rightSnapshot, "m.py", full, startByte, endByte);
    const pending = session.handleIntent({ type: "requestSnippetWrite", requestId: "snippet", sourceId, content: "print('new')\n" });
    await vi.waitFor(() => expect(posted.some(m => m.type === "directWritePreview")).toBe(true));
    expect(await readFile(join(repoRoot, "m.py"), "utf8")).toBe(full);
    await session.handleIntent({ type: "confirmDirectWrite", requestId: "snippet", confirmed: true });
    await pending;
    expect(await readFile(join(repoRoot, "m.py"), "utf8")).toBe("# prefix π\nprint('new')\n# suffix\n");
    await session.handleIntent({ type: "requestSnippetWrite", requestId: "stale", sourceId, content: "wrong" });
    expect(posted.at(-1)).toMatchObject({ type: "directWriteResult", ok: false, reason: expect.stringContaining("changed") });
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

it("freezes later variants even when selection changes while an earlier variant runs", async () => {
  const { session, posted, runSnippet } = makeDeps(makeStore());
  let release!: () => void;
  runSnippet.mockImplementation(async source => {
    if (source.variant === "original") await new Promise<void>(resolve => { release = resolve; });
    return { variant: source.variant, kind: "success", exitCode: 0, stdout: "", stderr: "" };
  });
  session.setActiveSources({ original: { variant: "original", path: "m.py", content: "old" }, current: { variant: "current", path: "m.py", content: "approved" } });
  await session.handleIntent({ type: "requestRun", requestId: "multi", variants: ["original", "current"] });
  await session.handleIntent({ type: "confirmRun", requestId: "multi", confirmed: true });
  session.setActiveSources({ current: { variant: "current", path: "m.py", content: "replacement" } });
  release();
  await vi.waitFor(() => expect(posted.at(-1)?.type).toBe("runResult"));
  expect(runSnippet.mock.calls[1][0].content).toBe("approved");
});
