import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeMapSession } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import { type Rect } from "../../webview/edgeGeometry.js";
import { routedPaths } from "../../webview/graphView.js";
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
/** Dispatches a cancelable `wheel` event at `target` and returns it so the caller can assert
 * `defaultPrevented`. jsdom 30 implements `WheelEvent` directly (design.md's Decision 6/7). */
const wheel = (target: EventTarget, p: { x: number; y: number; deltaY: number }): Event => {
  const event = new dom.window.WheelEvent("wheel", { clientX: p.x, clientY: p.y, deltaY: p.deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
/** Matches the production `r2` rounding (2 decimal places) so exact-number zoom assertions are
 * bit-for-bit comparable rather than merely close. */
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Absolute `x`/`y` = sum of ancestor `<g transform="translate(x,y)">` values up to (excluding)
 * `root`; `w`/`h` read off the node's own child `<rect>`. Independent of `webview/index.ts`'s
 * production `readBoxes()` — this is a test-side assertion helper, not a second implementation
 * of routing math (the routing math itself always comes from the coordinated `routedPaths`). */
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
/** Two root-level MODULE (container-kind, dashed-stroke) nodes with a resolved `call` edge
 * `a -> b`, used by the plain drag, click-suppression, and refresh-persistence cases — these
 * exercise the drag *mechanism* itself, which only ever runs on a container-kind node. */
function twoNodeGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "module:a", kind: "module", qualifiedName: "a", span: dragSpan },
      { id: "module:b", kind: "module", qualifiedName: "b", span: dragSpan },
    ],
    edges: [{ kind: "call", source: "module:a", resolution: { kind: "resolved", target: "module:b" }, span: dragSpan }],
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
  const otherNode = { ...node, id: "module:other", qualifiedName: "other" };
  // Distinct, unrelated source/target (not a self-reference) so this fixture is unaffected
  // by ancestor self-reference suppression.
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, { ...graph, nodes: [node, otherNode], edges: [{ kind: "call", source: node.id, resolution: { kind: "resolved", target: otherNode.id }, span: edgeSpan }] }, []);
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
  const before = translateOf(element('[data-node-id="module:a"]'));
  drag('[data-node-id="module:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  const after = translateOf(element('[data-node-id="module:a"]'));
  expect(after).toEqual({ x: before.x + 30, y: before.y + 40 });
});

