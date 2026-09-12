import { describe, expect, it } from "vitest";
import { createInitialState, appReducer } from "../../webview/state/appReducer.js";
import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import type { AnalysisGraph } from "../../src/protocol.js";

const GRAPH: AnalysisGraph = { nodes: [], edges: [] } as unknown as AnalysisGraph;

describe("appReducer", () => {
  it("graphSummary (initial): resets selection, records summary, clears graph", () => {
    const seeded = appReducer(createInitialState(), {
      type: "graph",
      graph: GRAPH,
      diff: [],
      sourceIndex: {},
      edgeSources: [],
      edgeOrigins: [],
      untrackedPaths: [],
    } as unknown as HostToWebviewMessage);
    expect(seeded.graph).toBe(GRAPH);

    const message: HostToWebviewMessage = {
      type: "graphSummary",
      nodeCount: 3,
      edgeCount: 2,
      diagnosticCount: 0,
      oversized: false,
      sections: [{ id: "a", label: "A" }],
      loadReason: "initial",
    };
    const next = appReducer(seeded, message);
    expect(next.graphSummary).toEqual({ nodeCount: 3, edgeCount: 2, diagnosticCount: 0, oversized: false, sections: [{ id: "a", label: "A" }] });
    expect(next.loadReason).toBe("initial");
    expect(next.graph).toBeUndefined();
    expect(next.selectedNodeId).toBeUndefined();
    expect(next.selectedPair).toBeUndefined();
    expect(next.selected).toBeUndefined();
    expect(next.editingEnabled).toBe(false);
  });

  it("graphSummary (refresh): preserves selectedNodeId, does not clear graph", () => {
    const withSelection = { ...createInitialState(), graph: GRAPH, selectedNodeId: "n1" };
    const message: HostToWebviewMessage = {
      type: "graphSummary",
      nodeCount: 1,
      edgeCount: 0,
      diagnosticCount: 0,
      oversized: false,
      loadReason: "refresh",
    };
    const next = appReducer(withSelection, message);
    expect(next.loadReason).toBe("refresh");
    expect(next.graph).toBe(GRAPH);
    expect(next.selectedNodeId).toBe("n1");
    // pre-refresh navigation is stale until re-selection
    expect(next.selectedPair).toBeUndefined();
    expect(next.editingEnabled).toBe(false);
  });

  it("graphSummary sets oversized flag", () => {
    const next = appReducer(createInitialState(), {
      type: "graphSummary",
      nodeCount: 400,
      edgeCount: 10,
      diagnosticCount: 0,
      oversized: true,
      loadReason: "initial",
    });
    expect(next.graphSummary?.oversized).toBe(true);
  });

  it("graph: stores graph payload and increments graphSeq", () => {
    const message: HostToWebviewMessage = {
      type: "graph",
      graph: GRAPH,
      diff: [],
      sourceIndex: { n1: { left: undefined, right: undefined } },
      edgeSources: [undefined],
      edgeOrigins: ["current"],
      untrackedPaths: ["a.py"],
    };
    const s1 = createInitialState();
    const next = appReducer(s1, message);
    expect(next.graph).toBe(GRAPH);
    expect(next.sourceIndex).toEqual({ n1: { left: undefined, right: undefined } });
    expect(next.untrackedPaths).toEqual(["a.py"]);
    expect(next.graphSeq).toBe(s1.graphSeq + 1);
    expect(next.pendingInspect).toBeUndefined();
  });

  it("graph on refresh landing: sets pendingInspect for the previously selected node when still present", () => {
    const state = {
      ...createInitialState(),
      loadReason: "refresh" as const,
      selectedNodeId: "n1",
    };
    const message: HostToWebviewMessage = {
      type: "graph",
      graph: GRAPH,
      diff: [],
      sourceIndex: { n1: { left: undefined, right: undefined } },
      edgeSources: [],
      edgeOrigins: [],
      untrackedPaths: [],
    };
    const next = appReducer(state, message);
    expect(next.pendingInspect).toBe("n1");
    expect(next.selectedPair).toEqual({ left: undefined, right: undefined });
  });

  it("graph on refresh landing: no pendingInspect when the selected node no longer exists", () => {
    const state = {
      ...createInitialState(),
      loadReason: "refresh" as const,
      selectedNodeId: "gone",
    };
    const message: HostToWebviewMessage = {
      type: "graph",
      graph: GRAPH,
      diff: [],
      sourceIndex: {},
      edgeSources: [],
      edgeOrigins: [],
      untrackedPaths: [],
    };
    const next = appReducer(state, message);
    expect(next.pendingInspect).toBeUndefined();
  });

  it("sourcePair: ignored when it doesn't match the current selectedPair", () => {
    const state = createInitialState();
    const message: HostToWebviewMessage = {
      type: "sourcePair",
      sources: [{ side: "left", sourceId: { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never, content: "x", startLine: 1, endLine: 1 }],
      ops: [],
    };
    const next = appReducer(state, message);
    expect(next).toBe(state);
  });

  it("sourcePair: applies ops when it matches selectedPair", () => {
    const sourceId = { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never;
    const state = { ...createInitialState(), selectedPair: { left: sourceId } };
    const message: HostToWebviewMessage = {
      type: "sourcePair",
      sources: [{ side: "left", sourceId, content: "x", startLine: 1, endLine: 1 }],
      ops: [{ kind: "unchanged", leftLine: 1, rightLine: 1, text: "x" }] as never,
    };
    const next = appReducer(state, message);
    expect(next.diffOps).toEqual(message.ops);
  });

  it("navigateResult ok + matches selectedPair: sets selected, draft content, enables editing", () => {
    const sourceId = { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never;
    const state = { ...createInitialState(), selectedPair: { left: sourceId } };
    const message: HostToWebviewMessage = { type: "navigateResult", ok: true, sourceId, content: "hello" };
    const next = appReducer(state, message);
    expect(next.selected).toEqual(sourceId);
    expect(next.draftContent).toBe("hello");
    expect(next.editingEnabled).toBe(true);
  });

  it("navigateResult ok but does not match selectedPair: sets an informational message only", () => {
    const sourceId = { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never;
    const other = { posixPath: "b.py", startByte: 0, endByte: 1, contentHash: "h2" } as never;
    const state = { ...createInitialState(), selectedPair: { left: other } };
    const next = appReducer(state, { type: "navigateResult", ok: true, sourceId, content: "hello" });
    expect(next.selected).toBeUndefined();
    expect(next.actionStatusText).toMatch(/Opened relationship/);
  });

  it("navigateResult not ok: records refusal", () => {
    const sourceId = { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never;
    const next = appReducer(createInitialState(), { type: "navigateResult", ok: false, sourceId, reason: "external change" });
    expect(next.actionStatusText).toMatch(/Navigation refused: external change/);
  });

  it("draftSaved: sets status text", () => {
    const sourceId = { posixPath: "a.py", startByte: 0, endByte: 1, contentHash: "h" } as never;
    const next = appReducer(createInitialState(), { type: "draftSaved", sourceId, content: "x" });
    expect(next.actionStatusText).toMatch(/Draft saved/);
  });

  it("directWritePreview: ignored unless pendingAction matches confirmDirectWrite/requestId", () => {
    const state = createInitialState();
    const next = appReducer(state, {
      type: "directWritePreview",
      requestId: "r1",
      preview: { path: "a.py", isDestructive: false, previousContent: "a", nextContent: "b" } as never,
    });
    expect(next).toBe(state);
  });

  it("directWritePreview: recorded when pendingAction matches", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmDirectWrite" as const, requestId: "r1" } };
    const next = appReducer(state, {
      type: "directWritePreview",
      requestId: "r1",
      preview: { path: "a.py", isDestructive: false, previousContent: "a", nextContent: "b" } as never,
    });
    expect(next.confirmation).toEqual({ type: "confirmDirectWrite", requestId: "r1", preview: { path: "a.py", isDestructive: false, previousContent: "a", nextContent: "b" } });
  });

  it("directWriteResult ok: clears pendingAction and confirmation, sets status", () => {
    const state = {
      ...createInitialState(),
      pendingAction: { type: "confirmDirectWrite" as const, requestId: "r1" },
      confirmation: { type: "confirmDirectWrite" as const, requestId: "r1", preview: {} as never },
    };
    const next = appReducer(state, { type: "directWriteResult", requestId: "r1", ok: true, path: "a.py" });
    expect(next.pendingAction).toBeUndefined();
    expect(next.confirmation).toBeUndefined();
    expect(next.actionStatusText).toMatch(/Written: a.py/);
  });

  it("directWriteResult not ok: clears pendingAction and reports the reason", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmDirectWrite" as const, requestId: "r1" } };
    const next = appReducer(state, { type: "directWriteResult", requestId: "r1", ok: false, reason: "stale hash" });
    expect(next.pendingAction).toBeUndefined();
    expect(next.actionStatusText).toMatch(/Write refused: stale hash/);
  });

  it("runConfirmationRequired: ignored unless pendingAction matches confirmRun/requestId", () => {
    const state = createInitialState();
    const next = appReducer(state, { type: "runConfirmationRequired", requestId: "r1", variants: ["current"] });
    expect(next).toBe(state);
  });

  it("runConfirmationRequired: recorded when pendingAction matches", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmRun" as const, requestId: "r1" } };
    const next = appReducer(state, { type: "runConfirmationRequired", requestId: "r1", variants: ["current"] });
    expect(next.confirmation).toEqual({ type: "confirmRun", requestId: "r1", variants: ["current"], sources: undefined });
  });

  it("runEvent: appended to runOutputLines when it matches the active run", () => {
    const state = { ...createInitialState(), activeRun: "r1" };
    const next = appReducer(state, { type: "runEvent", requestId: "r1", variant: "current", seq: 1, channel: "stdout", data: "hi" });
    expect(next.runOutputLines).toEqual(["[1 current stdout] hi"]);
  });

  it("runEvent: appended to callResultLines when it matches a pending confirmCall instead", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmCall" as const, requestId: "r1" } };
    const next = appReducer(state, { type: "runEvent", requestId: "r1", variant: "current", seq: 2, channel: "stderr", data: "oops" });
    expect(next.callResultLines).toEqual(["[2 stderr] oops"]);
  });

  it("runEvent: ignored when it matches neither activeRun nor a pending confirmCall", () => {
    const state = createInitialState();
    const next = appReducer(state, { type: "runEvent", requestId: "unknown", variant: "current", seq: 1, channel: "stdout", data: "hi" });
    expect(next).toBe(state);
  });

  it("runResult: appends a summary line, clears activeRun/pendingAction/confirmation when it matches", () => {
    const state = { ...createInitialState(), activeRun: "r1", pendingAction: { type: "confirmRun" as const, requestId: "r1" } };
    const next = appReducer(state, {
      type: "runResult",
      requestId: "r1",
      results: [{ kind: "success", variant: "current", exitCode: 0 } as never],
    });
    expect(next.activeRun).toBeUndefined();
    expect(next.pendingAction).toBeUndefined();
    expect(next.runOutputLines).toEqual(["current: success (exit code 0)"]);
  });

  it("runResult: ignored when requestId doesn't match activeRun", () => {
    const state = { ...createInitialState(), activeRun: "other" };
    const next = appReducer(state, { type: "runResult", requestId: "r1", results: [] });
    expect(next).toBe(state);
  });

  it("runFailed: reports the reason and clears activeRun when it matches", () => {
    const state = { ...createInitialState(), activeRun: "r1", pendingAction: { type: "confirmRun" as const, requestId: "r1" } };
    const next = appReducer(state, { type: "runFailed", requestId: "r1", reason: "docker unavailable" });
    expect(next.activeRun).toBeUndefined();
    expect(next.runOutputLines).toEqual(["Run failed: docker unavailable"]);
  });

  it("error: sets actionStatusText", () => {
    const next = appReducer(createInitialState(), { type: "error", message: "boom" });
    expect(next.actionStatusText).toBe("Error: boom");
  });

  it("refreshResult ok: sets actionStatusText", () => {
    const next = appReducer(createInitialState(), { type: "refreshResult", requestId: "r1", ok: true });
    expect(next.actionStatusText).toBe("Refreshed.");
  });

  it("refreshResult not ok: reports refusal reason", () => {
    const next = appReducer(createInitialState(), { type: "refreshResult", requestId: "r1", ok: false, reason: "busy" });
    expect(next.actionStatusText).toBe("Refresh refused: busy");
  });

  it("refreshDeferred: reports the reason", () => {
    const next = appReducer(createInitialState(), { type: "refreshDeferred", reason: "pending edits" });
    expect(next.actionStatusText).toBe("Auto-refresh deferred: pending edits");
  });

  it("signatureResult: discarded when requestId/targetId don't match the in-flight request (stale-reply guard)", () => {
    const state = { ...createInitialState(), currentSignatureRequestId: "r1", currentTargetId: "t1" };
    const next = appReducer(state, { type: "signatureResult", requestId: "stale", targetId: "t1", parameters: [], cached: false });
    expect(next).toBe(state);
  });

  it("signatureResult: discarded when targetId is stale even if requestId matches", () => {
    const state = { ...createInitialState(), currentSignatureRequestId: "r1", currentTargetId: "t1" };
    const next = appReducer(state, { type: "signatureResult", requestId: "r1", targetId: "old-target", parameters: [], cached: false });
    expect(next).toBe(state);
  });

  it("signatureResult: applied when requestId and targetId both match", () => {
    const state = { ...createInitialState(), currentSignatureRequestId: "r1", currentTargetId: "t1" };
    const params = [{ name: "x" } as never];
    const next = appReducer(state, { type: "signatureResult", requestId: "r1", targetId: "t1", parameters: params, cached: true });
    expect(next.signatureParameters).toBe(params);
    expect(next.signatureCached).toBe(true);
    expect(next.signatureUnavailableReason).toBeUndefined();
  });

  it("signatureUnavailable: discarded on stale requestId/targetId", () => {
    const state = { ...createInitialState(), currentSignatureRequestId: "r1", currentTargetId: "t1" };
    const next = appReducer(state, { type: "signatureUnavailable", requestId: "r1", targetId: "other", reason: "no source" });
    expect(next).toBe(state);
  });

  it("signatureUnavailable: applied when it matches", () => {
    const state = { ...createInitialState(), currentSignatureRequestId: "r1", currentTargetId: "t1" };
    const next = appReducer(state, { type: "signatureUnavailable", requestId: "r1", targetId: "t1", reason: "no source" });
    expect(next.signatureUnavailableReason).toBe("no source");
    expect(next.signatureParameters).toBeUndefined();
  });

  it("callConfirmationRequired: ignored unless pendingAction matches confirmCall/requestId", () => {
    const state = createInitialState();
    const next = appReducer(state, { type: "callConfirmationRequired", requestId: "r1", dottedName: "a.b", argsPreview: "{}" });
    expect(next).toBe(state);
  });

  it("callConfirmationRequired: recorded when pendingAction matches", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmCall" as const, requestId: "r1" } };
    const next = appReducer(state, { type: "callConfirmationRequired", requestId: "r1", dottedName: "a.b", argsPreview: "{}" });
    expect(next.confirmation).toEqual({ type: "confirmCall", requestId: "r1", dottedName: "a.b", argsPreview: "{}" });
  });

  it("callResult: clears pendingAction/confirmation and records the result", () => {
    const state = { ...createInitialState(), pendingAction: { type: "confirmCall" as const, requestId: "r1" } };
    const result = { kind: "success", variant: "current", exitCode: 0 } as never;
    const next = appReducer(state, { type: "callResult", requestId: "r1", result, returnRepr: "42" });
    expect(next.pendingAction).toBeUndefined();
    expect(next.confirmation).toBeUndefined();
    expect(next.callResult).toEqual({ result, returnRepr: "42" });
  });

  it("themeTokens: updates themeColors", () => {
    const colors = { keyword: "#fff" } as never;
    const next = appReducer(createInitialState(), { type: "themeTokens", kind: "dark", colors });
    expect(next.themeColors).toBe(colors);
  });
});
