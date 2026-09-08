import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeMapSession } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import { edgePathFor, type Rect } from "../../webview/edgeGeometry.js";
import type { AnalysisGraph } from "../../src/protocol.js";
import type { WebviewToHostMessage } from "../../src/webviewProtocol.js";

let dom: JSDOM;
const content = "print('current')\n";
const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:right" };
const leftSnapshot = { ...snapshot, kind: "commit" as const, resolvedOid: "a".repeat(40), contentDigest: "sha256:left" };
const node = { id: "module:m", kind: "module" as const, qualifiedName: "m", span: { path: "m.py", startByte: 0, endByte: content.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 } };
const graph: AnalysisGraph = { snapshot, nodes: [node], edges: [], diagnostics: [] };
const intents: WebviewToHostMessage[] = [];
let session: ChangeMapSession;
let run: ReturnType<typeof vi.fn>;
let writePreviewGate: Promise<void> | undefined;
const element = <T extends Element>(selector: string): T => {
  const found = dom.window.document.querySelector(selector);
  expect(found, `Missing ${selector}`).not.toBeNull();
  return found as T;
};
const click = (selector: string) => element<HTMLElement>(selector).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
/** Case 22 dispatches these steps individually (mid-drag assertions between pointermove and
 * pointerup); `drag` below composes the full sequence from this same primitive. */
const pointer = (type: string, target: EventTarget, p: { x: number; y: number }) =>
  target.dispatchEvent(new dom.window.PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true }));
const drag = (selector: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
  const el = element<Element>(selector);
  pointer("pointerdown", el, from);
  pointer("pointermove", dom.window.document, to);
  pointer("pointerup", dom.window.document, to);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
};
/** Absolute `x`/`y` = sum of ancestor `<g transform="translate(x,y)">` values up to (excluding)
 * `root`; `w`/`h` read off the node's own child `<rect>`. Independent of `webview/index.ts`'s
 * production `readBoxes()` — this is a test-side assertion helper, not a second implementation
 * of routing math (the routing math itself always comes from `edgePathFor`). */
function translateOf(el: Element): { x: number; y: number } {
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(el.getAttribute("transform") ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}
function boxesFromDom(root: Element): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  for (const nodeEl of Array.from(root.querySelectorAll("[data-node-id]"))) {
    let x = 0;
    let y = 0;
    let current: Element | null = nodeEl;
    while (current && current !== root) {
      const t = translateOf(current);
      x += t.x;
      y += t.y;
      current = current.parentElement;
    }
    const rect = nodeEl.querySelector("rect");
    const w = Number(rect?.getAttribute("width") ?? 0);
    const h = Number(rect?.getAttribute("height") ?? 0);
    boxes.set(nodeEl.getAttribute("data-node-id")!, { x, y, w, h });
  }
  return boxes;
}
const dragSpan = { path: "d.py", startByte: 0, endByte: 3, startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };
/** Two root-level function nodes with a resolved `call` edge `a -> b`, used by the plain drag,
 * click-suppression, and refresh-persistence cases. */
function twoNodeGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "function:a", kind: "function", qualifiedName: "a", span: dragSpan },
      { id: "function:b", kind: "function", qualifiedName: "b", span: dragSpan },
    ],
    edges: [{ kind: "call", source: "function:a", resolution: { kind: "resolved", target: "function:b" }, span: dragSpan }],
    diagnostics: [],
  };
}
/** A container (`module:pkg`) nesting `function:pkg.f`, which calls the separate root-level
 * `function:g`. Used by the container-drag case: dragging the container must move its nested
 * descendant and re-anchor the descendant's edge. */
function containerGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "module:pkg", kind: "module", qualifiedName: "pkg", span: dragSpan },
      { id: "function:pkg.f", kind: "function", qualifiedName: "pkg.f", containerId: "module:pkg", span: dragSpan },
      { id: "function:g", kind: "function", qualifiedName: "g", span: dragSpan },
    ],
    edges: [
      { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.f" }, span: dragSpan },
      { kind: "call", source: "function:pkg.f", resolution: { kind: "resolved", target: "function:g" }, span: dragSpan },
    ],
    diagnostics: [],
  };
}
beforeEach(async () => {
  vi.resetModules();
  intents.length = 0;
  writePreviewGate = undefined;
  dom = new JSDOM('<div id="toolbar"><select id="filter-kind"><option value="">All</option><option value="call">call</option></select></div><div id="oversized-consent" hidden></div><div id="status"></div><div id="graph"></div><div id="diff-panel"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: (message: WebviewToHostMessage) => { intents.push(message); void session.handleIntent(message); } }));
  const store = new SnapshotStore();
  store.store({ snapshot, files: [{ path: "m.py", content, provenance: "tracked" }] });
  store.store({ snapshot: leftSnapshot, files: [{ path: "m.py", content: "print('initial')\n", provenance: "tracked" }] });
  run = vi.fn(async source => ({ variant: source.variant, kind: "success", exitCode: 0, stdout: "ok\n", stderr: "" }));
  session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(async request => {
    await writePreviewGate;
    const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: content, nextContent: request.replacement, isDestructive: true });
    if (!confirmed) throw new Error("Write declined");
    return { path: "/repo/m.py", previousContent: content, newContent: request.replacement, backupPath: "/repo/m.py.bak" };
  }), runSnippet: run, post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })) });
  await import("../../webview/index.js");
  dom.window.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, []);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it("drives explicit sides, snippet draft/save, guarded write preview and run/result through DOM", async () => {
  click('[data-node-id="module:m"]');
  click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
  expect(element('#source-left').textContent).toContain("Left");
  const draft = element<HTMLTextAreaElement>('#draft-content');
  draft.value = "print('edited')\n";
  click('#save-draft');
  await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Draft saved"));
  click('#write-snippet');
  await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("/repo/m.py"));
  expect(intents.some(m => m.type === "confirmDirectWrite")).toBe(false);
  click('#confirm-action');
  await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Written"));
  click('#request-run');
  expect(run).not.toHaveBeenCalled();
  expect(element('#confirmation').textContent).toContain("network");
  click('#confirm-action');
  await vi.waitFor(() => expect(element('#run-output').textContent).toContain("success"));
  expect(run.mock.calls.some(([source]) => source.variant === "draft" && source.content.includes("edited"))).toBe(true);
});

it("declines effects and cancels using their request IDs", async () => {
  click('[data-node-id="module:m"]'); click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
  click('#request-run'); click('#decline-action');
  expect(run).not.toHaveBeenCalled();
  click('#request-run'); click('#confirm-action'); click('#cancel-run');
  expect(intents.some(m => m.type === "cancelRun")).toBe(true);
});

it("reserves the confirmation slot before a delayed write preview and rejects overlapping effects", async () => {
  let releasePreview: (() => void) | undefined;
  writePreviewGate = new Promise<void>(resolve => { releasePreview = resolve; });
  click('[data-node-id="module:m"]'); click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));

  click('#write-snippet');
  click('#write-snippet');
  click('#request-run');

  expect(intents.filter(intent => intent.type === "requestSnippetWrite")).toHaveLength(1);
  expect(intents.some(intent => intent.type === "requestRun")).toBe(false);
  expect(element('#action-status').textContent).toContain("Preparing confirmation");

  releasePreview?.();
  await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("/repo/m.py"));
  click('#confirm-action');
  await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Written"));
});

it("selects a section before oversized rendering and keeps filters actionable", () => {
  session.loadComparison(undefined, { ...graph, nodes: Array.from({ length: 301 }, (_, i) => ({ ...node, id: `m:${i}`, qualifiedName: `m${i}` })) }, []);
  expect(element('#graph').innerHTML).toBe("");
  const scope = element<HTMLSelectElement>('#filter-scope'); scope.value = "m:0";
  scope.dispatchEvent(new dom.window.Event('change'));
  expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", scopeIds: ["m:0"] });
  expect(dom.window.document.querySelectorAll('[data-node-id]')).toHaveLength(1);
});

it("renders classified diff rows with ghost cells for the missing side", async () => {
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, []);
  click('[data-node-id="module:m"]');
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  expect(element("#diff-panel").textContent).not.toContain("Affected lines");
  const removedRow = element(".diff-row.op-removed");
  expect(removedRow.querySelector(".side.left")?.textContent).toContain("initial");
  expect(removedRow.querySelector(".side.right.ghost")?.textContent).toBe("");
  const addedRow = element(".diff-row.op-added");
  expect(addedRow.querySelector(".side.right")?.textContent).toContain("current");
  expect(addedRow.querySelector(".side.left.ghost")?.textContent).toBe("");
});

it("navigates a relationship at its exact edge span (click-contract proof)", async () => {
  const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, { ...graph, edges: [{ kind: "call", source: node.id, resolution: { kind: "resolved", target: node.id }, span: edgeSpan }] }, []);
  click('[data-node-id="module:m"]');
  click('[data-edge-index="0"]');
  await vi.waitFor(() => expect(intents).toContainEqual(expect.objectContaining({
    type: "navigate",
    side: "right",
    sourceId: expect.objectContaining({ startByte: edgeSpan.startByte, endByte: edgeSpan.endByte }),
  })));
});

