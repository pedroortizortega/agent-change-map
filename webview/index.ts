import { bindRelationshipDetails } from "./relationshipDetails.js";
import { renderGraphSvg, isContainerKind, routedPaths } from "./graphView.js";
import { type Point, type Rect } from "./edgeGeometry.js";
import { PositionOverrides, type Offset } from "./positionOverrides.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/webviewProtocol.js";
import type { AnalysisGraph, Entity, SourceId } from "../src/protocol.js";
import type { IntrospectionParameter, RunResult, SnippetVariant } from "../src/execution/dockerRunner.js";
import type { DiffOp } from "../src/diff/lineDiff.js";
import { DEFAULT_PALETTE, type TokenRole } from "../src/theme/tokenPalette.js";
import { highlight, type RoleSpan } from "./highlight.js";

/** Consecutive `unchanged` ops at or above this length collapse behind a click-to-expand summary. */
const COLLAPSE_MIN_RUN = 6;
/** Rows kept visible at each boundary of a collapsed run. */
const CONTEXT = 3;

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };
const vscode = acquireVsCodeApi();
let graph: AnalysisGraph | undefined;
let disposeRelationshipDetails: (() => void) | undefined;
let sourceIndex: Record<string, { left?: SourceId; right?: SourceId }> = {};
let selected: SourceId | undefined;
let selectedPair: { left?: SourceId; right?: SourceId } | undefined;
let nextId = 0;
let activeRun: string | undefined;
let pendingAction: { type: "confirmRun" | "confirmDirectWrite" | "confirmCall"; requestId: string } | undefined;
let editingEnabled = false;
let initialized = false;
/** The `targetId` (entity id) and `requestId` of the most recently issued `requestSignature`,
 * used to discard a stale `signatureResult`/`signatureUnavailable` reply that arrives after
 * the user has since selected a different node (design D2/D4). */
let currentTargetId: string | undefined;
let currentSignatureRequestId: string | undefined;
/** Names of raw-JSON parameter fields currently holding unparseable text; a non-empty set
 * blocks the call action. */
const invalidRawJsonParams = new Set<string>();
/** The parameters of the currently rendered signature form, used to gather call args by
 * name/widget shape when the "Call function" button is clicked. */
let currentParameters: IntrospectionParameter[] = [];
/** Design D6/D7/D9 (slice 3b): the currently selected entity's AST-derived `identifierRoles`,
 * offsets relative to the exact draft text (same slice the textarea/overlay render). Reset on
 * every new selection; not re-derived on edit (design's "approximate by contract" - only the
 * pure lexer keeps working live as the user types, per D7). */
let currentIdentifierRoles: RoleSpan[] = [];
/** The active theme's per-role colors (design D8), posted via `themeTokens` on activation and
 * on theme/config change. Seeded with the dark default palette so the draft renders colored
 * text immediately (spec: never a bare unstyled textarea/pre) even before the host's first
 * `themeTokens` message lands; replaced wholesale once it does. */
let currentThemeColors: Partial<Record<TokenRole, string>> = { ...DEFAULT_PALETTE.dark };

/**
 * Pushes each role's resolved color into a `--tok-ROLE` CSS custom property on the document
 * root via the CSSOM (`element.style.setProperty`), which `webview/styles.css`'s `.tok-ROLE`
 * classes read from. This is the CSP-safe way to apply per-role color: direct CSSOM writes are
 * exempt from the webview's `style-src` restriction (no `unsafe-inline`), unlike an HTML-parsed
 * `style="..."` attribute, which the browser silently drops. A role missing from `colors` falls
 * back to the dark default palette rather than leaving a custom property unset/stale.
 */
function applyThemeColors(colors: Partial<Record<TokenRole, string>>): void {
  for (const role of Object.keys(DEFAULT_PALETTE.dark) as TokenRole[]) {
    document.documentElement.style.setProperty(`--tok-${role}`, colors[role] ?? DEFAULT_PALETTE.dark[role]);
  }
}
applyThemeColors(currentThemeColors);

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
/** Design D6: the draft view is never a bare unstyled `<textarea>`/`<pre>` (spec Requirement
 * "Color draft text..."). Re-renders the synchronized `<pre>` overlay from the textarea's
 * current value, the selected entity's AST-derived `identifierRoles`, and the active theme's
 * colors. A stale/out-of-range role span (e.g. after an edit shifts offsets) is filtered out by
 * `highlight()` itself rather than throwing, so an edit never breaks rendering. */