// Case 22: an attached edge's `d` changes after a pointermove, before pointerup (live re-route
// proof, not on-drop).
it("re-routes an attached edge's path live, during pointermove, before pointerup fires", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const edgePath = element<SVGPathElement>('[data-edge-index="0"] path');
  const before = edgePath.getAttribute("d");
  const el = element('[data-node-id="module:a"]');
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
  drag('[data-node-id="module:a"]', { x: 100, y: 100 }, { x: 102, y: 101 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(true);
});

// Case 24: above-threshold drag posts no `inspectSources` (click suppressed); a subsequent full
// pointerdown->click still navigates.
it("suppresses click-to-navigate for the drag's own click but not for the next full click", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  intents.length = 0;
  drag('[data-node-id="module:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(false);

  drag('[data-node-id="module:a"]', { x: 200, y: 200 }, { x: 200, y: 200 });
  expect(intents.some(intent => intent.type === "inspectSources")).toBe(true);
});

// Case 25: container drag — a descendant's edge `d` equals the coordinated batch router
// (`routedPaths`, the same one the static render uses) over boxes offset by the accumulated
// delta — never the single-edge `edgePathFor` fallback, which ignores every other edge's
// port/lane allocation (see the bug this guards against: a per-edge recompute during drag can
// deform/cross paths that a coordinated re-route would have avoided).
it("re-anchors a descendant's edge when its container is dragged, matching the coordinated router over offset boxes", async () => {
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
  const expected = routedPaths(containerGraph().edges, liveBoxes).get(1);
  const actual = element<SVGPathElement>('[data-edge-index="1"] path').getAttribute("d");
  expect(actual).toBe(expected);
});

// Case 26: a dragged position survives a simulated refresh render (`transform` = base + dx/dy).
it("keeps a dragged position across a refresh render", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  drag('[data-node-id="module:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  const draggedTransform = translateOf(element('[data-node-id="module:a"]'));

  session.loadComparison(undefined, twoNodeGraph(), [], { loadReason: "refresh" });
  await vi.waitFor(() => expect(element('[data-node-id="module:a"]')).not.toBeNull());
  const afterRefresh = translateOf(element('[data-node-id="module:a"]'));
  expect(afterRefresh).toEqual(draggedTransform);
});

// Case 27: an override for a node absent after refresh is dropped without error while a
// surviving node's override still applies.
it("drops a stale override without error while a surviving node's override still applies", async () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  drag('[data-node-id="module:a"]', { x: 100, y: 100 }, { x: 130, y: 140 });
  drag('[data-node-id="module:b"]', { x: 400, y: 400 }, { x: 420, y: 445 });
  const survivorExpected = translateOf(element('[data-node-id="module:b"]'));

  const onlyB: AnalysisGraph = { ...twoNodeGraph(), nodes: [twoNodeGraph().nodes[1]!], edges: [] };
  expect(() => session.loadComparison(undefined, onlyB, [], { loadReason: "refresh" })).not.toThrow();
  await vi.waitFor(() => expect(element('[data-node-id="module:b"]')).not.toBeNull());
  expect(dom.window.document.querySelector('[data-node-id="module:a"]')).toBeNull();
  expect(translateOf(element('[data-node-id="module:b"]'))).toEqual(survivorExpected);
});

// Case 28: only container (dashed-stroke) kinds are draggable; leaf (solid-stroke) kinds are not.
it("never starts a drag on a leaf node, but still drags its container as before", async () => {
  session.loadComparison(undefined, containerGraph(), []);
  const leafBefore = translateOf(element('[data-node-id="function:pkg.f"]'));
  const leafEdgeBefore = element<SVGPathElement>('[data-edge-index="1"] path').getAttribute("d");
  drag('[data-node-id="function:pkg.f"]', { x: 300, y: 300 }, { x: 340, y: 360 });
  expect(translateOf(element('[data-node-id="function:pkg.f"]'))).toEqual(leafBefore);
  expect(element<SVGPathElement>('[data-edge-index="1"] path').getAttribute("d")).toBe(leafEdgeBefore);

  // Regression: the container itself must still drag exactly as before, moving its nested
  // descendant along with it via ordinary SVG transform composition.
  const containerBefore = translateOf(element('[data-node-id="module:pkg"]'));
  drag('[data-node-id="module:pkg"]', { x: 300, y: 300 }, { x: 340, y: 360 });
  expect(translateOf(element('[data-node-id="module:pkg"]'))).toEqual({ x: containerBefore.x + 40, y: containerBefore.y + 60 });
  expect(element<SVGPathElement>('[data-edge-index="1"] path').getAttribute("d")).not.toBe(leafEdgeBefore);
});

/** Absolute `x`/`y` of `el` itself: the sum of its own and every ancestor `<g>`'s local
 * `translate(x,y)` up to (excluding) `root` — same accumulation `boxesFromDom` performs per
 * node, generalized to any element (here, a relationship-indicator nested inside a node's own
 * `<g>` rather than a `[data-node-id]` element itself). */
function accumulatedPosition(el: Element, root: Element): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: Element | null = el;
  while (current && current !== root) {
    const t = translateOf(current);
    x += t.x;
    y += t.y;
    current = current.parentElement;
  }
  return { x, y };
}

/** A container (`module:pkg`) nesting `function:pkg.f`, which has one unresolved import — so
 * `function:pkg.f` gets a relationship indicator, nested inside its own `<g>`, inside the
 * container's `<g>`. Used to prove the indicator travels with a dragged ancestor container. */
function indicatorContainerGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "module:pkg", kind: "module", qualifiedName: "pkg", span: dragSpan },
      { id: "function:pkg.f", kind: "function", qualifiedName: "pkg.f", containerId: "module:pkg", span: dragSpan },
    ],
    edges: [
      { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.f" }, span: dragSpan },
      { kind: "import", source: "function:pkg.f", resolution: { kind: "unresolved" }, span: dragSpan },
    ],
    diagnostics: [],
  };
}

// Case 29: a relationship indicator, nested inside its own node's `<g>`, lands at the same
// visual spot as the old top-level-sibling absolute-position approach for a static render, and
// travels with a dragged ancestor container by exactly the drag's dx/dy.
it("keeps a descendant's relationship indicator visually anchored, including through a container drag", async () => {
  session.loadComparison(undefined, indicatorContainerGraph(), []);
  const graphEl = element('#graph');
  const indicator = element('[data-relationship-source="function:pkg.f"]');
  const nodeBox = boxesFromDom(graphEl).get("function:pkg.f")!;
  const before = accumulatedPosition(indicator, graphEl);
  // Regression: matches the old absolute formula `translate(box.x + box.w - 34, box.y + 7)`.
  expect(before).toEqual({ x: nodeBox.x + nodeBox.w - 34, y: nodeBox.y + 7 });

  drag('[data-node-id="module:pkg"]', { x: 300, y: 300 }, { x: 340, y: 360 });
  const after = accumulatedPosition(element('[data-relationship-source="function:pkg.f"]'), graphEl);
  expect(after).toEqual({ x: before.x + 40, y: before.y + 60 });
});

/** Five root-level MODULE (container-kind) nodes stacked vertically by `renderGraphSvg`'s
 * clustering, with `d`/`e` each calling both `a` and `c` (mirroring
 * `coordinatedRouting.test.ts`'s fan-in/fan-out fixture): unrelated box `b` sits between `a`
 * and `c`, so a coordinated re-route around it is required to avoid crossing straight through
 * it. Used to prove drag-time re-routing stays coordinated, not per-edge independent. */
function fanRoutingGraph(): AnalysisGraph {
  const kind = "module" as const;
  return {
    snapshot,
    nodes: [
      { id: "module:a", kind, qualifiedName: "a", span: dragSpan },
      { id: "module:b", kind, qualifiedName: "b", span: dragSpan },
      { id: "module:c", kind, qualifiedName: "c", span: dragSpan },
      { id: "module:d", kind, qualifiedName: "d", span: dragSpan },
      { id: "module:e", kind, qualifiedName: "e", span: dragSpan },
    ],
    edges: [
      // Distinct spans: `mergeGraphsForDisplay`'s edge dedup key is kind+source+span, so
      // same-source edges sharing a span would otherwise collapse into one.
      { kind: "call", source: "module:e", resolution: { kind: "resolved", target: "module:a" }, span: { ...dragSpan, startByte: 0, endByte: 1 } },
      { kind: "call", source: "module:d", resolution: { kind: "resolved", target: "module:a" }, span: { ...dragSpan, startByte: 1, endByte: 2 } },
      { kind: "call", source: "module:e", resolution: { kind: "resolved", target: "module:c" }, span: { ...dragSpan, startByte: 2, endByte: 3 } },
      { kind: "call", source: "module:d", resolution: { kind: "resolved", target: "module:c" }, span: { ...dragSpan, startByte: 3, endByte: 4 } },
    ],
    diagnostics: [],
  };
}