it("keeps both ghost columns present for a wholly one-sided (added-only) pair", async () => {
  session.loadComparison(undefined, graph, []);
  click('[data-node-id="module:m"]');
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  const rows = Array.from(dom.window.document.querySelectorAll(".diff-row.op-added"));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelector(".side.left.ghost")).not.toBeNull();
    expect(row.querySelector(".side.right")).not.toBeNull();
  }
});

it("collapses long unchanged runs, toggles them open/closed, and resets on a new sourcePair message", async () => {
  const bigSnapshotRight = { ...snapshot, contentDigest: "sha256:big-right" };
  const bigSnapshotLeft = { ...leftSnapshot, contentDigest: "sha256:big-left" };
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  // Equal-length replacements on both sides keep the full-file byte span identical for
  // left and right, since this test node's span is shared across both comparison sides.
  const leftLines = [...lines]; leftLines[9] = "left-line10";
  const rightLines = [...lines]; rightLines[9] = "rght-line10";
  const bigLeftContent = `${leftLines.join("\n")}\n`;
  const bigRightContent = `${rightLines.join("\n")}\n`;
  const bigStore = new SnapshotStore();
  bigStore.store({ snapshot: bigSnapshotRight, files: [{ path: "big.py", content: bigRightContent, provenance: "tracked" }] });
  bigStore.store({ snapshot: bigSnapshotLeft, files: [{ path: "big.py", content: bigLeftContent, provenance: "tracked" }] });
  const bigNode = { id: "module:big", kind: "module" as const, qualifiedName: "big", span: { path: "big.py", startByte: 0, endByte: bigRightContent.length, startLine: 1, startColumn: 0, endLine: 21, endColumn: 0 } };
  const bigGraph: AnalysisGraph = { snapshot: bigSnapshotRight, nodes: [bigNode], edges: [], diagnostics: [] };
  // Reassigning the shared `session` binding: the webview module's `postMessage` stub closes
  // over this outer `let`, so it dispatches into whichever session is current at call time.
  session = new ChangeMapSession({ repoRoot: "/repo", store: bigStore, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })) });
  session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, []);

  click('[data-node-id="module:big"]');
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  const collapsedButtons = () => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".diff-collapsed"));
  expect(collapsedButtons().length).toBeGreaterThan(0);
  const runKey = collapsedButtons()[0]!.getAttribute("data-run-key")!;
  expect(runKey).toMatch(/^L\d+-\d+\/R\d+-\d+$/);

  click(`[data-run-key="${runKey}"]`);
  expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
  expect(dom.window.document.querySelectorAll("#diff-panel .diff-row.op-unchanged").length).toBeGreaterThan(6);

  click('[data-node-id="module:big"]');
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  expect(collapsedButtons().some(button => button.getAttribute("data-run-key") === runKey)).toBe(true);
});

it("re-issues inspectSources for the previously selected node after a refresh landing, and preserves its expanded runs", async () => {
  const bigSnapshotRight = { ...snapshot, contentDigest: "sha256:refresh-right" };
  const bigSnapshotLeft = { ...leftSnapshot, contentDigest: "sha256:refresh-left" };
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const leftLines = [...lines]; leftLines[9] = "left-line10";
  const rightLines = [...lines]; rightLines[9] = "rght-line10";
  const bigLeftContent = `${leftLines.join("\n")}\n`;
  const bigRightContent = `${rightLines.join("\n")}\n`;
  const bigStore = new SnapshotStore();
  bigStore.store({ snapshot: bigSnapshotRight, files: [{ path: "big.py", content: bigRightContent, provenance: "tracked" }] });
  bigStore.store({ snapshot: bigSnapshotLeft, files: [{ path: "big.py", content: bigLeftContent, provenance: "tracked" }] });
  const bigNode = { id: "module:big", kind: "module" as const, qualifiedName: "big", span: { path: "big.py", startByte: 0, endByte: bigRightContent.length, startLine: 1, startColumn: 0, endLine: 21, endColumn: 0 } };
  const bigGraph: AnalysisGraph = { snapshot: bigSnapshotRight, nodes: [bigNode], edges: [], diagnostics: [] };
  session = new ChangeMapSession({ repoRoot: "/repo", store: bigStore, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })) });
  session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, []);

  click('[data-node-id="module:big"]');
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  const collapsedButtons = () => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".diff-collapsed"));
  expect(collapsedButtons().length).toBeGreaterThan(0);
  const runKey = collapsedButtons()[0]!.getAttribute("data-run-key")!;
  click(`[data-run-key="${runKey}"]`);
  expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
  const inspectCountBeforeRefresh = intents.filter(m => m.type === "inspectSources").length;
  expect(inspectCountBeforeRefresh).toBe(1);

  // A landing refresh for the same selection/content: a fresh graphSummary+graph arrives
  // with loadReason "refresh", without any node click in between. The webview must
  // automatically re-issue "inspectSources" for the previously selected node so the diff
  // panel re-renders, and the run that was expanded before the refresh must stay expanded.
  session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, [], { loadReason: "refresh" });
  await vi.waitFor(() => expect(intents.filter(m => m.type === "inspectSources").length).toBe(inspectCountBeforeRefresh + 1));
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
  expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
  expect(dom.window.document.querySelectorAll("#diff-panel .diff-row.op-unchanged").length).toBeGreaterThan(6);
});

