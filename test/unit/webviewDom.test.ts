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
  store.store({ snapshot, files: [{ path: "m.py", content }] });
  store.store({ snapshot: leftSnapshot, files: [{ path: "m.py", content: "print('initial')\n" }] });
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

it("identifies affected comparison lines and navigates a relationship at its exact edge span", async () => {
  const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
  session.loadComparison({ ...graph, snapshot: leftSnapshot }, { ...graph, edges: [{ kind: "call", source: node.id, resolution: { kind: "resolved", target: node.id }, span: edgeSpan }] }, []);
  click('[data-node-id="module:m"]');
  expect(element('#diff-panel').textContent).toContain("initial");
  expect(element('#diff-panel').textContent).toContain("current");
  expect(element('#diff-panel').textContent).toContain("Affected lines: 1");
  click('[data-edge-index="0"]');
  await vi.waitFor(() => expect(intents).toContainEqual(expect.objectContaining({
    type: "navigate",
    side: "right",
    sourceId: expect.objectContaining({ startByte: edgeSpan.startByte, endByte: edgeSpan.endByte }),
  })));
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
