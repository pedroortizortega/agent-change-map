import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChangeMapSession, mergeGraphsForDisplay, buildEdgeVintages } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import { computeContentHash, createSourceId } from "../../src/navigation/sourceProvider.js";
import { performGuardedWrite, WriteConfirmationDeclinedError } from "../../src/editing/writeGuard.js";
import { OVERSIZED_THRESHOLDS } from "../../src/webviewProtocol.js";
import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import type { AnalysisGraph, Edge, Entity } from "../../src/protocol.js";
import type { RunResult, SnippetSource } from "../../src/execution/dockerRunner.js";

const rightSnapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:right" };
const content = "def f():\n    return 2\n";
const span = { path: "m.py", startByte: 0, endByte: content.indexOf(":") + 1, startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 };

function makeStore(): SnapshotStore {
  const store = new SnapshotStore();
  store.store({ snapshot: rightSnapshot, files: [{ path: "m.py", content, provenance: "tracked" }] });
  return store;
}

function makeDeps(
  store: SnapshotStore,
  overrides: {
    requestRefresh?: () => Promise<void>;
    onIdle?: () => void;
    runIntrospection?: ReturnType<typeof vi.fn>;
    runCall?: ReturnType<typeof vi.fn>;
    draftStore?: DraftStore;
    resolveTheme?: ReturnType<typeof vi.fn>;
    subscribeThemeChange?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const posted: HostToWebviewMessage[] = [];
  const openSource = vi.fn();
  const performWrite = vi.fn();
  const runSnippet = vi.fn();
  const { draftStore, ...rest } = overrides;
  const session = new ChangeMapSession({
    repoRoot: "/repo",
    store,
    draftStore: draftStore ?? new DraftStore(),
    post: (message) => posted.push(message),
    openSource,
    performWrite,
    runSnippet,
    ...rest,
  });
  return { session, posted, openSource, performWrite, runSnippet };
}

function entity(id: string, qualifiedName: string): Entity {
  return { id, kind: "function", qualifiedName, span };
}

function targetEntity(id: string, qualifiedName: string, dottedName = qualifiedName): Entity {
  return { id, kind: "function", qualifiedName, span, target: { module: "m", dottedName, callableKind: "function" } };
}

function classTargetEntity(id: string, qualifiedName: string, dottedName = qualifiedName): Entity {
  return { id, kind: "class", qualifiedName, span, target: { module: "m", dottedName, callableKind: "class" } };
}

describe("mergeGraphsForDisplay", () => {
  it("prefers the right side's shape and includes left-only removed entities", () => {
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a"), entity("f:b", "b")], edges: [], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [entity("f:a", "a")], edges: [], diagnostics: [] };
    const merged = mergeGraphsForDisplay(left, right);
    expect(merged.nodes.map((n) => n.qualifiedName).sort()).toEqual(["a", "b"]);
  });
});

describe("buildEdgeVintages", () => {
  function edgeAt(startByte: number, endByte: number): Edge {
    return { kind: "call", source: "f:a", resolution: { kind: "resolved", target: "f:b" }, span: { ...span, startByte, endByte } };
  }

  it("marks the byte-shifted left-only and right-only edges of a ghost-duplicate pair as removed/current", () => {
    const leftOnly = edgeAt(0, 5);
    const rightOnly = edgeAt(2, 7);
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [leftOnly], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [rightOnly], diagnostics: [] };
    const merged: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [leftOnly, rightOnly], diagnostics: [] };
    expect(buildEdgeVintages(left, right, merged, [])).toEqual(["removed", "current"]);
  });

  it("marks an edge present on both sides as current", () => {
    const shared = edgeAt(0, 5);
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [shared], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [shared], diagnostics: [] };
    const merged: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [shared], diagnostics: [] };
    expect(buildEdgeVintages(left, right, merged, [])).toEqual(["current"]);
  });

  it("marks an edge present only on the left (original) side as removed", () => {
    const onlyLeft = edgeAt(0, 5);
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [onlyLeft], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [], diagnostics: [] };
    const merged: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [onlyLeft], diagnostics: [] };
    expect(buildEdgeVintages(left, right, merged, [])).toEqual(["removed"]);
  });

  it("marks an edge whose span.path is untracked as current even with no right-side match", () => {
    const untracked = edgeAt(0, 5);
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [untracked], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [], diagnostics: [] };
    const merged: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [untracked], diagnostics: [] };
    expect(buildEdgeVintages(left, right, merged, [untracked.span.path])).toEqual(["current"]);
  });

  it("is correct even when the SnapshotStore has no stored content for the edge's file", () => {
    const store = new SnapshotStore();
    expect(store.getFileContent(rightSnapshot, "m.py")).toBeUndefined();
    const onlyLeft = edgeAt(0, 5);
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [onlyLeft], diagnostics: [] };
    const merged: AnalysisGraph = { snapshot: rightSnapshot, nodes: [], edges: [onlyLeft], diagnostics: [] };
    expect(buildEdgeVintages(left, undefined, merged, [])).toEqual(["removed"]);
  });
});