// Case 30 (regression): dragging one container must re-route every edge through the exact same
// coordinated batch router (`routedPaths`/`edgePathsFor`) a from-scratch render would use — a
// per-edge independent recompute (the prior `edgePathFor`-per-edge approach) can deform/cross
// paths that cut through unrelated boxes even where a coordinated re-route finds open space.
it("re-routes every edge identically to a fresh coordinated render after a container drag", async () => {
  const fanGraph = fanRoutingGraph();
  session.loadComparison(undefined, fanGraph, []);
  const graphEl = element('#graph');
  drag('[data-node-id="module:d"]', { x: 300, y: 300 }, { x: 260, y: 250 });
  const boxesAfterDrag = boxesFromDom(graphEl);
  const expected = routedPaths(fanGraph.edges, boxesAfterDrag);
  for (let index = 0; index < fanGraph.edges.length; index++) {
    const actual = dom.window.document.querySelector<SVGPathElement>(`[data-edge-index="${index}"] path`)?.getAttribute("d");
    expect(actual, `Edge ${index}'s post-drag path must match a fresh coordinated re-render`).toBe(expected.get(index));
  }
});

// Case 28: first paint through the index render path carries a `viewBox` equal to `width`/`height`.
it("carries a viewBox equal to width/height on first paint", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const svg = element<SVGSVGElement>("#graph svg");
  const w = svg.getAttribute("width");
  const h = svg.getAttribute("height");
  expect(svg.getAttribute("viewBox")).toBe(`0 0 ${w} ${h}`);
});

// Case 29: wheel up over #graph shrinks w/h by 1/ZOOM_STEP and keeps the cursor's user-space
// point fixed (exact numbers, per design.md's Zoom (exact) formula and Decision 6's
// getBoundingClientRect() jsdom zero-rect fallback: fraction = clientX / baseW).
it("zooms in toward the cursor on wheel-up over #graph, with exact numbers", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const svg = element<SVGSVGElement>("#graph svg");
  const baseW = Number(svg.getAttribute("width"));
  const baseH = Number(svg.getAttribute("height"));
  const ZOOM_STEP = 1.1;
  const clientX = 50;
  const clientY = 30;
  wheel(svg, { x: clientX, y: clientY, deltaY: -100 });
  const [x, y, w, h] = element("#graph svg").getAttribute("viewBox")!.split(" ").map(Number);
  const expectedW = round2(baseW / ZOOM_STEP);
  const expectedH = round2(baseH / ZOOM_STEP);
  const ux = clientX / baseW;
  const uy = clientY / baseH;
  const expectedX = round2(ux * (baseW - baseW / ZOOM_STEP));
  const expectedY = round2(uy * (baseH - baseH / ZOOM_STEP));
  expect(w).toBe(expectedW);
  expect(h).toBe(expectedH);
  expect(x).toBe(expectedX);
  expect(y).toBe(expectedY);
});

// Case 30: wheel down zooms out; repeated ticks clamp at ZOOM_MIN; repeated up-ticks clamp at
// ZOOM_MAX.
it("clamps zoom at ZOOM_MIN on repeated zoom-out and ZOOM_MAX on repeated zoom-in", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const svg = element<SVGSVGElement>("#graph svg");
  const baseW = Number(svg.getAttribute("width"));
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 5;
  for (let i = 0; i < 60; i++) wheel(svg, { x: 0, y: 0, deltaY: 100 });
  const outW = Number(element("#graph svg").getAttribute("viewBox")!.split(" ")[2]);
  expect(outW).toBe(round2(baseW / ZOOM_MIN));
  for (let i = 0; i < 120; i++) wheel(svg, { x: 0, y: 0, deltaY: -100 });
  const inW = Number(element("#graph svg").getAttribute("viewBox")!.split(" ")[2]);
  expect(inW).toBe(round2(baseW / ZOOM_MAX));
});

// Case 31: a wheel targeting #graph is defaultPrevented.
it("prevents default for a wheel event targeting #graph", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const svg = element<SVGSVGElement>("#graph svg");
  const event = wheel(svg, { x: 10, y: 10, deltaY: -10 });
  expect(event.defaultPrevented).toBe(true);
});