function renderDraftOverlay(): void {
  const overlay = byId<HTMLPreElement>("draft-overlay");
  const text = byId<HTMLTextAreaElement>("draft-content").value;
  overlay.innerHTML = highlight(text, currentIdentifierRoles, currentThemeColors);
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
  updateCallAvailability();
}
function reserveAction(type: "confirmRun" | "confirmDirectWrite" | "confirmCall", requestId: string): boolean {
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
/**
 * Snapshot of `expandedRuns` taken on a `loadReason: "refresh"` `graphSummary`, restored
 * into `expandedRuns` by the next `sourcePair` and then emptied, so a landing refresh keeps
 * a diff panel's collapse state while a plain (non-refresh) second `sourcePair` for a fresh
 * node click still resets to fully collapsed.
 */
const preservedRuns = new Set<string>();
let lastOps: DiffOp[] = [];
/** The node id most recently selected via {@link choosePair}, used to re-navigate after a refresh landing. */
let selectedNodeId: string | undefined;
let currentLoadReason: "initial" | "refresh" = "initial";

/** Pixel movement below which a pointer sequence is treated as a click, not a drag. */
const DRAG_THRESHOLD = 5;
/** Bounded, LRU-capped store of committed per-node drag offsets (see `positionOverrides.ts`). */
const positionOverrides = new PositionOverrides();
/** The layout-rendered `translate(x,y)` of each node, captured fresh on every "graph" render,
 * before any override is re-applied — the base `applyPositionOverrides()` adds `dx`/`dy` to. */
const baseTransforms = new Map<string, Point>();
interface DragState {
  nodeId: string;
  el: SVGGElement;
  startX: number;
  startY: number;
  moved: boolean;
  base: Point;
  origin: Offset;
  movedIds: Set<string>;
  boxes: Map<string, Rect>;
}
let dragState: DragState | undefined;
/** Set on a completed (above-threshold) drag's `pointerup`; consumed once by the very next
 * click on any node, then left `false` until the next completed drag. Cleared only by the
 * next `pointerdown`, never by the click handler itself (see design.md's drag state machine). */
let suppressNextClick = false;

/** Live pan/zoom viewport for `#graph`'s current `<svg>`; `undefined` before the first "graph"
 * render (or right after an "initial" `graphSummary`, which clears `#graph`). `baseW`/`baseH`
 * are the unzoomed render dimensions the zoom formula and its clamp bounds are always relative
 * to (see design.md's "Zoom (exact)" section). */
let viewBox: { x: number; y: number; w: number; h: number; baseW: number; baseH: number } | undefined;
const ZOOM_STEP = 1.1;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
/** Rounds to 2 decimal places for stable, compact `viewBox` attribute text. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reads the just-rendered `<svg>`'s own `width`/`height` attributes and rewrites `viewBox` to
 * exactly match them (1:1, no zoom). Called at the end of every "graph" render so a fresh graph
 * always starts unzoomed, regardless of any zoom the user applied to the previous render.
 */
function resetViewBox(): void {
  const svg = byId("graph").querySelector("svg");
  if (!svg) { viewBox = undefined; return; }
  const baseW = Number(svg.getAttribute("width") ?? 0);
  const baseH = Number(svg.getAttribute("height") ?? 0);
  viewBox = { x: 0, y: 0, w: baseW, h: baseH, baseW, baseH };
  svg.setAttribute("viewBox", `0 0 ${baseW} ${baseH}`);
}

/**
 * One wheel listener bound once on `#graph` itself, scoped so it only acts — and only calls
 * `preventDefault()` — when the event's target is `#graph` or a descendant of it (never
 * `#diff-panel` or other page content). Zooms toward the cursor: converts the cursor's client
 * coordinates to the `<svg>`'s user space via `getBoundingClientRect()`, with a fallback to the
 * base `viewBox` dimensions when the rect is zero-size (jsdom does not implement
 * `getScreenCTM`/`createSVGPoint`; see design.md Decision 6).
 */
function onGraphWheel(event: WheelEvent): void {
  const graphEl = byId("graph");
  if (!graphEl.contains(event.target as Node) || !viewBox) return;
  event.preventDefault();
  const svg = graphEl.querySelector("svg");
  if (!svg) return;
  const factor = event.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
  const w = clamp(viewBox.w * factor, viewBox.baseW / ZOOM_MAX, viewBox.baseW / ZOOM_MIN);
  const h = w * (viewBox.baseH / viewBox.baseW);
  const rect = svg.getBoundingClientRect();
  const cw = rect.width > 0 ? rect.width : viewBox.baseW;
  const ch = rect.height > 0 ? rect.height : viewBox.baseH;
  const ux = (event.clientX - rect.left) / cw;
  const uy = (event.clientY - rect.top) / ch;
  viewBox.x += ux * (viewBox.w - w);
  viewBox.y += uy * (viewBox.h - h);
  viewBox.w = w;
  viewBox.h = h;
  svg.setAttribute("viewBox", `${r2(viewBox.x)} ${r2(viewBox.y)} ${r2(viewBox.w)} ${r2(viewBox.h)}`);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Parses a single `<g transform="translate(x,y)">` value; `{0,0}` when absent/malformed. */
function parseTranslate(el: Element): Point {
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(el.getAttribute("transform") ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

/**
 * Absolute `x`/`y` per node id: the sum of every ancestor `<g>`'s local `translate(x,y)` up to
 * (excluding) `#graph` itself, plus `w`/`h` read off the node's own child `<rect>`. Reading
 * rendered attributes rather than re-running layout or `getBBox()` — see design.md Decision 8.
 */
function readBoxes(): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  const root = byId("graph");
  for (const nodeEl of Array.from(root.querySelectorAll<SVGGElement>("[data-node-id]"))) {
    let x = 0;
    let y = 0;
    let current: Element | null = nodeEl;
    while (current && current !== root) {
      const t = parseTranslate(current);
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

/** Re-routes every edge against `boxes` in one coordinated pass, via the exact same batch
 * router (`routedPaths`, backed by `edgePathsFor`) the static render uses — never per-edge
 * `edgePathFor`, which ignores every other edge's port/lane allocation and can cut through
 * unrelated boxes that a coordinated re-route would have avoided. The full edge set and full
 * box map are always passed in, even for a live in-drag preview, because the coordinated
 * router needs the complete picture to make correct port-allocation decisions. */
function updateAllEdges(boxes: Map<string, Rect>): void {
  if (!graph) return;
  const paths = routedPaths(graph.edges, boxes);
  for (const [index, path] of paths) {
    if (path === undefined) continue;
    const pathEl = byId("graph").querySelector<SVGPathElement>(`[data-edge-index="${index}"] path`);
    if (pathEl) pathEl.setAttribute("d", path);
  }
}

function onDragMove(event: PointerEvent): void {
  if (!dragState) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  dragState.moved = true;
  dragState.el.classList.add("dragging");
  const totalDx = dragState.origin.dx + dx;
  const totalDy = dragState.origin.dy + dy;
  dragState.el.setAttribute("transform", `translate(${dragState.base.x + totalDx},${dragState.base.y + totalDy})`);
  const liveBoxes = new Map(dragState.boxes);
  for (const id of dragState.movedIds) {
    const box = dragState.boxes.get(id);
    if (box) liveBoxes.set(id, { ...box, x: box.x + totalDx, y: box.y + totalDy });
  }
  updateAllEdges(liveBoxes);
}

function onDragEnd(event: PointerEvent): void {
  if (!dragState) return;
  const state = dragState;
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  if (typeof state.el.releasePointerCapture === "function") {
    try { state.el.releasePointerCapture(event.pointerId); } catch { /* not held, or unsupported */ }
  }
  if (state.moved) {
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    positionOverrides.set(state.nodeId, { dx: state.origin.dx + dx, dy: state.origin.dy + dy });
    // Full pass over the settled DOM (which already reflects every live-dragged position),
    // not just the dragged subtree's own edges (design.md Decision 2).
    updateAllEdges(readBoxes());
    state.el.classList.remove("dragging");
    suppressNextClick = true;
  }
  dragState = undefined;
}

function startDrag(event: PointerEvent, el: SVGGElement): void {
  // Innermost node wins over its containers; click bubbling itself is untouched.
  event.stopPropagation();
  const nodeId = el.getAttribute("data-node-id")!;
  suppressNextClick = false;
  const movedIds = new Set<string>([nodeId, ...Array.from(el.querySelectorAll("[data-node-id]")).map((d) => d.getAttribute("data-node-id")!)]);
  const boxes = readBoxes();
  dragState = {
    nodeId,
    el,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    base: parseTranslate(el),
    origin: positionOverrides.get(nodeId) ?? { dx: 0, dy: 0 },
    movedIds,
    boxes,
  };
  if (typeof el.setPointerCapture === "function") {
    try { el.setPointerCapture(event.pointerId); } catch { /* unsupported (e.g. jsdom) */ }
  }
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
}

/**
 * Called at the end of every "graph" render: records each node's freshly rendered base
 * transform, prunes overrides for ids no longer present, re-applies dx/dy on top of the base
 * transform for every id that still has one, then re-routes every edge against the resulting
 * positions.
 */
function applyPositionOverrides(): void {
  const root = byId("graph");
  const nodeEls = Array.from(root.querySelectorAll<SVGGElement>("[data-node-id]"));
  baseTransforms.clear();
  for (const el of nodeEls) baseTransforms.set(el.getAttribute("data-node-id")!, parseTranslate(el));
  positionOverrides.pruneTo(baseTransforms.keys());
  for (const el of nodeEls) {
    const id = el.getAttribute("data-node-id")!;
    const offset = positionOverrides.get(id);
    if (!offset) continue;
    const base = baseTransforms.get(id)!;
    el.setAttribute("transform", `translate(${base.x + offset.dx},${base.y + offset.dy})`);
  }
  updateAllEdges(readBoxes());
}

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
/** Pure widget-mapping table (design.md's "Widget mapping"): `int`/`float` → number,
 * `bool` → checkbox, `str` → text, `Optional[X]` → a toggle plus `X`'s own widget, and
 * everything else — `list[…]`, `dict[…]`, missing/unrecognized annotations, and
 * `*args`/`**kwargs` (python's `VAR_POSITIONAL`/`VAR_KEYWORD` parameter kinds) — a raw-JSON
 * textarea fallback rather than guessing a type or dropping the parameter. */
type Widget =
  | { kind: "number" }
  | { kind: "checkbox" }
  | { kind: "text" }
  | { kind: "optional"; inner: Widget }
  | { kind: "raw-json" };

function widgetFor(param: Pick<IntrospectionParameter, "annotation" | "kind">): Widget {
  if (param.kind === "VAR_POSITIONAL" || param.kind === "VAR_KEYWORD") return { kind: "raw-json" };
  const annotation = param.annotation?.trim();
  if (!annotation) return { kind: "raw-json" };
  if (annotation === "int" || annotation === "float") return { kind: "number" };
  if (annotation === "bool") return { kind: "checkbox" };
  if (annotation === "str") return { kind: "text" };
  const optionalMatch = /^(?:typing\.)?Optional\[(.+)\]$/.exec(annotation);
  if (optionalMatch) return { kind: "optional", inner: widgetFor({ annotation: optionalMatch[1] }) };
  return { kind: "raw-json" };
}

function updateSignatureValidity(): void {
  byId("signature-form-validity").textContent = invalidRawJsonParams.size > 0 ? "Fix invalid JSON before calling." : "";
  updateCallAvailability();
}

function validateRawJson(name: string, textarea: HTMLTextAreaElement): void {
  const errorEl = document.querySelector<HTMLElement>(`[data-param-error="${name}"]`);
  const text = textarea.value.trim();
  if (text === "") {
    invalidRawJsonParams.delete(name);
    if (errorEl) errorEl.textContent = "";
  } else {
    try {
      JSON.parse(text);
      invalidRawJsonParams.delete(name);
      if (errorEl) errorEl.textContent = "";
    } catch {
      invalidRawJsonParams.add(name);
      if (errorEl) errorEl.textContent = "Invalid JSON.";
    }
  }
  updateSignatureValidity();
}

function inputForWidget(widget: Widget, name: string): HTMLElement {
  if (widget.kind === "number" || widget.kind === "text") {
    const el = document.createElement("input");
    el.type = widget.kind;
    el.dataset.param = name;
    return el;
  }
  if (widget.kind === "checkbox") {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.dataset.param = name;
    return el;
  }
  if (widget.kind === "raw-json") {
    const el = document.createElement("textarea");
    el.className = "raw-json";
    el.dataset.param = name;
    el.addEventListener("input", () => validateRawJson(name, el));
    return el;
  }
  const wrap = document.createElement("span");
  wrap.className = "optional-widget";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.dataset.paramToggle = name;
  const inner = inputForWidget(widget.inner, name);
  (inner as HTMLInputElement | HTMLTextAreaElement).disabled = true;
  toggle.addEventListener("change", () => {
    (inner as HTMLInputElement | HTMLTextAreaElement).disabled = !toggle.checked;
    if (!toggle.checked && inner instanceof HTMLTextAreaElement) validateRawJson(name, inner);
  });
  wrap.append(toggle, inner);
  return wrap;
}

function parameterRow(param: IntrospectionParameter): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "param-row";
  row.dataset.paramRow = param.name;
  const label = document.createElement("label");
  label.textContent = `${param.name}${param.required ? "" : " (optional)"}`;
  row.append(label, inputForWidget(widgetFor(param), param.name));
  const error = document.createElement("p");
  error.className = "param-error";
  error.dataset.paramError = param.name;
  row.append(error);
  return row;
}

function clearSignatureForm(): void {
  currentSignatureRequestId = undefined;
  currentParameters = [];
  invalidRawJsonParams.clear();
  const form = byId("signature-form");
  form.textContent = "";
  form.removeAttribute("data-state");
  byId("signature-status").textContent = "";
  byId("signature-form-validity").textContent = "";
  updateCallAvailability();
}

function renderSignatureForm(parameters: IntrospectionParameter[], cached: boolean): void {
  invalidRawJsonParams.clear();
  currentParameters = parameters;
  const form = byId("signature-form");
  form.textContent = "";
  form.removeAttribute("data-state");
  for (const param of parameters) form.append(parameterRow(param));
  byId("signature-status").textContent = `${parameters.length} parameter(s)${cached ? " (cached)" : ""}.`;
  updateSignatureValidity();
  updateCallAvailability();
}

function renderSignatureUnavailable(reason: string): void {
  invalidRawJsonParams.clear();
  currentParameters = [];
  const form = byId("signature-form");
  form.textContent = "";
  form.setAttribute("data-state", "unavailable");
  byId("signature-status").textContent = `Signature unavailable: ${reason}`;
  byId("signature-form-validity").textContent = "";
  updateCallAvailability();
}

/** Enabled only when a target is selected with a rendered (available) signature form,
 * no invalid raw-JSON field, and no other confirmation/run currently pending. */
function updateCallAvailability(): void {
  const unavailable = byId("signature-form").getAttribute("data-state") === "unavailable";
  const disabled = !currentTargetId || unavailable || invalidRawJsonParams.size > 0 || !!pendingAction || !!activeRun;
  byId<HTMLButtonElement>("call-function").disabled = disabled;
}

/** Reads the current widget-rendered value for one parameter out of the signature form,
 * per the widget mapping table: numbers/text/checkboxes read directly off their input;
 * `Optional[X]` reads `null` when its toggle is unchecked, otherwise `X`'s own widget
 * value; raw-JSON textareas are `JSON.parse`d (already validated not to be invalid by
 * `invalidRawJsonParams`) - an empty raw-JSON/optional-off/empty-number field is omitted
 * from the args object entirely (`undefined`), leaving the target's own default in play. */
function valueForWidget(widget: Widget, name: string): unknown {
  if (widget.kind === "number") {
    const el = document.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!;
    return el.value === "" ? undefined : Number(el.value);
  }
  if (widget.kind === "text") {
    const el = document.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!;
    return el.value;
  }
  if (widget.kind === "checkbox") {
    const el = document.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!;
    return el.checked;
  }
  if (widget.kind === "raw-json") {
    const el = document.querySelector<HTMLTextAreaElement>(`[data-param="${name}"]`)!;
    const text = el.value.trim();
    return text === "" ? undefined : JSON.parse(text);
  }
  const toggle = document.querySelector<HTMLInputElement>(`[data-param-toggle="${name}"]`)!;
  if (!toggle.checked) return null;
  return valueForWidget(widget.inner, name);
}

/** Gathers the current form's values into a plain args object keyed by parameter name,
 * omitting any parameter whose widget produced `undefined` (no value supplied). Returns
 * `undefined` instead of a partial object when any raw-JSON field currently holds
 * unparseable text - the caller must not send a call in that state. */
function gatherArgs(): Record<string, unknown> | undefined {
  if (invalidRawJsonParams.size > 0) return undefined;
  const args: Record<string, unknown> = {};
  for (const param of currentParameters) {
    const value = valueForWidget(widgetFor(param), param.name);
    if (value !== undefined) args[param.name] = value;
  }
  return args;
}

/** Issues `requestSignature` for the just-selected node's target (design D2/D4), if any.
 * Mirrors `inspectSources`: fired immediately on selection, using whichever comparison side
 * (current preferred, then original) has a resolvable source for this node. Silently clears
 * the form instead of requesting when the node has no `target` or no resolvable source — this
 * is normal (e.g. a package/module container node), not an error. */
function requestSignatureFor(targetNode: Entity | undefined, pair: { left?: SourceId; right?: SourceId } | undefined): void {
  clearSignatureForm();
  if (!targetNode?.target) { currentTargetId = undefined; return; }
  const sourceId = pair?.right ?? pair?.left;
  if (!sourceId) { currentTargetId = undefined; return; }
  currentTargetId = targetNode.id;
  const requestId = `sig-${++nextId}`;
  currentSignatureRequestId = requestId;
  byId("signature-status").textContent = "Introspecting signature…";
  vscode.postMessage({ type: "requestSignature", requestId, sourceId, targetId: targetNode.id });
}

function choosePair(nodeId: string): void {
  selectedNodeId = nodeId;
  selected = undefined;
  selectedPair = sourceIndex[nodeId];
  setEditingEnabled(false);
  byId("diff-panel").textContent = "";
  byId("source-actions").textContent = "";
  byId<HTMLTextAreaElement>("draft-content").value = "";
  currentIdentifierRoles = [];
  renderDraftOverlay();
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
  requestSignatureFor(graph?.nodes.find((candidate) => candidate.id === nodeId), selectedPair);
}
function requestView(): void {
  const scope = byId<HTMLSelectElement>("filter-scope").value;
  const kind = byId<HTMLSelectElement>("filter-kind").value as "contains" | "import" | "call";
  const status = byId<HTMLSelectElement>("filter-status").value as "added" | "removed" | "modified" | "unchanged";
  const vintages = (["current", "removed"] as const).filter(v => byId<HTMLInputElement>(`vintage-${v}`).checked);
  vscode.postMessage({ type: "requestGraphView", scopeIds: scope ? [scope] : [], relationshipKinds: kind ? [kind] : [], changeStatuses: status ? [status] : [], vintages });
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
  const vintage = document.createElement("fieldset"); vintage.id = "filter-vintage";
  const vintageLegend = document.createElement("legend"); vintageLegend.textContent = "Vintage";
  vintage.append(vintageLegend);
  for (const value of ["current", "removed"] as const) {
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox"; check.id = `vintage-${value}`; check.checked = value === "current";
    check.addEventListener("change", requestView);
    label.append(check, document.createTextNode(value)); vintage.append(label);
  }
  byId("toolbar").append(vintage);
  const actions = document.createElement("section"); actions.id = "source-actions";
  const editorLabel = document.createElement("label"); editorLabel.htmlFor = "draft-content"; editorLabel.textContent = "Snippet draft (does not write to disk)";
  // Design D6: a transparent-text `<textarea>` layered over a synchronized `<pre>` overlay -
  // not `contenteditable`, not a bundled editor - so undo/IME/a11y and every existing
  // `#draft-content` behavior (saveDraft, write-snippet, run variants) are untouched; this is
  // purely additive rendering on top of the same textarea element and content model.
  const overlayWrap = document.createElement("div"); overlayWrap.id = "draft-overlay-wrap";
  const overlay = document.createElement("pre"); overlay.id = "draft-overlay"; overlay.setAttribute("aria-hidden", "true");
  const editor = document.createElement("textarea"); editor.id = "draft-content"; editor.rows = 10;
  editor.addEventListener("input", renderDraftOverlay);
  editor.addEventListener("scroll", () => { overlay.scrollTop = editor.scrollTop; overlay.scrollLeft = editor.scrollLeft; });
  overlayWrap.append(overlay, editor);
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
  const refresh = button("trigger-refresh", "Refresh", () => {
    const requestId = `refresh-${++nextId}`;
    vscode.postMessage({ type: "requestRefresh", requestId });
  });
  byId("toolbar").append(refresh);
  byId("graph").addEventListener("wheel", event => onGraphWheel(event as WheelEvent), { passive: false });
  const confirmation = document.createElement("section"); confirmation.id = "confirmation"; confirmation.setAttribute("aria-live", "polite");
  const status = document.createElement("p"); status.id = "action-status"; status.setAttribute("role", "status");
  const output = document.createElement("pre"); output.id = "run-output"; output.setAttribute("aria-live", "polite");
  const signatureSection = document.createElement("section"); signatureSection.id = "signature-section";
  const signatureStatus = document.createElement("p"); signatureStatus.id = "signature-status"; signatureStatus.setAttribute("role", "status");
  const signatureForm = document.createElement("div"); signatureForm.id = "signature-form";
  const signatureValidity = document.createElement("p"); signatureValidity.id = "signature-form-validity"; signatureValidity.setAttribute("role", "status");
  signatureSection.append(signatureStatus, signatureForm, signatureValidity);
  const callSection = document.createElement("section"); callSection.id = "call-box";
  const callButton = button("call-function", "Call function", () => {
    if (pendingAction || activeRun || !currentTargetId) return;
    const args = gatherArgs();
    if (!args) return;
    const sourceId = selectedPair?.right ?? selectedPair?.left;
    if (!sourceId) return;
    const requestId = `call-${++nextId}`;
    if (!reserveAction("confirmCall", requestId)) return;
    byId("call-result").textContent = "";
    vscode.postMessage({ type: "requestCall", requestId, sourceId, targetId: currentTargetId, args });
  });
  const callStatus = document.createElement("p"); callStatus.id = "call-status"; callStatus.setAttribute("role", "status");
  const callResult = document.createElement("pre"); callResult.id = "call-result"; callResult.setAttribute("aria-live", "polite");
  callSection.append(callButton, callStatus, callResult);
  document.body.append(actions, editorLabel, overlayWrap, save, write, variants, run, cancel, confirmation, status, output, signatureSection, callSection);
  setEditingEnabled(false);
  vscode.postMessage({ type: "ready" });
}
function confirmAction(type: "confirmRun" | "confirmDirectWrite" | "confirmCall", requestId: string, description: string): void {
  if (!pendingAction || pendingAction.type !== type || pendingAction.requestId !== requestId) return;
  const container = byId("confirmation"); container.textContent = "";
  const preview = document.createElement("pre"); preview.textContent = description;
  let responded = false;
  const respond = (confirmed: boolean): void => {
    if (responded) return;
    responded = true;
    container.textContent = "";
    if ((type === "confirmRun" || type === "confirmCall") && !confirmed) {
      if (type === "confirmRun") activeRun = undefined;
      clearPendingAction(requestId);
    } else {
      container.textContent = "Waiting for result…";
    }
    vscode.postMessage({ type, requestId, confirmed });
  };
  container.append(preview, button("confirm-action", "Confirm", () => respond(true)), button("decline-action", "Decline", () => respond(false)));
}
/** Renders a call outcome the same way `runResult` renders a snippet run result -
 * success/failure/timeout/cancelled, with captured output - plus the decoded return
 * value's repr when the call succeeded and the `<<ACM>>` frame parsed. */
function renderCallResult(result: RunResult, returnRepr?: string): void {
  const el = byId("call-result");
  if (result.kind === "success" || result.kind === "failure") {
    const label = result.kind === "success" ? "Success" : "Failure";
    const repr = result.kind === "success" && returnRepr !== undefined ? ` (returned ${returnRepr})` : "";
    el.append(document.createTextNode(`${label}${repr} (exit code ${result.exitCode})\n${result.stdout}${result.stderr}`));
  } else if (result.kind === "timeout") {
    el.append(document.createTextNode(`Timeout (after ${result.timeoutMs}ms)\n${result.stdout}${result.stderr}`));
  } else {
    el.append(document.createTextNode(`${result.kind}`));
  }
}

function handleHostMessage(message: HostToWebviewMessage): void {
  initialize();
  switch (message.type) {
    case "graphSummary": {
      disposeRelationshipDetails?.(); disposeRelationshipDetails = undefined;
      currentLoadReason = message.loadReason;
      // The pre-refresh selection's SourceId.contentHash is stale against the new snapshot;
      // navigation is refused until the user re-selects (or the "graph" case below
      // re-issues inspectSources for the same node id once the refreshed graph renders).
      selected = undefined; selectedPair = undefined; setEditingEnabled(false);
      clearSignatureForm();
      if (message.loadReason === "initial") {
        graph = undefined;
        selectedNodeId = undefined;
        byId("graph").textContent = "";
        viewBox = undefined;
      } else {
        // Captured before the coming `sourcePair` clears `expandedRuns`, so a landing
        // refresh's diff panel re-render can restore the same collapse state.
        preservedRuns.clear();
        for (const key of expandedRuns) preservedRuns.add(key);
      }
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
      disposeRelationshipDetails?.();
      graph = message.graph; sourceIndex = message.sourceIndex;
      byId("graph").innerHTML = renderGraphSvg(graph, message.diff, message.untrackedPaths);
      byId("status").textContent = `${graph.nodes.length} nodes / ${graph.edges.length} edges shown`;
      for (const node of Array.from(byId("graph").querySelectorAll<SVGGElement>("[data-node-id]"))) {
        node.addEventListener("click", (event) => {
          // Nested containers (module > class > method) mean a click on an inner node's SVG
          // element bubbles up through every ancestor container's own [data-node-id] element,
          // each of which has this exact same listener - without stopping propagation here,
          // selecting a leaf immediately re-fires this handler for every ancestor too, and the
          // last (outermost) call always wins, silently overwriting the correct selection's
          // state (currentTargetId, selectedPair, the in-flight signature request, etc.) with
          // the container's own - the introspection request the user actually wanted then
          // arrives correctly, but gets dropped as stale because currentTargetId no longer
          // matches by the time the response lands.
          event.stopPropagation();
          if (suppressNextClick) return;
          choosePair(node.getAttribute("data-node-id")!);
        });
        node.addEventListener("pointerdown", (event) => {
          if (isContainerKind(node.getAttribute("data-node-kind") as Entity["kind"])) {
            startDrag(event as PointerEvent, node);
          } else {
            // A leaf is never draggable, but its `pointerdown` must not bubble to an
            // ancestor container's own listener and start a drag on the container instead.
            event.stopPropagation();
          }
        });
      }
      const navigateEdge = (index: number): void => {
        const edge = message.graph.edges[index];
        const edgeSource = message.edgeSources[index];
        if (!edge) return;
        byId("source-actions").textContent = "";
        if (!edgeSource) {
          byId("source-actions").textContent = `Relationship ${edge.kind}: exact recorded location is unavailable; endpoint navigation is intentionally refused.`;
          return;
        }
        byId("source-actions").textContent = `Relationship ${edge.kind}: opening its recorded location.`;
        vscode.postMessage({ type: "navigate", sourceId: edgeSource.sourceId, side: edgeSource.side });
      };
      for (const edgeElement of Array.from(byId("graph").querySelectorAll("[data-edge-index]"))) {
        edgeElement.addEventListener("click", () => navigateEdge(Number(edgeElement.getAttribute("data-edge-index"))));
      }
      disposeRelationshipDetails = bindRelationshipDetails(byId("graph"), message.graph, message.edgeSources, navigateEdge);
      // A landing refresh re-issues inspectSources for the previously selected node, if it
      // still exists, so the diff panel re-renders without requiring a fresh click. Neither
      // `selected` nor editing is re-enabled: the pre-refresh SourceId is stale against this
      // new snapshot until the user explicitly re-navigates.
      if (currentLoadReason === "refresh" && selectedNodeId && sourceIndex[selectedNodeId]) {
        selectedPair = sourceIndex[selectedNodeId];
        vscode.postMessage({ type: "inspectSources", nodeId: selectedNodeId });
      }
      applyPositionOverrides();
      resetViewBox();
      break;
    }
    case "sourcePair": {
      if (!selectedPair || ![selectedPair.left, selectedPair.right].some(id => id && message.sources.some(source => sameSource(id, source.sourceId)))) break;
      expandedRuns.clear();
      for (const key of preservedRuns) expandedRuns.add(key);
      preservedRuns.clear();
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
      // Design D9: `identifierRoles` are relative to the selected entity's own span start,
      // which is exactly what `message.content`/`draftContent` slices - so they apply as-is.
      currentIdentifierRoles = (graph?.nodes.find((candidate) => candidate.id === selectedNodeId)?.identifierRoles ?? []) as RoleSpan[];
      renderDraftOverlay();
      byId("action-status").textContent = `Selected ${selected.posixPath}; worktree target: ${selected.posixPath}. Only this byte span will be replaced; the rest of the captured file is preserved. External changes cause refusal.`;
      setEditingEnabled(true); break;
    }
    case "draftSaved": byId("action-status").textContent = "Draft saved (worktree unchanged)."; break;
    case "directWritePreview": confirmAction("confirmDirectWrite", message.requestId, `Write to ${message.preview.path}\nDestructive: ${message.preview.isDestructive}\nBefore (complete file):\n${message.preview.previousContent}\nAfter (complete file):\n${message.preview.nextContent}`); break;
    case "directWriteResult": clearPendingAction(message.requestId); byId("confirmation").textContent = ""; byId("action-status").textContent = message.ok ? `Written: ${message.path}` : `Write refused: ${message.reason}`; break;
    case "runConfirmationRequired": confirmAction("confirmRun", message.requestId, `Run ${message.variants.join(", ")} in Docker? No network; read-only root; no host mounts; non-root user; CPU/memory/PID/time/output limits.\n${(message.sources ?? []).map(source => `${source.variant}: ${source.path ?? "unavailable"}\n${source.content ?? "No saved source"}`).join("\n")}`); break;
    case "runEvent":
      if (message.requestId === activeRun) {
        byId("run-output").append(document.createTextNode(`[${message.seq} ${message.variant} ${message.channel}] ${message.data}\n`));
      } else if (pendingAction?.type === "confirmCall" && pendingAction.requestId === message.requestId) {
        byId("call-result").append(document.createTextNode(`[${message.seq} ${message.channel}] ${message.data}\n`));
      }
      break;
    case "runResult": if (message.requestId === activeRun) { byId("run-output").append(document.createTextNode(message.results.map(result => {
      if (result.kind === "success" || result.kind === "failure") return `${result.variant}: ${result.kind} (exit code ${result.exitCode})`;
      if (result.kind === "timeout") return `${result.variant}: timeout (after ${result.timeoutMs}ms)`;
      return `${result.variant}: ${result.kind}`;
    }).join("\n"))); activeRun = undefined; clearPendingAction(message.requestId); byId("confirmation").textContent = ""; updateEffectActionAvailability(); } break;
    case "runFailed": if (message.requestId === activeRun) { byId("run-output").append(document.createTextNode(`Run failed: ${message.reason}`)); activeRun = undefined; clearPendingAction(message.requestId); byId("confirmation").textContent = ""; updateEffectActionAvailability(); } break;
    case "error": byId("action-status").textContent = `Error: ${message.message}`; break;
    case "refreshResult": byId("action-status").textContent = message.ok ? "Refreshed." : `Refresh refused: ${message.reason}`; break;
    case "refreshDeferred": byId("action-status").textContent = `Auto-refresh deferred: ${message.reason}`; break;
    case "signatureResult":
      if (message.requestId !== currentSignatureRequestId || message.targetId !== currentTargetId) break;
      renderSignatureForm(message.parameters, message.cached);
      break;
    case "signatureUnavailable":
      if (message.requestId !== currentSignatureRequestId || message.targetId !== currentTargetId) break;
      renderSignatureUnavailable(message.reason);
      break;
    case "callConfirmationRequired":
      confirmAction("confirmCall", message.requestId, `Call ${message.dottedName} with args:\n${message.argsPreview}`);
      break;
    case "callResult":
      clearPendingAction(message.requestId);
      byId("confirmation").textContent = "";
      renderCallResult(message.result, message.returnRepr);
      updateEffectActionAvailability();
      break;
    case "themeTokens":
      // Design D8/D6 (spec scenario "Theme change updates rendered colors"): re-renders with
      // the same text/roles and the new palette, without requiring the node to be reselected.
      currentThemeColors = message.colors;
      applyThemeColors(currentThemeColors);
      renderDraftOverlay();
      break;
  }
}
window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => handleHostMessage(event.data));
window.addEventListener("DOMContentLoaded", initialize);
if (document.readyState !== "loading") initialize();