describe("ChangeMapSession edge vintage default and filtering", () => {
  function ghostGraphs(): { left: AnalysisGraph; right: AnalysisGraph } {
    const leftOnly: Edge = { kind: "call", source: "f:a", resolution: { kind: "resolved", target: "f:b" }, span: { ...span, startByte: 0, endByte: 5 } };
    const rightOnly: Edge = { kind: "call", source: "f:a", resolution: { kind: "resolved", target: "f:b" }, span: { ...span, startByte: 2, endByte: 7 } };
    const nodes = [entity("f:a", "a"), entity("f:b", "b")];
    const left: AnalysisGraph = { snapshot: rightSnapshot, nodes, edges: [leftOnly], diagnostics: [] };
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes, edges: [rightOnly], diagnostics: [] };
    return { left, right };
  }

  it("posts edgeOrigins index-aligned with graph.edges", () => {
    const { session, posted } = makeDeps(makeStore());
    const { left, right } = ghostGraphs();
    session.loadComparison(left, right, []);
    const graphMessage = posted.find((m) => m.type === "graph");
    expect(graphMessage).toMatchObject({ type: "graph" });
    if (graphMessage?.type !== "graph") throw new Error("expected graph message");
    expect(graphMessage.edgeOrigins.length).toBe(graphMessage.graph.edges.length);
  });

  it("omits the left-only ghost edge by default before the user touches the toolbar", () => {
    const { session, posted } = makeDeps(makeStore());
    const { left, right } = ghostGraphs();
    session.loadComparison(left, right, []);
    const graphMessage = posted.find((m) => m.type === "graph");
    if (graphMessage?.type !== "graph") throw new Error("expected graph message");
    expect(graphMessage.graph.edges).toHaveLength(1);
    expect(graphMessage.graph.edges[0].span.startByte).toBe(2);
  });

  it("restores the left-only ghost edge when vintages includes both", async () => {
    const { session, posted } = makeDeps(makeStore());
    const { left, right } = ghostGraphs();
    session.loadComparison(left, right, []);
    await session.handleIntent({ type: "requestGraphView", scopeIds: [], relationshipKinds: [], changeStatuses: [], vintages: ["current", "removed"] });
    const graphMessage = posted.filter((m) => m.type === "graph").at(-1);
    if (graphMessage?.type !== "graph") throw new Error("expected graph message");
    expect(graphMessage.graph.edges).toHaveLength(2);
  });

  it("hides the current/worktree edge when vintages is [\"removed\"]", async () => {
    const { session, posted } = makeDeps(makeStore());
    const { left, right } = ghostGraphs();
    session.loadComparison(left, right, []);
    await session.handleIntent({ type: "requestGraphView", scopeIds: [], relationshipKinds: [], changeStatuses: [], vintages: ["removed"] });
    const graphMessage = posted.filter((m) => m.type === "graph").at(-1);
    if (graphMessage?.type !== "graph") throw new Error("expected graph message");
    expect(graphMessage.graph.edges).toHaveLength(1);
    expect(graphMessage.graph.edges[0].span.startByte).toBe(0);
  });

  it("hides every edge when both toolbar checkboxes are unchecked (vintages: [])", async () => {
    const { session, posted } = makeDeps(makeStore());
    const { left, right } = ghostGraphs();
    session.loadComparison(left, right, []);
    await session.handleIntent({ type: "requestGraphView", scopeIds: [], relationshipKinds: [], changeStatuses: [], vintages: [] });
    const graphMessage = posted.filter((m) => m.type === "graph").at(-1);
    if (graphMessage?.type !== "graph") throw new Error("expected graph message");
    expect(graphMessage.graph.edges).toHaveLength(0);
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

  it("excludes an ancestor self-reference edge from graphSummary.edgeCount", () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    const moduleNode: Entity = { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", span };
    const classNode: Entity = { id: "class:pkg.a.C", kind: "class", qualifiedName: "pkg.a.C", containerId: "module:pkg.a", span };
    const right: AnalysisGraph = {
      snapshot: rightSnapshot,
      nodes: [moduleNode, classNode],
      edges: [
        // Ancestor self-reference: module is the direct containerId parent of class.
        { kind: "call", source: "module:pkg.a", resolution: { kind: "resolved", target: "class:pkg.a.C" }, span },
      ],
      diagnostics: [],
    };
    session.loadComparison(undefined, right, []);
    expect(posted[0]).toMatchObject({ type: "graphSummary", edgeCount: 0 });
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
      nodes: [entity("f:a", "a"), entity("f:b", "b")],
      // Distinct, unrelated source/target (not a self-reference) so this fixture is
      // unaffected by ancestor self-reference suppression.
      edges: [{ kind: "call", source: "f:a", resolution: { kind: "resolved", target: "f:b" }, span: edgeSpan }],
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

describe("ChangeMapSession signature introspection cache", () => {
  function loadTargetGraph(session: ChangeMapSession, id = "function:f", dottedName = "f"): void {
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [targetEntity(id, "f", dottedName)], edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
  }

  function sourceIdFor(): import("../../src/protocol.js").SourceId {
    return createSourceId(rightSnapshot, "m.py", content, 0, content.length);
  }

  it("reuses the cached signature on a second request for the same unchanged target (cache hit)", async () => {
    const store = makeStore();
    const runIntrospection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters: [{ name: "x", kind: "POSITIONAL_OR_KEYWORD", required: true }] });
    const { session, posted } = makeDeps(store, { runIntrospection });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestSignature", requestId: "s1", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ type: "signatureResult", requestId: "s1", targetId: "function:f", cached: false });

    await session.handleIntent({ type: "requestSignature", requestId: "s2", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ type: "signatureResult", requestId: "s2", targetId: "function:f", cached: true, parameters: [{ name: "x" }] });
  });

  it("triggers a fresh introspection round-trip when the snippet content for that target changes (cache miss)", async () => {
    const store = makeStore();
    const runIntrospection = vi
      .fn()
      .mockResolvedValueOnce({ kind: "signatureResult", parameters: [{ name: "x", kind: "POSITIONAL_OR_KEYWORD", required: true }] })
      .mockResolvedValueOnce({ kind: "signatureResult", parameters: [{ name: "y", kind: "POSITIONAL_OR_KEYWORD", required: true }] });
    const draftStore = new DraftStore();
    const { session, posted } = makeDeps(store, { runIntrospection, draftStore });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestSignature", requestId: "s1", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(1);

    draftStore.save(store, sourceId, "def f(y):\n    return y\n");
    await session.handleIntent({ type: "requestSignature", requestId: "s2", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(2);
    expect(posted.at(-1)).toMatchObject({ type: "signatureResult", requestId: "s2", cached: false, parameters: [{ name: "y" }] });
  });

  it("evicts the least-recently-used cache entry once a 33rd distinct key is inserted", async () => {
    const store = makeStore();
    const runIntrospection = vi.fn().mockImplementation(async (source: SnippetSource) => ({ kind: "signatureResult", parameters: [{ name: source.content, kind: "POSITIONAL_OR_KEYWORD", required: true }] }));
    const draftStore = new DraftStore();
    const { session, posted } = makeDeps(store, { runIntrospection, draftStore });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    for (let i = 0; i < 32; i += 1) {
      draftStore.save(store, sourceId, `content-${i}\n`);
      await session.handleIntent({ type: "requestSignature", requestId: `fill-${i}`, sourceId, targetId: "function:f" });
    }
    expect(runIntrospection).toHaveBeenCalledTimes(32);

    // Re-request the oldest (content-0) key: still cached (32 entries fit exactly).
    draftStore.save(store, sourceId, "content-0\n");
    await session.handleIntent({ type: "requestSignature", requestId: "recheck-0", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(32);
    expect(posted.at(-1)).toMatchObject({ cached: true });

    // Insert a 33rd distinct key: evicts content-1 (the least-recently-used, since content-0
    // was just refreshed to most-recent above).
    draftStore.save(store, sourceId, "content-32\n");
    await session.handleIntent({ type: "requestSignature", requestId: "fill-32", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(33);

    draftStore.save(store, sourceId, "content-1\n");
    await session.handleIntent({ type: "requestSignature", requestId: "recheck-1", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(34);
    expect(posted.at(-1)).toMatchObject({ cached: false });

    draftStore.save(store, sourceId, "content-0\n");
    await session.handleIntent({ type: "requestSignature", requestId: "recheck-0-again", sourceId, targetId: "function:f" });
    expect(runIntrospection).toHaveBeenCalledTimes(34);
    expect(posted.at(-1)).toMatchObject({ cached: true });
  });

  it("replies signatureUnavailable and never spawns or caches when Docker/introspection is unavailable", async () => {
    const store = makeStore();
    const { session, posted } = makeDeps(store);
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestSignature", requestId: "s1", sourceId, targetId: "function:f" });
    expect(posted.at(-1)).toMatchObject({ type: "signatureUnavailable", requestId: "s1", targetId: "function:f" });
    expect((posted.at(-1) as { reason: string }).reason).toEqual(expect.any(String));
  });

  it("passes the whole file, not just the method's own span, to the introspection driver (nested-method regression)", async () => {
    // Every other test in this describe block builds its sourceId over the entity's FULL
    // content (span = [0, content.length]), which happens to equal the whole file - exactly
    // why this bug shipped unnoticed through the whole slice-2/3 test suite. Here the entity's
    // own span is only its method body, nested inside a class the entity's slice alone omits.
    const nestedContent = "class Outer:\n    def method(self):\n        return 1\n";
    const store = new SnapshotStore();
    store.store({ snapshot: rightSnapshot, files: [{ path: "m.py", content: nestedContent, provenance: "tracked" }] });
    const methodStart = nestedContent.indexOf("    def method");
    const nestedSourceId = createSourceId(rightSnapshot, "m.py", nestedContent, methodStart, nestedContent.length);
    const runIntrospection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters: [] });
    const { session, posted } = makeDeps(store, { runIntrospection });
    session.loadComparison(undefined, { snapshot: rightSnapshot, nodes: [targetEntity("method:Outer.method", "Outer.method", "Outer.method")], edges: [], diagnostics: [] }, []);

    await session.handleIntent({ type: "requestSignature", requestId: "s1", sourceId: nestedSourceId, targetId: "method:Outer.method" });

    expect(runIntrospection).toHaveBeenCalledTimes(1);
    const driverText = (runIntrospection.mock.calls[0]![0] as SnippetSource).content;
    const base64Match = /_SRC = base64\.b64decode\("([^"]+)"\)/.exec(driverText);
    expect(base64Match).not.toBeNull();
    expect(Buffer.from(base64Match![1]!, "base64").toString("utf8")).toContain("class Outer");
    expect(posted.at(-1)).toMatchObject({ type: "signatureResult", requestId: "s1" });
  });
});

describe("ChangeMapSession call function", () => {
  function loadTargetGraph(session: ChangeMapSession, id = "function:f", dottedName = "f"): void {
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [targetEntity(id, "f", dottedName)], edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
  }

  function loadClassTargetGraph(session: ChangeMapSession, id = "class:Widget", dottedName = "Widget"): void {
    const right: AnalysisGraph = { snapshot: rightSnapshot, nodes: [classTargetEntity(id, "Widget", dottedName)], edges: [], diagnostics: [] };
    session.loadComparison(undefined, right, []);
  }

  function sourceIdFor(): import("../../src/protocol.js").SourceId {
    return createSourceId(rightSnapshot, "m.py", content, 0, content.length);
  }

  it("requires an explicit confirmCall before invoking Docker, independent of any confirmRun state", async () => {
    const store = makeStore();
    const runCall = vi.fn();
    const { session, posted } = makeDeps(store, { runCall });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();
    posted.length = 0;

    await session.handleIntent({ type: "requestCall", requestId: "c1", sourceId, targetId: "function:f", args: { x: 1 } });

    expect(posted.map((m) => m.type)).toEqual(["callConfirmationRequired"]);
    expect(runCall).not.toHaveBeenCalled();
  });

  it("spawns no container and executes no code when the call confirmation is declined", async () => {
    const store = makeStore();
    const runCall = vi.fn();
    const { session, posted } = makeDeps(store, { runCall });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestCall", requestId: "c2", sourceId, targetId: "function:f", args: { x: 1 } });
    await session.handleIntent({ type: "confirmCall", requestId: "c2", confirmed: false });

    expect(runCall).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "error", message: "Call declined for request c2" });
  });

  it("builds the call driver with the decoded args and posts callResult once confirmed", async () => {
    const store = makeStore();
    const result: RunResult = { variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" };
    const runCall = vi.fn().mockResolvedValue({ result, returnRepr: "3" });
    const { session, posted } = makeDeps(store, { runCall });
    loadTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestCall", requestId: "c3", sourceId, targetId: "function:f", args: { x: 2 } });
    await session.handleIntent({ type: "confirmCall", requestId: "c3", confirmed: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(runCall).toHaveBeenCalledTimes(1);
    const [source] = runCall.mock.calls[0]!;
    expect((source as SnippetSource).content).toContain("_t(**_ARGS)");
    expect(posted.at(-1)).toEqual({ type: "callResult", requestId: "c3", result, returnRepr: "3" });
  });

  it("constructs a class instance via the __init__ driver path end-to-end through the host", async () => {
    const store = makeStore();
    const result: RunResult = { variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" };
    const runCall = vi.fn().mockResolvedValue({ result, returnRepr: "<Widget object>" });
    const { session, posted } = makeDeps(store, { runCall });
    loadClassTargetGraph(session);
    const sourceId = sourceIdFor();

    await session.handleIntent({ type: "requestCall", requestId: "c4", sourceId, targetId: "class:Widget", args: { name: "a" } });
    expect(posted.at(-1)).toMatchObject({ type: "callConfirmationRequired", dottedName: "Widget" });

    await session.handleIntent({ type: "confirmCall", requestId: "c4", confirmed: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(runCall).toHaveBeenCalledTimes(1);
    const [source] = runCall.mock.calls[0]!;
    expect((source as SnippetSource).content).toContain("_t(**_ARGS)");
    expect(posted.at(-1)).toEqual({ type: "callResult", requestId: "c4", result, returnRepr: "<Widget object>" });
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
    await session.handleIntent({ type: "requestGraphView", scopeIds: ["f:0"], relationshipKinds: [], changeStatuses: [], vintages: [] });
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

describe("ChangeMapSession refresh", () => {
  it("refuses requestRefresh with a not-ok result when deps.requestRefresh is absent", async () => {
    const { session, posted } = makeDeps(makeStore());
    await session.handleIntent({ type: "requestRefresh", requestId: "ref1" });
    expect(posted).toEqual([{ type: "refreshResult", requestId: "ref1", ok: false, reason: expect.any(String) }]);
  });

  it("invokes deps.requestRefresh and reports success when idle", async () => {
    const requestRefresh = vi.fn().mockResolvedValue(undefined);
    const { session, posted } = makeDeps(makeStore(), { requestRefresh });
    await session.handleIntent({ type: "requestRefresh", requestId: "ref2" });
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ type: "refreshResult", requestId: "ref2", ok: true }]);
  });

  it("isBusy() is true with a pending write confirmation, a pending run confirmation, or an active run; false otherwise", async () => {
    const { session, performWrite } = makeDeps(makeStore());
    expect(session.isBusy()).toBe(false);
    performWrite.mockImplementation(async request => {
      const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: "a", nextContent: "b", isDestructive: true });
      if (!confirmed) throw new WriteConfirmationDeclinedError("declined");
      return { path: "/repo/m.py", previousContent: "a", newContent: "b", backupPath: "/repo/m.py.bak-1" };
    });
    const writePending = session.handleIntent({ type: "requestDirectWrite", requestId: "w1", repoRoot: "/repo", targetPath: "m.py", baseHash: "sha256:x", replacement: "b" });
    await vi.waitFor(() => expect(session.isBusy()).toBe(true));
    await session.handleIntent({ type: "confirmDirectWrite", requestId: "w1", confirmed: false });
    await writePending;
    expect(session.isBusy()).toBe(false);
  });

  it("manual refresh while busy refuses with refreshResult{ok:false} naming the pending action; the pending confirmation still resolves normally afterwards", async () => {
    const requestRefresh = vi.fn().mockResolvedValue(undefined);
    const { session, posted, performWrite } = makeDeps(makeStore(), { requestRefresh });
    performWrite.mockImplementation(async request => {
      const confirmPromise = request.confirm({ path: "/repo/m.py", previousContent: "a", nextContent: "b", isDestructive: true });
      return confirmPromise.then((confirmed: boolean) => {
        if (!confirmed) throw new WriteConfirmationDeclinedError("declined");
        return { path: "/repo/m.py", previousContent: "a", newContent: "b", backupPath: "/repo/m.py.bak-1" };
      });
    });
    const writePending = session.handleIntent({ type: "requestDirectWrite", requestId: "w2", repoRoot: "/repo", targetPath: "m.py", baseHash: "sha256:x", replacement: "b" });
    await vi.waitFor(() => expect(posted.some(m => m.type === "directWritePreview")).toBe(true));
    expect(session.isBusy()).toBe(true);

    await session.handleIntent({ type: "requestRefresh", requestId: "ref3" });
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: "refreshResult", requestId: "ref3", ok: false });

    await session.handleIntent({ type: "confirmDirectWrite", requestId: "w2", confirmed: true });
    await writePending;
    expect(posted.at(-1)).toEqual({ type: "directWriteResult", requestId: "w2", ok: true, path: "/repo/m.py" });
  });

  it("invokes onIdle after a declined direct write confirmation", async () => {
    const onIdle = vi.fn();
    const { session, performWrite } = makeDeps(makeStore(), { onIdle });
    performWrite.mockImplementation(async request => {
      const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: "a", nextContent: "b", isDestructive: true });
      if (!confirmed) throw new WriteConfirmationDeclinedError("declined");
      throw new Error("should not reach write");
    });
    const pending = session.handleIntent({ type: "requestDirectWrite", requestId: "w3", repoRoot: "/repo", targetPath: "m.py", baseHash: "sha256:x", replacement: "b" });
    await vi.waitFor(() => expect(session.isBusy()).toBe(true));
    await session.handleIntent({ type: "confirmDirectWrite", requestId: "w3", confirmed: false });
    await pending;
    expect(onIdle).toHaveBeenCalled();
    expect(session.isBusy()).toBe(false);
  });

  it("invokes onIdle exactly once from handleRequestDirectWrite's own catch when performWrite throws before ever requesting confirmation", async () => {
    const onIdle = vi.fn();
    const { session, posted, performWrite } = makeDeps(makeStore(), { onIdle });
    performWrite.mockRejectedValue(new Error("base hash mismatch"));
    await session.handleIntent({ type: "requestDirectWrite", requestId: "w4", repoRoot: "/repo", targetPath: "m.py", baseHash: "sha256:x", replacement: "b" });
    expect(posted.at(-1)).toMatchObject({ type: "directWriteResult", requestId: "w4", ok: false });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("invokes onIdle exactly once after a declined run", async () => {
    const onIdle = vi.fn();
    const { session } = makeDeps(makeStore(), { onIdle });
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "print(1)" } });
    await session.handleIntent({ type: "requestRun", requestId: "declineRun", variants: ["current"] });
    await session.handleIntent({ type: "confirmRun", requestId: "declineRun", confirmed: false });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("invokes onIdle exactly once after executeRun's finally block", async () => {
    const onIdle = vi.fn();
    const { session, runSnippet } = makeDeps(makeStore(), { onIdle });
    session.setActiveSources({ current: { variant: "current", path: "m.py", content: "print(1)" } });
    runSnippet.mockResolvedValue({ variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" });
    await session.handleIntent({ type: "requestRun", requestId: "execRun", variants: ["current"] });
    await session.handleIntent({ type: "confirmRun", requestId: "execRun", confirmed: true });
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1));
  });
});

describe("ChangeMapSession theme wiring", () => {
  const tokens = { kind: "dark" as const, colors: { self: "#1", parameter: "#2", className: "#3", functionName: "#4", importedName: "#5", builtin: "#6", keyword: "#7", string: "#8", comment: "#9", number: "#a" } };

  it("resolves and posts themeTokens on session construction", async () => {
    const resolveTheme = vi.fn().mockResolvedValue(tokens);
    const subscribeThemeChange = vi.fn().mockReturnValue({ dispose: vi.fn() });
    const { posted } = makeDeps(makeStore(), { resolveTheme, subscribeThemeChange });

    await vi.waitFor(() => expect(posted).toContainEqual({ type: "themeTokens", kind: "dark", colors: tokens.colors }));
    expect(subscribeThemeChange).toHaveBeenCalledTimes(1);
  });

  it("re-resolves and re-posts themeTokens when the registered change callback fires (theme change or watched config change)", async () => {
    const secondTokens = { ...tokens, kind: "light" as const };
    const resolveTheme = vi.fn().mockResolvedValueOnce(tokens).mockResolvedValueOnce(secondTokens);
    let changeCallback: (() => void) | undefined;
    const subscribeThemeChange = vi.fn((onChange: () => void) => {
      changeCallback = onChange;
      return { dispose: vi.fn() };
    });
    const { posted } = makeDeps(makeStore(), { resolveTheme, subscribeThemeChange });
    await vi.waitFor(() => expect(resolveTheme).toHaveBeenCalledTimes(1));

    changeCallback!();

    await vi.waitFor(() => expect(resolveTheme).toHaveBeenCalledTimes(2));
    expect(posted).toContainEqual({ type: "themeTokens", kind: "light", colors: secondTokens.colors });
  });

  it("still posts themeTokens with the dark default palette when resolveTheme rejects, never blocking the panel", async () => {
    const resolveTheme = vi.fn().mockRejectedValue(new Error("theme resolution boom"));
    const { posted } = makeDeps(makeStore(), { resolveTheme });

    await vi.waitFor(() => expect(posted.some((message) => message.type === "themeTokens")).toBe(true));
    const themeMessage = posted.find((message) => message.type === "themeTokens") as Extract<HostToWebviewMessage, { type: "themeTokens" }>;
    expect(themeMessage.kind).toBe("dark");
    expect(Object.keys(themeMessage.colors)).toContain("functionName");
  });

  it("does not resolve or subscribe to theme changes when resolveTheme is absent", async () => {
    const subscribeThemeChange = vi.fn();
    const { posted } = makeDeps(makeStore(), { subscribeThemeChange });

    await Promise.resolve();
    expect(subscribeThemeChange).not.toHaveBeenCalled();
    expect(posted.some((message) => message.type === "themeTokens")).toBe(false);
  });
});