// Case 32: a wheel dispatched on #diff-panel is not defaultPrevented and leaves viewBox unchanged.
it("does not intercept wheel events outside #graph", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const before = element("#graph svg").getAttribute("viewBox");
  const panel = element("#diff-panel");
  const event = wheel(panel, { x: 10, y: 10, deltaY: -10 });
  expect(event.defaultPrevented).toBe(false);
  expect(element("#graph svg").getAttribute("viewBox")).toBe(before);
});

// Case 33: a new "graph" render after zooming resets viewBox to the base.
it("resets viewBox to the base on a new graph render after zooming", () => {
  session.loadComparison(undefined, twoNodeGraph(), []);
  const svg = element<SVGSVGElement>("#graph svg");
  wheel(svg, { x: 10, y: 10, deltaY: -100 });
  const zoomed = element("#graph svg").getAttribute("viewBox");

  session.loadComparison(undefined, twoNodeGraph(), [], { loadReason: "refresh" });
  const svg2 = element<SVGSVGElement>("#graph svg");
  const w = svg2.getAttribute("width");
  const h = svg2.getAttribute("height");
  expect(svg2.getAttribute("viewBox")).toBe(`0 0 ${w} ${h}`);
  expect(svg2.getAttribute("viewBox")).not.toBe(zoomed);
});

it("exposes a vintage toolbar fieldset defaulting to current-only", () => {
  const current = element<HTMLInputElement>('#vintage-current');
  const removed = element<HTMLInputElement>('#vintage-removed');
  expect(current.checked).toBe(true);
  expect(removed.checked).toBe(false);
  expect(element('#filter-vintage legend').textContent).toBe("Vintage");
});

it("posts requestGraphView with both vintages when Removed is checked", () => {
  const removed = element<HTMLInputElement>('#vintage-removed');
  removed.checked = true;
  removed.dispatchEvent(new dom.window.Event('change'));
  expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", vintages: ["current", "removed"] });
});

it("posts requestGraphView with an empty vintages array when both are unchecked", () => {
  const current = element<HTMLInputElement>('#vintage-current');
  current.checked = false;
  current.dispatchEvent(new dom.window.Event('change'));
  expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", vintages: [] });
});

