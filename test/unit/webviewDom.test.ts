import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeMapSession } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
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
