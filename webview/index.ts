import { renderGraphSvg } from "./graphView.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/webviewProtocol.js";
import type { AnalysisGraph, SourceId } from "../src/protocol.js";
import type { SnippetVariant } from "../src/execution/dockerRunner.js";
import type { DiffOp } from "../src/diff/lineDiff.js";

/** Consecutive `unchanged` ops at or above this length collapse behind a click-to-expand summary. */
const COLLAPSE_MIN_RUN = 6;
/** Rows kept visible at each boundary of a collapsed run. */
const CONTEXT = 3;

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };
const vscode = acquireVsCodeApi();
let graph: AnalysisGraph | undefined;
let sourceIndex: Record<string, { left?: SourceId; right?: SourceId }> = {};
let selected: SourceId | undefined;
let selectedPair: { left?: SourceId; right?: SourceId } | undefined;
let nextId = 0;
let activeRun: string | undefined;
let pendingAction: { type: "confirmRun" | "confirmDirectWrite"; requestId: string } | undefined;
let editingEnabled = false;
let initialized = false;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required webview element: #${id}`);
  return element as T;
}
function button(id: string, text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.id = id;
  element.textContent = text;
  element.addEventListener("click", action);
  return element;
}
function sameSource(a: SourceId | undefined, b: SourceId): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}
function setEditingEnabled(enabled: boolean): void {
  editingEnabled = enabled;
  byId<HTMLButtonElement>("save-draft").disabled = !enabled;
  byId<HTMLTextAreaElement>("draft-content").disabled = !enabled;
  updateEffectActionAvailability();
}
function updateEffectActionAvailability(): void {
  const disabled = !editingEnabled || !!pendingAction || !!activeRun;
  byId<HTMLButtonElement>("write-snippet").disabled = disabled;
  byId<HTMLButtonElement>("request-run").disabled = disabled;
}
function reserveAction(type: "confirmRun" | "confirmDirectWrite", requestId: string): boolean {
  if (pendingAction) return false;
  pendingAction = { type, requestId };
  updateEffectActionAvailability();
  byId("action-status").textContent = "Preparing confirmation…";
  return true;
}
function clearPendingAction(requestId: string): void {
  if (pendingAction?.requestId !== requestId) return;
  pendingAction = undefined;
  updateEffectActionAvailability();
}
/** Cleared before every new `sourcePair` render so expand state never leaks across nodes. */
const expandedRuns = new Set<string>();
let lastOps: DiffOp[] = [];

function lineSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ln";
  span.textContent = text;
  return span;
}
function sideCode(side: "left" | "right", text: string | undefined): HTMLElement {
  const code = document.createElement("code");
  code.className = text === undefined ? `side ${side} ghost` : `side ${side}`;
  if (text === undefined) code.setAttribute("aria-hidden", "true");
  code.textContent = text ?? "";
  return code;
}
function diffRowElement(op: DiffOp): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `diff-row op-${op.op}${op.op === "unchanged" ? " muted" : ""}`;
  const leftLine = op.op === "added" ? undefined : op.leftLine;
  const rightLine = op.op === "removed" ? undefined : op.rightLine;
  const leftText = op.op === "added" ? undefined : op.text;
  const rightText = op.op === "removed" ? undefined : op.text;
  row.append(lineSpan(leftLine !== undefined ? String(leftLine) : ""), sideCode("left", leftText));
  row.append(lineSpan(rightLine !== undefined ? String(rightLine) : ""), sideCode("right", rightText));
  return row;
}
/** `L{leftStart}-{leftEnd}/R{rightStart}-{rightEnd}` from a run's first/last op; an absent side contributes `-`. */
function runKeyFor(run: DiffOp[]): string {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const leftStart = first.op === "added" ? undefined : first.leftLine;
  const leftEnd = last.op === "added" ? undefined : last.leftLine;
  const rightStart = first.op === "removed" ? undefined : first.rightLine;
  const rightEnd = last.op === "removed" ? undefined : last.rightLine;
  return `L${leftStart ?? "-"}-${leftEnd ?? "-"}/R${rightStart ?? "-"}-${rightEnd ?? "-"}`;
}
function renderDiffPanel(ops: DiffOp[], expanded: Set<string>): void {
  const panel = byId("diff-panel");
  panel.textContent = "";
  const table = document.createElement("div");
  table.className = "diff";
  table.setAttribute("role", "table");
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.op !== "unchanged") {
      table.append(diffRowElement(op));
      index++;
      continue;
    }
    let end = index;
    while (end < ops.length && ops[end]!.op === "unchanged") end++;
    const run = ops.slice(index, end);
    if (run.length >= COLLAPSE_MIN_RUN && !expanded.has(runKeyFor(run))) {
      const key = runKeyFor(run);
      for (const contextOp of run.slice(0, CONTEXT)) table.append(diffRowElement(contextOp));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "diff-collapsed";
      button.dataset.runKey = key;
      button.textContent = `⋯ ${run.length - 2 * CONTEXT} unchanged lines ⋯`;
      button.addEventListener("click", () => {
        expanded.add(key);
        renderDiffPanel(lastOps, expanded);
      });
      table.append(button);
      for (const contextOp of run.slice(run.length - CONTEXT)) table.append(diffRowElement(contextOp));
    } else {
      for (const runOp of run) table.append(diffRowElement(runOp));
    }
    index = end;
  }
  panel.append(table);
}
function choosePair(nodeId: string): void {
  selected = undefined;
  selectedPair = sourceIndex[nodeId];
  setEditingEnabled(false);
  byId("diff-panel").textContent = "";
  byId("source-actions").textContent = "";
  byId<HTMLTextAreaElement>("draft-content").value = "";
  for (const side of ["left", "right"] as const) {
    const sourceId = selectedPair?.[side];
    const control = button(`source-${side}`, `${side === "left" ? "Left" : "Right"} source${sourceId ? `: ${sourceId.posixPath}` : " unavailable"}`, () => {
      if (!sourceId) return;
      selected = undefined;
      setEditingEnabled(false);
      vscode.postMessage({ type: "navigate", sourceId, side });
    });
    control.disabled = !sourceId;
    byId("source-actions").append(control);
  }
  vscode.postMessage({ type: "inspectSources", nodeId });
}
function requestView(): void {
  const scope = byId<HTMLSelectElement>("filter-scope").value;
  const kind = byId<HTMLSelectElement>("filter-kind").value as "contains" | "import" | "call";
  const status = byId<HTMLSelectElement>("filter-status").value as "added" | "removed" | "modified" | "unchanged";
  vscode.postMessage({ type: "requestGraphView", scopeIds: scope ? [scope] : [], relationshipKinds: kind ? [kind] : [], changeStatuses: status ? [status] : [] });
}
function selectControl(id: string, label: string, values: string[]): HTMLSelectElement {
  const text = document.createElement("label"); text.htmlFor = id; text.textContent = label;
  const select = document.createElement("select"); select.id = id;
  for (const value of values) { const option = document.createElement("option"); option.value = value; option.textContent = value || "All"; select.append(option); }
  select.addEventListener("change", requestView);
  byId("toolbar").append(text, select);
  return select;
}
function initialize(): void {
  if (initialized) return;
  initialized = true;
  selectControl("filter-scope", "Section", [""]);
  selectControl("filter-status", "Change", ["", "added", "removed", "modified", "unchanged"]);
  byId("filter-kind").addEventListener("change", requestView);
  const actions = document.createElement("section"); actions.id = "source-actions";
  const editorLabel = document.createElement("label"); editorLabel.htmlFor = "draft-content"; editorLabel.textContent = "Snippet draft (does not write to disk)";
  const editor = document.createElement("textarea"); editor.id = "draft-content"; editor.rows = 10;
  const save = button("save-draft", "Save draft", () => {
    if (selected) vscode.postMessage({ type: "saveDraft", sourceId: selected, content: editor.value });
  });
  const write = button("write-snippet", "Apply snippet to worktree…", () => {
    const requestId = `write-${++nextId}`;
    if (selected && reserveAction("confirmDirectWrite", requestId)) vscode.postMessage({ type: "requestSnippetWrite", requestId, sourceId: selected, content: editor.value });
  });
  const variants = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = "Run variants"; variants.append(legend);
  for (const variant of ["original", "current", "draft"] as const) {
    const label = document.createElement("label"); const check = document.createElement("input"); check.type = "checkbox"; check.id = `run-${variant}`; check.checked = true;
    label.append(check, document.createTextNode(variant)); variants.append(label);
  }
  const run = button("request-run", "Run selected variants…", () => {
    if (activeRun || pendingAction) return;
    const variants = (["original", "current", "draft"] as SnippetVariant[]).filter(variant => byId<HTMLInputElement>(`run-${variant}`).checked);
    if (!variants.length) { byId("action-status").textContent = "Select at least one variant."; return; }
    const requestId = `run-${++nextId}`;
    if (!reserveAction("confirmRun", requestId)) return;
    activeRun = requestId;
    updateEffectActionAvailability();
    byId("run-output").textContent = "";
    vscode.postMessage({ type: "requestRun", requestId, variants });
  });
  const cancel = button("cancel-run", "Cancel run", () => { if (activeRun) vscode.postMessage({ type: "cancelRun", requestId: activeRun }); });
  const confirmation = document.createElement("section"); confirmation.id = "confirmation"; confirmation.setAttribute("aria-live", "polite");
  const status = document.createElement("p"); status.id = "action-status"; status.setAttribute("role", "status");
  const output = document.createElement("pre"); output.id = "run-output"; output.setAttribute("aria-live", "polite");
  document.body.append(actions, editorLabel, editor, save, write, variants, run, cancel, confirmation, status, output);
  setEditingEnabled(false);
  vscode.postMessage({ type: "ready" });
}
function confirmAction(type: "confirmRun" | "confirmDirectWrite", requestId: string, description: string): void {
  if (!pendingAction || pendingAction.type !== type || pendingAction.requestId !== requestId) return;
  const container = byId("confirmation"); container.textContent = "";
  const preview = document.createElement("pre"); preview.textContent = description;
  let responded = false;
  const respond = (confirmed: boolean): void => {
    if (responded) return;
    responded = true;
    container.textContent = "";
    if (type === "confirmRun" && !confirmed) {
      activeRun = undefined;
      clearPendingAction(requestId);
    } else {
      container.textContent = "Waiting for result…";
    }
    vscode.postMessage({ type, requestId, confirmed });
  };
  container.append(preview, button("confirm-action", "Confirm", () => respond(true)), button("decline-action", "Decline", () => respond(false)));
}
function handleHostMessage(message: HostToWebviewMessage): void {
  initialize();
  switch (message.type) {
    case "graphSummary": {
      graph = undefined; selected = undefined; selectedPair = undefined; setEditingEnabled(false);
      byId("graph").textContent = "";
      byId("status").textContent = `${message.nodeCount} nodes / ${message.edgeCount} edges / ${message.diagnosticCount} diagnostics`;
      const scope = byId<HTMLSelectElement>("filter-scope"); scope.textContent = "";
      for (const section of [{ id: "", label: "All" }, ...(message.sections ?? [])]) {
        const option = document.createElement("option"); option.value = section.id; option.textContent = section.label; scope.append(option);
      }
      const consent = byId("oversized-consent"); consent.hidden = !message.oversized; consent.textContent = "";
      if (message.oversized) consent.append(document.createTextNode("Large map: choose a section/change filter above before rendering, or explicitly allow the full map. "), button("render-full", "Render full map anyway", () => vscode.postMessage({ type: "confirmOversized", confirmed: true })));
      break;
    }
    case "graph": {
      graph = message.graph; sourceIndex = message.sourceIndex;
      byId("graph").innerHTML = renderGraphSvg(graph, message.diff);
      byId("status").textContent = `${graph.nodes.length} nodes / ${graph.edges.length} edges shown`;
      for (const node of Array.from(byId("graph").querySelectorAll("[data-node-id]"))) {
        node.addEventListener("click", () => choosePair(node.getAttribute("data-node-id")!));
      }
      for (const edgeElement of Array.from(byId("graph").querySelectorAll("[data-edge-index]"))) {
        edgeElement.addEventListener("click", () => {
          const index = Number(edgeElement.getAttribute("data-edge-index"));
          const edge = graph!.edges[index];
          const edgeSource = message.edgeSources[index];
          byId("source-actions").textContent = "";
          if (!edgeSource) {
            byId("source-actions").textContent = `Relationship ${edge.kind}: exact recorded location is unavailable; endpoint navigation is intentionally refused.`;
            return;
          }
          byId("source-actions").textContent = `Relationship ${edge.kind}: opening its recorded location.`;
          vscode.postMessage({ type: "navigate", sourceId: edgeSource.sourceId, side: edgeSource.side });
        });
      }
      break;
    }
    case "sourcePair": {
      if (!selectedPair || ![selectedPair.left, selectedPair.right].some(id => id && message.sources.some(source => sameSource(id, source.sourceId)))) break;
      expandedRuns.clear();
      lastOps = message.ops;
      renderDiffPanel(lastOps, expandedRuns);
      break;
    }
    case "navigateResult": {
      if (!message.ok) { byId("action-status").textContent = `Navigation refused: ${message.reason}`; break; }
      if (!selectedPair || ![selectedPair.left, selectedPair.right].some(id => sameSource(id, message.sourceId))) {
        byId("action-status").textContent = `Opened relationship at ${message.sourceId.posixPath}, bytes ${message.sourceId.startByte}–${message.sourceId.endByte}.`;
        break;
      }
      selected = message.sourceId;
      byId<HTMLTextAreaElement>("draft-content").value = message.draftContent ?? message.content;
      byId("action-status").textContent = `Selected ${selected.posixPath}; worktree target: ${selected.posixPath}. Only this byte span will be replaced; the rest of the captured file is preserved. External changes cause refusal.`;
      setEditingEnabled(true); break;
    }
    case "draftSaved": byId("action-status").textContent = "Draft saved (worktree unchanged)."; break;
    case "directWritePreview": confirmAction("confirmDirectWrite", message.requestId, `Write to ${message.preview.path}\nDestructive: ${message.preview.isDestructive}\nBefore (complete file):\n${message.preview.previousContent}\nAfter (complete file):\n${message.preview.nextContent}`); break;
    case "directWriteResult": clearPendingAction(message.requestId); byId("confirmation").textContent = ""; byId("action-status").textContent = message.ok ? `Written: ${message.path}` : `Write refused: ${message.reason}`; break;
    case "runConfirmationRequired": confirmAction("confirmRun", message.requestId, `Run ${message.variants.join(", ")} in Docker? No network; read-only root; no host mounts; non-root user; CPU/memory/PID/time/output limits.\n${(message.sources ?? []).map(source => `${source.variant}: ${source.path ?? "unavailable"}\n${source.content ?? "No saved source"}`).join("\n")}`); break;
    case "runEvent": if (message.requestId === activeRun) byId("run-output").append(document.createTextNode(`[${message.seq} ${message.variant} ${message.channel}] ${message.data}\n`)); break;
    case "runResult": if (message.requestId === activeRun) { byId("run-output").append(document.createTextNode(message.results.map(result => {
      if (result.kind === "success" || result.kind === "failure") return `${result.variant}: ${result.kind} (exit code ${result.exitCode})`;
      if (result.kind === "timeout") return `${result.variant}: timeout (after ${result.timeoutMs}ms)`;
      return `${result.variant}: ${result.kind}`;
    }).join("\n"))); activeRun = undefined; clearPendingAction(message.requestId); byId("confirmation").textContent = ""; updateEffectActionAvailability(); } break;
    case "runFailed": if (message.requestId === activeRun) { byId("run-output").append(document.createTextNode(`Run failed: ${message.reason}`)); activeRun = undefined; clearPendingAction(message.requestId); byId("confirmation").textContent = ""; updateEffectActionAvailability(); } break;
    case "error": byId("action-status").textContent = `Error: ${message.message}`; break;
  }
}
window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => handleHostMessage(event.data));
window.addEventListener("DOMContentLoaded", initialize);
if (document.readyState !== "loading") initialize();