it("preserves unsaved draft text across a refresh landing while clearing selection/editing", async () => {
  click('[data-node-id="module:m"]');
  click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
  const draft = element<HTMLTextAreaElement>('#draft-content');
  draft.value = "print('unsaved edit')\n";
  expect(element<HTMLButtonElement>('#save-draft').disabled).toBe(false);

  session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, [], { loadReason: "refresh" });
  await vi.waitFor(() => expect(element<HTMLButtonElement>('#save-draft').disabled).toBe(true));
  expect(element<HTMLTextAreaElement>('#draft-content').value).toBe("print('unsaved edit')\n");
  expect(element<HTMLButtonElement>('#write-snippet').disabled).toBe(true);

  click('#save-draft');
  expect(intents.some(m => m.type === "saveDraft")).toBe(false);
});

it("shows terminal run kinds with exit codes and timeout durations", async () => {
  run.mockImplementation(async source => {
    if (source.variant === "original") return { variant: source.variant, kind: "success", exitCode: 0, stdout: "", stderr: "" };
    if (source.variant === "current") return { variant: source.variant, kind: "failure", exitCode: 17, stdout: "", stderr: "" };
    return { variant: source.variant, kind: "timeout", timeoutMs: 1_500, stdout: "", stderr: "" };
  });
  click('[data-node-id="module:m"]'); click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
  element<HTMLTextAreaElement>('#draft-content').value = "print('draft')\n";
  click('#save-draft');
  await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Draft saved"));
  click('#request-run'); click('#confirm-action');
  await vi.waitFor(() => {
    const output = element('#run-output').textContent;
    expect(output).toContain("original: success (exit code 0)");
    expect(output).toContain("current: failure (exit code 17)");
    expect(output).toContain("draft: timeout (after 1500ms)");
  });
});

it("renders terminal runner failures rather than leaving an indefinitely running UI", async () => {
  run.mockRejectedValue(new Error("Docker is unavailable"));
  click('[data-node-id="module:m"]'); click('#source-right');
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
  click('#request-run'); click('#confirm-action');
  await vi.waitFor(() => expect(element('#run-output').textContent).toContain("Docker is unavailable"));
  click('#request-run');
  expect(element('#confirm-action')).not.toBeNull();
});

it("passes the host's untrackedPaths through to the rendered graph, marking an untracked node's provenance", async () => {
  // Regression test for a real gap: renderGraphSvg's untrackedPaths parameter defaults to
  // [] and compiles fine without this wiring, so a missing call-site update in
  // webview/index.ts's "graph" case would silently ship a provenance badge that never
  // appears for any real untracked file, even though the host already computed it.
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, [], { untrackedPaths: ["m.py"] });
  await vi.waitFor(() => expect(element('[data-node-id="module:m"]').getAttribute("data-provenance")).toBe("untracked"));
  expect(dom.window.document.querySelector(".provenance-untracked")).not.toBeNull();
});

it("discloses unresolved relationships without selecting the node and navigates only the recorded edge span", async () => {
  const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
  const input: AnalysisGraph = { ...graph, edges: [{ kind: "call", source: node.id, resolution: { kind: "unresolved" }, span: edgeSpan }] };
  session.loadComparison(undefined, input, []);
  intents.length = 0;
  click('[data-relationship-source="module:m"]');
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(false);
  const popup = element('[role="dialog"]');
  const view = [...popup.querySelectorAll("button")].find(button => button.textContent === "View in code")!;
  expect(view).toBeDefined();
  view.click();
  await vi.waitFor(() => expect(intents).toContainEqual(expect.objectContaining({
    type: "navigate", side: "right", sourceId: expect.objectContaining({ startByte: 6, endByte: 13 }),
  })));
  click('[data-relationship-source="module:m"]');
  session.loadComparison(undefined, graph, []);
  expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
});