describe("signature introspection parameter form", () => {
  function targetGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{ id: "function:f", kind: "function", qualifiedName: "f", span: node.span, target: { module: "m", dottedName: "f", callableKind: "function" } }],
      edges: [],
      diagnostics: [],
    };
  }

  function withIntrospection(parameters: { name: string; kind?: string; annotation?: string | null; defaultRepr?: string | null; required?: boolean }[]) {
    const introspection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters });
    session = new ChangeMapSession({
      repoRoot: "/repo",
      store: new SnapshotStore(),
      draftStore: new DraftStore(),
      openSource: vi.fn(),
      performWrite: vi.fn(),
      runSnippet: vi.fn(),
      runIntrospection: introspection,
      post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })),
    });
    (session as unknown as { deps: { store: SnapshotStore } }).deps.store.store({ snapshot, files: [{ path: "m.py", content: "def f():\n    return 1\n", provenance: "tracked" }] });
    session.loadComparison(undefined, targetGraph(), []);
    return introspection;
  }

  it("maps each annotation kind to its expected widget: number/checkbox/text/optional/raw-json", async () => {
    withIntrospection([
      { name: "count", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true },
      { name: "ratio", kind: "POSITIONAL_OR_KEYWORD", annotation: "float", required: true },
      { name: "flag", kind: "POSITIONAL_OR_KEYWORD", annotation: "bool", required: true },
      { name: "label", kind: "POSITIONAL_OR_KEYWORD", annotation: "str", required: true },
      { name: "maybe", kind: "POSITIONAL_OR_KEYWORD", annotation: "Optional[int]", required: false },
      { name: "items", kind: "POSITIONAL_OR_KEYWORD", annotation: "list[int]", required: true },
      { name: "mapping", kind: "POSITIONAL_OR_KEYWORD", annotation: "dict[str, int]", required: true },
      { name: "unknown", kind: "POSITIONAL_OR_KEYWORD", annotation: null, required: true },
      { name: "args", kind: "VAR_POSITIONAL", annotation: null, required: false },
      { name: "kwargs", kind: "VAR_KEYWORD", annotation: null, required: false },
    ]);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="count"]')).not.toBeNull());

    expect(element<HTMLInputElement>('[data-param="count"]').type).toBe("number");
    expect(element<HTMLInputElement>('[data-param="ratio"]').type).toBe("number");
    expect(element<HTMLInputElement>('[data-param="flag"]').type).toBe("checkbox");
    expect(element<HTMLInputElement>('[data-param="label"]').type).toBe("text");
    expect(element<HTMLInputElement>('[data-param="maybe"]').tagName).toBe("INPUT");
    expect(dom.window.document.querySelector('[data-param-toggle="maybe"]')).not.toBeNull();
    expect(element<HTMLTextAreaElement>('[data-param="items"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="mapping"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="unknown"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="args"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="kwargs"]').tagName).toBe("TEXTAREA");
  });

  it("blocks on invalid raw JSON and clears the error once the value parses", async () => {
    withIntrospection([{ name: "items", kind: "POSITIONAL_OR_KEYWORD", annotation: "list[int]", required: true }]);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="items"]')).not.toBeNull());

    const textarea = element<HTMLTextAreaElement>('[data-param="items"]');
    textarea.value = "not json";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(element('#signature-form-validity').textContent).toContain("Fix invalid JSON");
    expect(element('[data-param-error="items"]').textContent).not.toBe("");

    textarea.value = "[1, 2, 3]";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(element('#signature-form-validity').textContent).toBe("");
    expect(element('[data-param-error="items"]').textContent).toBe("");
  });

  it("shows a disabled unavailable state with no static-AST fallback when Docker is unavailable", async () => {
    // The outer `session` (from beforeEach) has no `runIntrospection` dependency at all.
    session.loadComparison(undefined, targetGraph(), []);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(element('#signature-status').textContent).toContain("unavailable"));
    expect(dom.window.document.querySelectorAll('#signature-form input, #signature-form textarea')).toHaveLength(0);
  });
});

describe("call function box", () => {
  function targetGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{ id: "function:f", kind: "function", qualifiedName: "f", span: node.span, target: { module: "m", dottedName: "f", callableKind: "function" } }],
      edges: [],
      diagnostics: [],
    };
  }

  function withIntrospectionAndCall(
    parameters: { name: string; kind?: string; annotation?: string | null; defaultRepr?: string | null; required?: boolean }[],
    callImpl?: ReturnType<typeof vi.fn>,
  ) {
    const introspection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters });
    const call = callImpl ?? vi.fn();
    session = new ChangeMapSession({
      repoRoot: "/repo",
      store: new SnapshotStore(),
      draftStore: new DraftStore(),
      openSource: vi.fn(),
      performWrite: vi.fn(),
      runSnippet: vi.fn(),
      runIntrospection: introspection,
      runCall: call,
      post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })),
    });
    (session as unknown as { deps: { store: SnapshotStore } }).deps.store.store({ snapshot, files: [{ path: "m.py", content: "def f(x):\n    return x\n", provenance: "tracked" }] });
    session.loadComparison(undefined, targetGraph(), []);
    return { introspection, call };
  }

  it("shows a confirm step with the exact args JSON preview before any requestCall triggers a spawn", async () => {
    const { call } = withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }]);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');

    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    expect(element('#confirmation').textContent).toContain("5");
    expect(call).not.toHaveBeenCalled();
    expect(intents.some(m => m.type === "confirmCall")).toBe(false);
  });

  it("performs no invocation when the call confirmation is declined", async () => {
    const { call } = withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }]);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#decline-action');

    expect(call).not.toHaveBeenCalled();
    expect(intents.some(m => m.type === "confirmCall" && (m as { confirmed: boolean }).confirmed)).toBe(false);
    expect(intents.some(m => m.type === "confirmCall" && (m as { confirmed: boolean }).confirmed === true)).toBe(false);
  });

  it("renders a successful callResult with the return repr", async () => {
    const call = vi.fn().mockResolvedValue({ result: { variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" }, returnRepr: "5" });
    withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }], call);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#confirm-action');

    await vi.waitFor(() => expect(element('#call-result').textContent).toContain("5"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("renders a failing callResult with the captured error output", async () => {
    const call = vi.fn().mockResolvedValue({ result: { variant: "current", kind: "failure", exitCode: 1, stdout: "", stderr: "boom" } });
    withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }], call);
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#confirm-action');

    await vi.waitFor(() => expect(element('#call-result').textContent).toContain("boom"));
  });
});

describe("semantic highlighting overlay (D6/D7/D8 — slice 3b)", () => {
  const highlightedContent = "def go(self):\n    return self.value\n";
  const secondSelfOffset = highlightedContent.indexOf("self", highlightedContent.indexOf("self") + 1);

  function highlightedGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{
        id: "function:go",
        kind: "function",
        qualifiedName: "go",
        span: { path: "m.py", startByte: 0, endByte: highlightedContent.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
        identifierRoles: [{ start: secondSelfOffset, end: secondSelfOffset + 4, role: "self" }],
      }],
      edges: [],
      diagnostics: [],
    };
  }

  beforeEach(() => {
    const store = new SnapshotStore();
    store.store({ snapshot, files: [{ path: "m.py", content: highlightedContent, provenance: "tracked" }] });
    session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })) });
    session.loadComparison(undefined, highlightedGraph(), []);
  });

  it("never renders the draft as a bare unstyled textarea/pre: the overlay pre's textContent equals the textarea's value", async () => {
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    const overlay = element('#draft-overlay');
    expect(overlay.textContent).toBe(highlightedContent);
    expect(overlay.innerHTML).toContain("<span");
  });

  it("re-renders the overlay on edit, keeping the text-equality invariant", async () => {
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    const draft = element<HTMLTextAreaElement>('#draft-content');
    draft.value = "def go(self):\n    return 1 + 2\n";
    draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(element('#draft-overlay').textContent).toBe(draft.value);
  });

  it("updates token colors on a themeTokens message without requiring reselection", async () => {
    // The CSP forbids inline `style="..."` (see webview/highlight.ts's module doc), so the
    // overlay's HTML always carries the same `class="tok-self"` regardless of the actual color -
    // only the `--tok-self` CSS custom property on the document root changes.
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    expect(element('#draft-overlay').innerHTML).toContain('class="tok-self"');
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "themeTokens", kind: "dark", colors: { self: "#123456" } } }));
    await vi.waitFor(() => expect(dom.window.document.documentElement.style.getPropertyValue("--tok-self")).toBe("#123456"));
    expect(element('#draft-overlay').innerHTML).not.toContain("style=");
  });

  it("renders an identifier with no determinable role as plain unstyled text without breaking overlay/textarea alignment", async () => {
    const plainContent = "plain_local_variable = 1\n";
    const store = new SnapshotStore();
    store.store({ snapshot, files: [{ path: "m.py", content: plainContent, provenance: "tracked" }] });
    session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })) });
    session.loadComparison(undefined, { snapshot, nodes: [{ id: "module:m", kind: "module", qualifiedName: "m", span: { path: "m.py", startByte: 0, endByte: plainContent.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 } }], edges: [], diagnostics: [] }, []);
    click('[data-node-id="module:m"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(plainContent));
    const overlay = element('#draft-overlay');
    expect(overlay.textContent).toBe(plainContent);
  });
});