// Case 21: above-threshold drag updates the dragged node's transform.
it("updates the dragged node's transform once the pointer moves past the drag threshold", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const before = translateOf(element('[data-node-id="function:a"]'));
  drag('[data-node-id="function:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  const after = translateOf(element('[data-node-id="function:a"]'));
  expect(after).toEqual({ x: before.x + 30, y: before.y + 40 });
});

// Case 22: an attached edge's `d` changes after a pointermove, before pointerup (live re-route
// proof, not on-drop).
it("re-routes an attached edge's path live, during pointermove, before pointerup fires", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const edgePath = element<SVGPathElement>('[data-edge-index="0"] path');
  const before = edgePath.getAttribute("d");
  const el = element('[data-node-id="function:a"]');
  pointer("pointerdown", el, { x: 100, y: 100 });
  pointer("pointermove", dom.window.document, { x: 130, y: 140 });
  const duringDrag = edgePath.getAttribute("d");
  expect(duringDrag).not.toBe(before);
  pointer("pointerup", dom.window.document, { x: 130, y: 140 });
});

// Case 23: below-threshold (2px) sequence still fires click-to-navigate (`inspectSources`
// posted).
it("still fires click-to-navigate when the pointer sequence stays below the drag threshold", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  intents.length = 0;
  drag('[data-node-id="function:a"]', { x: 100, y: 100 }, { x: 102, y: 101 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(true);
});

// Case 24: above-threshold drag posts no `inspectSources` (click suppressed); a subsequent full
// pointerdown->click still navigates.
it("suppresses click-to-navigate for the drag's own click but not for the next full click", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  intents.length = 0;
  drag('[data-node-id="function:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(false);

  drag('[data-node-id="function:a"]', { x: 200, y: 200 }, { x: 200, y: 200 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(true);
});

// Case 25: container drag — a descendant's edge `d` equals `edgePathFor` over boxes offset by
// the accumulated delta.
it("re-anchors a descendant's edge when its container is dragged, matching edgePathFor over offset boxes", async () => {
  session.loadComparison(undefined, containerGraph(), []);
  const graphEl = element('#graph');
  const baseBoxes = boxesFromDom(graphEl);
  drag('[data-node-id="module:pkg"]', { x: 300, y: 300 }, { x: 340, y: 360 });
  const dx = 40;
  const dy = 60;
  const liveBoxes = new Map(baseBoxes);
  for (const id of ["module:pkg", "function:pkg.f"]) {
    const box = baseBoxes.get(id)!;
    liveBoxes.set(id, { ...box, x: box.x + dx, y: box.y + dy });
  }
  const expected = edgePathFor(liveBoxes, "function:pkg.f", "function:g");
  const actual = element<SVGPathElement>('[data-edge-index="1"] path').getAttribute("d");
  expect(actual).toBe(expected);
});

// Case 26: a dragged position survives a simulated refresh render (`transform` = base + dx/dy).
it("keeps a dragged position across a refresh render", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  drag('[data-node-id="function:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  const draggedTransform = translateOf(element('[data-node-id="function:a"]'));

  session.loadComparison(undefined, twoNodeGraph(), [], { loadReason: "refresh" });
  await vi.waitFor(() => expect(element('[data-node-id="function:a"]')).not.toBeNull());
  const afterRefresh = translateOf(element('[data-node-id="function:a"]'));
  expect(afterRefresh).toEqual(draggedTransform);
});

// Case 27: an override for a node absent after refresh is dropped without error while a
// surviving node's override still applies.
it("drops a stale override without error while a surviving node's override still applies", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  drag('[data-node-id="function:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  drag('[data-node-id="function:b"]', { x: 400, y: 400 }, { x: 420, y: 445 });
  const survivorExpected = translateOf(element('[data-node-id="function:b"]'));

  const onlyB: AnalysisGraph = { ...twoNodeGraph(), nodes: [twoNodeGraph().nodes[1]!], edges: [] };
  expect(() => session.loadComparison(undefined, onlyB, [], { loadReason: "refresh" })).not.toThrow();
  await vi.waitFor(() => expect(element('[data-node-id="function:b"]')).not.toBeNull());
  expect(dom.window.document.querySelector('[data-node-id="function:a"]')).toBeNull();
  expect(translateOf(element('[data-node-id="function:b"]'))).toEqual(survivorExpected);
});
