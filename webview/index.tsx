import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BaseEdge, ReactFlow, ReactFlowProvider, type EdgeProps, type EdgeTypes, type NodeTypes } from "@xyflow/react";
import { bindRelationshipDetails } from "./relationshipDetails.js";
import { layoutGraph, type AcmEdge } from "./graphLayout.js";
import { AcmEntityNode } from "./nodes/AcmEntityNode.js";
import { appReducer, createInitialState, type Confirmation, type PendingAction } from "./state/appReducer.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/webviewProtocol.js";
import type { Entity, SourceId } from "../src/protocol.js";
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

/**
 * No position overrides are wired into `layoutGraph` yet (PR3's scope — see design.md D5/D6
 * and `positionOverrides.ts`'s still-`{dx,dy}`-shaped API, which does not match `layoutGraph`'s
 * absolute-`{x,y}` `overrides` input). A single, stable, empty map means every render calls
 * `layoutGraph` with the same "no overrides" input; drag persistence lands in PR3.
 */
const NO_OVERRIDES = new Map<string, { x: number; y: number }>();

/**
 * Minimal placeholder edge (design.md's PR2b-ii scope note: per-kind dash/arrow/particle
 * styling is PR4's `AcmKindEdge.tsx`/`edgeStyleConfig.ts`). Renders the coordinated router's
 * `data.path` via `<BaseEdge>` with no additional styling, and keeps the `data-edge-*`
 * attribute contract `relationshipDetails.ts`/tests address edges by.
 */
function PlainEdge({ data }: EdgeProps<AcmEdge>) {
  if (!data) return null;
  return (
    <g data-edge-index={data.edgeIndex} data-edge-kind={data.kind} data-resolution={data.resolution}>
      <title>{data.title}</title>
      <BaseEdge id={data.pathId} path={data.path} />
    </g>
  );
}

/** Module-level constants (design.md §3): defining these inline would remount every node/edge
 * on every render. The component-level casts are React Flow's own well-known generic-strictness
 * gap (tracked upstream): `NodeTypes`/`EdgeTypes` expect a component typed against the
 * library's own internal `Node`/`Edge` generic reconstruction, which structurally disagrees
 * with `NodeProps<AcmNode>`/`EdgeProps<AcmEdge>` on a couple of incidentally-optional fields
 * (`parentId`, `style`) — the runtime shapes are exactly what `layoutGraph` produces either way. */
const NODE_TYPES: NodeTypes = { acmEntity: AcmEntityNode as unknown as NodeTypes["acmEntity"] };
const EDGE_TYPES: EdgeTypes = { acmKind: PlainEdge as unknown as EdgeTypes["acmKind"] };

/** Pure widget-mapping table (ported verbatim from `index.ts`). */
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

function runKeyFor(run: DiffOp[]): string {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const leftStart = first.op === "added" ? undefined : first.leftLine;
  const leftEnd = last.op === "added" ? undefined : last.leftLine;
  const rightStart = first.op === "removed" ? undefined : first.rightLine;
  const rightEnd = last.op === "removed" ? undefined : last.rightLine;
  return `L${leftStart ?? "-"}-${leftEnd ?? "-"}/R${rightStart ?? "-"}-${rightEnd ?? "-"}`;
}

function DiffRow({ op }: { op: DiffOp }) {
  const leftLine = op.op === "added" ? undefined : op.leftLine;
  const rightLine = op.op === "removed" ? undefined : op.rightLine;
  const leftText = op.op === "added" ? undefined : op.text;
  const rightText = op.op === "removed" ? undefined : op.text;
  return (
    <div className={`diff-row op-${op.op}${op.op === "unchanged" ? " muted" : ""}`}>
      <span className="ln">{leftLine !== undefined ? String(leftLine) : ""}</span>
      <code className={leftText === undefined ? "side left ghost" : "side left"} aria-hidden={leftText === undefined ? "true" : undefined}>
        {leftText ?? ""}
      </code>
      <span className="ln">{rightLine !== undefined ? String(rightLine) : ""}</span>
      <code className={rightText === undefined ? "side right ghost" : "side right"} aria-hidden={rightText === undefined ? "true" : undefined}>
        {rightText ?? ""}
      </code>
    </div>
  );
}

/** Ported from `index.ts`'s `renderDiffPanel`: groups consecutive `unchanged` runs and
 * collapses long ones behind a click-to-expand summary. */
function DiffPanel({ ops, expanded, onToggle }: { ops: DiffOp[]; expanded: Set<string>; onToggle: (key: string) => void }) {
  const rows: React.ReactNode[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.op !== "unchanged") {
      rows.push(<DiffRow key={index} op={op} />);
      index++;
      continue;
    }
    let end = index;
    while (end < ops.length && ops[end]!.op === "unchanged") end++;
    const run = ops.slice(index, end);
    if (run.length >= COLLAPSE_MIN_RUN && !expanded.has(runKeyFor(run))) {
      const key = runKeyFor(run);
      for (const contextOp of run.slice(0, CONTEXT)) rows.push(<DiffRow key={`${key}-head-${rows.length}`} op={contextOp} />);
      rows.push(
        <button key={`${key}-toggle`} type="button" className="diff-collapsed" data-run-key={key} onClick={() => onToggle(key)}>
          {`⋯ ${run.length - 2 * CONTEXT} unchanged lines ⋯`}
        </button>,
      );
      for (const contextOp of run.slice(run.length - CONTEXT)) rows.push(<DiffRow key={`${key}-tail-${rows.length}`} op={contextOp} />);
    } else {
      for (const runOp of run) rows.push(<DiffRow key={index + run.indexOf(runOp)} op={runOp} />);
    }
    index = end;
  }
  return (
    <div id="diff-panel">
      <div className="diff" role="table">
        {rows}
      </div>
    </div>
  );
}

function inputForWidget(widget: Widget, name: string, onValidate: (name: string, textarea: HTMLTextAreaElement) => void): React.ReactNode {
  if (widget.kind === "number" || widget.kind === "text") {
    return <input type={widget.kind} data-param={name} />;
  }
  if (widget.kind === "checkbox") {
    return <input type="checkbox" data-param={name} />;
  }
  if (widget.kind === "raw-json") {
    return <textarea className="raw-json" data-param={name} onInput={(event) => onValidate(name, event.currentTarget)} />;
  }
  return (
    <span className="optional-widget">
      <input
        type="checkbox"
        data-param-toggle={name}
        onChange={(event) => {
          const wrapper = event.currentTarget.closest(".optional-widget")!;
          const inner = wrapper.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-param="${name}"]`)!;
          inner.disabled = !event.currentTarget.checked;
          if (!event.currentTarget.checked && inner instanceof HTMLTextAreaElement) onValidate(name, inner);
        }}
      />
      {inputForWidget(widget.inner, name, onValidate)}
    </span>
  );
}

function ParameterRow({ param, invalid, onValidate }: { param: IntrospectionParameter; invalid: boolean; onValidate: (name: string, textarea: HTMLTextAreaElement) => void }) {
  return (
    <div className="param-row" data-param-row={param.name}>
      <label>{`${param.name}${param.required ? "" : " (optional)"}`}</label>
      {inputForWidget(widgetFor(param), param.name, onValidate)}
      <p className="param-error" data-param-error={param.name}>
        {invalid ? "Invalid JSON." : ""}
      </p>
    </div>
  );
}

/** Reads the current widget-rendered value for one parameter out of the signature form DOM
 * (ported from `index.ts`'s `valueForWidget`). */
function valueForWidget(widget: Widget, name: string, form: HTMLElement): unknown {
  if (widget.kind === "number") {
    const el = form.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!;
    return el.value === "" ? undefined : Number(el.value);
  }
  if (widget.kind === "text") {
    return form.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!.value;
  }
  if (widget.kind === "checkbox") {
    return form.querySelector<HTMLInputElement>(`[data-param="${name}"]`)!.checked;
  }
  if (widget.kind === "raw-json") {
    const el = form.querySelector<HTMLTextAreaElement>(`[data-param="${name}"]`)!;
    const text = el.value.trim();
    return text === "" ? undefined : JSON.parse(text);
  }
  const toggle = form.querySelector<HTMLInputElement>(`[data-param-toggle="${name}"]`)!;
  if (!toggle.checked) return null;
  return valueForWidget(widget.inner, name, form);
}

function ConfirmationPanel({ confirmation, onRespond }: { confirmation: Confirmation | undefined; onRespond: (confirmed: boolean) => void }) {
  if (!confirmation) return <section id="confirmation" aria-live="polite" />;
  let description: string;
  if (confirmation.type === "confirmDirectWrite") {
    description = `Write to ${confirmation.preview.path}\nDestructive: ${confirmation.preview.isDestructive}\nBefore (complete file):\n${confirmation.preview.previousContent}\nAfter (complete file):\n${confirmation.preview.nextContent}`;
  } else if (confirmation.type === "confirmRun") {
    description = `Run ${confirmation.variants.join(", ")} in Docker? No network; read-only root; no host mounts; non-root user; CPU/memory/PID/time/output limits.\n${(confirmation.sources ?? []).map((source) => `${source.variant}: ${source.path ?? "unavailable"}\n${source.content ?? "No saved source"}`).join("\n")}`;
  } else {
    description = `Call ${confirmation.dottedName} with args:\n${confirmation.argsPreview}`;
  }
  return (
    <section id="confirmation" aria-live="polite">
      <pre>{description}</pre>
      <button id="confirm-action" onClick={() => onRespond(true)}>
        Confirm
      </button>
      <button id="decline-action" onClick={() => onRespond(false)}>
        Decline
      </button>
    </section>
  );
}

function renderCallResultText(result: RunResult, returnRepr?: string): string {
  if (result.kind === "success" || result.kind === "failure") {
    const label = result.kind === "success" ? "Success" : "Failure";
    const repr = result.kind === "success" && returnRepr !== undefined ? ` (returned ${returnRepr})` : "";
    return `${label}${repr} (exit code ${result.exitCode})\n${result.stdout}${result.stderr}`;
  }
  if (result.kind === "timeout") return `Timeout (after ${result.timeoutMs}ms)\n${result.stdout}${result.stderr}`;
  return `${result.kind}`;
}

/** React root (design.md §3). One `useReducer` over the protocol-shaped snapshot; `nodes`/
 * `edges` are derived via `useMemo(layoutGraph)`. Non-graph UI (diff panel, signature form,
 * call box, draft overlay, confirmation flow) is a straight port of `index.ts`, keeping every
 * element id `test/e2e/scenarios.ts`/the host protocol address by id. */
function App() {
  const [state, dispatch] = React.useReducer(appReducer, createInitialState());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [draftText, setDraftText] = useState("");
  const [invalidRawJsonParams, setInvalidRawJsonParams] = useState<Set<string>>(new Set());
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [currentThemeColors, setCurrentThemeColors] = useState<Partial<Record<TokenRole, string>>>({ ...DEFAULT_PALETTE.dark });
  const nextId = useRef(0);
  const graphRef = useRef<HTMLDivElement>(null);
  /** Snapshot of `expandedRuns` taken right before a refresh-landing re-`inspectSources` request
   * (see the `state.pendingInspect` effect below), consumed by the `diffOps` effect so a landing
   * refresh's diff panel re-render restores the same collapse state — mirrors the old `index.ts`'s
   * `preservedRuns` module variable (design.md's refresh-landing behavior). `undefined` means an
   * ordinary (non-refresh) selection change, which resets collapse state as before. */
  const preservedRunsRef = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebviewMessage>) => dispatch(event.data);
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    for (const role of Object.keys(DEFAULT_PALETTE.dark) as TokenRole[]) {
      document.documentElement.style.setProperty(`--tok-${role}`, currentThemeColors[role] ?? DEFAULT_PALETTE.dark[role]);
    }
  }, [currentThemeColors]);

  useEffect(() => {
    if (state.themeColors) setCurrentThemeColors(state.themeColors);
  }, [state.themeColors]);

  // Keeps the local `activeRunId` (read by the "Run selected variants…"/"Cancel run" button
  // handlers below) in sync with the reducer's own `state.activeRun`. Without this, a
  // `runResult`/`runFailed` reply clears `state.activeRun` but leaves the local copy stale,
  // permanently disabling "Request run" after the very first run (success OR failure) — the
  // guard `if (activeRunId || ...) return;` would silently no-op forever.
  useEffect(() => {
    setActiveRunId(state.activeRun);
  }, [state.activeRun]);

  useEffect(() => {
    setDraftText(state.draftContent ?? "");
  }, [state.draftContent, state.draftSourceId]);

  useEffect(() => {
    if (preservedRunsRef.current) {
      setExpandedRuns(preservedRunsRef.current);
      preservedRunsRef.current = undefined;
    } else {
      setExpandedRuns(new Set());
    }
  }, [state.diffOps]);

  // Refresh-landing re-navigation (design §3): once a fresh "graph" snapshot lands after a
  // refresh and the previously selected node still exists, the reducer's "graph" case has
  // already set `pendingInspect` (without touching `selected`/`editingEnabled`/`draftContent`/
  // `diffOps` — those stay exactly as `local:chooseNode` would have wiped them, which is
  // wrong here: the pre-refresh SourceId only goes stale, the user's in-progress draft must
  // not). This effect only drains that flag: re-issue `inspectSources` for the same node so the
  // diff panel re-renders, and snapshot the current collapse state first so the incoming
  // `sourcePair` reply's diff panel restores it instead of resetting to fully-collapsed.
  useEffect(() => {
    if (state.pendingInspect) {
      const nodeId = state.pendingInspect;
      preservedRunsRef.current = new Set(expandedRuns);
      dispatch({ type: "local:clearPendingInspect" });
      vscode.postMessage({ type: "inspectSources", nodeId });
    }
  }, [state.pendingInspect]);

  const layout = useMemo(() => {
    if (!state.graph) return undefined;
    return layoutGraph({ graph: state.graph, diff: state.diff, untrackedPaths: state.untrackedPaths, overrides: NO_OVERRIDES });
  }, [state.graph, state.diff, state.untrackedPaths]);
  const nodes = layout?.nodes ?? [];
  const edges = layout?.edges ?? [];

  useEffect(() => {
    if (!graphRef.current || !state.graph) return;
    return bindRelationshipDetails(graphRef.current, state.graph, state.edgeSources, navigateEdge);
  }, [state.graphSeq]);

  function navigateEdge(index: number): void {
    const edge = state.graph?.edges[index];
    const edgeSource = state.edgeSources[index];
    if (!edge) return;
    if (!edgeSource) {
      dispatch({ type: "local:setSourceActionsText", text: `Relationship ${edge.kind}: exact recorded location is unavailable; endpoint navigation is intentionally refused.` });
      return;
    }
    dispatch({ type: "local:setSourceActionsText", text: `Relationship ${edge.kind}: opening its recorded location.` });
    vscode.postMessage({ type: "navigate", sourceId: edgeSource.sourceId, side: edgeSource.side });
  }

  function requestSignatureFor(targetNode: Entity | undefined, pair: { left?: SourceId; right?: SourceId } | undefined): void {
    dispatch({ type: "local:clearSignatureForm" });
    setInvalidRawJsonParams(new Set());
    if (!targetNode?.target) return;
    const sourceId = pair?.right ?? pair?.left;
    if (!sourceId) return;
    const requestId = `sig-${++nextId.current}`;
    dispatch({ type: "local:setSignatureRequest", targetId: targetNode.id, requestId });
    vscode.postMessage({ type: "requestSignature", requestId, sourceId, targetId: targetNode.id });
  }

  const choosePair = useCallback(
    (nodeId: string) => {
      const pair = state.sourceIndex[nodeId];
      dispatch({ type: "local:chooseNode", nodeId, pair });
      vscode.postMessage({ type: "inspectSources", nodeId });
      requestSignatureFor(state.graph?.nodes.find((candidate) => candidate.id === nodeId), pair);
    },
    [state.sourceIndex, state.graph],
  );

  function reserveAction(type: PendingAction["type"], requestId: string): boolean {
    if (state.pendingAction) return false;
    dispatch({ type: "local:reserveAction", action: { type, requestId } });
    return true;
  }

  function respondToConfirmation(confirmed: boolean): void {
    const confirmation = state.confirmation;
    if (!confirmation) return;
    if ((confirmation.type === "confirmRun" || confirmation.type === "confirmCall") && !confirmed) {
      dispatch({ type: "local:declineConfirmation" });
      if (confirmation.type === "confirmRun") setActiveRunId(undefined);
    } else {
      dispatch({ type: "local:clearConfirmation" });
      dispatch({ type: "local:setActionStatusText", text: "Waiting for result…" });
    }
    vscode.postMessage({ type: confirmation.type, requestId: confirmation.requestId, confirmed } as WebviewToHostMessage);
  }

  function validateRawJson(name: string, textarea: HTMLTextAreaElement): void {
    const text = textarea.value.trim();
    setInvalidRawJsonParams((previous) => {
      const next = new Set(previous);
      if (text === "") {
        next.delete(name);
      } else {
        try {
          JSON.parse(text);
          next.delete(name);
        } catch {
          next.add(name);
        }
      }
      return next;
    });
  }

  function gatherArgs(form: HTMLElement, parameters: IntrospectionParameter[]): Record<string, unknown> | undefined {
    if (invalidRawJsonParams.size > 0) return undefined;
    const args: Record<string, unknown> = {};
    for (const param of parameters) {
      const value = valueForWidget(widgetFor(param), param.name, form);
      if (value !== undefined) args[param.name] = value;
    }
    return args;
  }

  const parameters = state.signatureParameters ?? [];
  const signatureFormRef = useRef<HTMLDivElement>(null);
  const callBoxRef = useRef<HTMLDivElement>(null);

  const currentIdentifierRoles: RoleSpan[] = useMemo(
    () => (state.graph?.nodes.find((candidate) => candidate.id === state.selectedNodeId)?.identifierRoles as RoleSpan[] | undefined) ?? [],
    [state.graph, state.selectedNodeId],
  );

  const sections = state.graphSummary?.sections ?? [];
  const editingBusy = !!state.pendingAction || !!activeRunId;
  const signatureUnavailable = state.signatureUnavailableReason !== undefined;
  const callDisabled = !state.currentTargetId || signatureUnavailable || invalidRawJsonParams.size > 0 || editingBusy;

  function requestView(): void {
    const form = document.getElementById("toolbar")!;
    const scope = form.querySelector<HTMLSelectElement>("#filter-scope")?.value ?? "";
    const kind = form.querySelector<HTMLSelectElement>("#filter-kind")!.value as "contains" | "import" | "call" | "";
    const status = form.querySelector<HTMLSelectElement>("#filter-status")?.value as "" | "added" | "removed" | "modified" | "unchanged";
    const vintages = (["current", "removed"] as const).filter((v) => form.querySelector<HTMLInputElement>(`#vintage-${v}`)?.checked);
    vscode.postMessage({ type: "requestGraphView", scopeIds: scope ? [scope] : [], relationshipKinds: kind ? [kind] : [], changeStatuses: status ? [status] : [], vintages });
  }

  return (
    <>
      <div id="toolbar">
        <label htmlFor="filter-scope">Section</label>
        <select id="filter-scope" onChange={requestView} defaultValue="">
          <option value="">All</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.label}
            </option>
          ))}
        </select>
        <label htmlFor="filter-status">Change</label>
        <select id="filter-status" onChange={requestView} defaultValue="">
          {["", "added", "removed", "modified", "unchanged"].map((value) => (
            <option key={value} value={value}>
              {value || "All"}
            </option>
          ))}
        </select>
        <label htmlFor="filter-kind">Relationship</label>
        <select id="filter-kind" onChange={requestView} defaultValue="">
          <option value="">All</option>
          <option value="contains">contains</option>
          <option value="import">import</option>
          <option value="call">call</option>
        </select>
        <fieldset id="filter-vintage">
          <legend>Vintage</legend>
          {(["current", "removed"] as const).map((value) => (
            <label key={value}>
              <input type="checkbox" id={`vintage-${value}`} defaultChecked={value === "current"} onChange={requestView} />
              {value}
            </label>
          ))}
        </fieldset>
        <button
          id="trigger-refresh"
          onClick={() => {
            const requestId = `refresh-${++nextId.current}`;
            vscode.postMessage({ type: "requestRefresh", requestId });
          }}
        >
          Refresh
        </button>
      </div>

      <div id="oversized-consent" hidden={!state.graphSummary?.oversized}>
        {state.graphSummary?.oversized && (
          <>
            Large map: choose a section/change filter above before rendering, or explicitly allow the full map.{" "}
            <button id="render-full" onClick={() => vscode.postMessage({ type: "confirmOversized", confirmed: true })}>
              Render full map anyway
            </button>
          </>
        )}
      </div>

      <div id="status">
        {state.graphSummary ? `${state.graphSummary.nodeCount} nodes / ${state.graphSummary.edgeCount} edges / ${state.graphSummary.diagnosticCount} diagnostics` : ""}
      </div>

      <div id="graph" ref={graphRef} style={{ width: "100%", height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodeClick={(_, n) => choosePair(n.id)}
            onEdgeClick={(_, e) => navigateEdge((e.data as AcmEdge["data"]).edgeIndex)}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            minZoom={0.2}
            maxZoom={5}
            panOnScroll={false}
            zoomOnScroll
            panOnDrag
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: false }}
            aria-label="Change map"
          />
        </ReactFlowProvider>
      </div>

      <section id="source-actions">
        {(["left", "right"] as const).map((side) => {
          const sourceId = state.selectedPair?.[side];
          return (
            <button
              key={side}
              id={`source-${side}`}
              disabled={!sourceId}
              onClick={() => {
                if (!sourceId) return;
                vscode.postMessage({ type: "navigate", sourceId, side });
              }}
            >
              {`${side === "left" ? "Left" : "Right"} source${sourceId ? `: ${sourceId.posixPath}` : " unavailable"}`}
            </button>
          );
        })}
        {state.sourceActionsText}
      </section>

      <DiffPanel
        ops={state.diffOps}
        expanded={expandedRuns}
        onToggle={(key) =>
          setExpandedRuns((previous) => {
            const next = new Set(previous);
            next.add(key);
            return next;
          })
        }
      />

      <label htmlFor="draft-content">Snippet draft (does not write to disk)</label>
      <div id="draft-overlay-wrap">
        <pre id="draft-overlay" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlight(draftText, currentIdentifierRoles, currentThemeColors) }} />
        <textarea
          id="draft-content"
          rows={10}
          disabled={!state.editingEnabled}
          value={draftText}
          onChange={(event) => setDraftText(event.currentTarget.value)}
          onScroll={(event) => {
            const overlay = document.getElementById("draft-overlay");
            if (overlay) {
              overlay.scrollTop = event.currentTarget.scrollTop;
              overlay.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
        />
      </div>
      <button
        id="save-draft"
        disabled={!state.editingEnabled}
        onClick={() => {
          if (state.selected) vscode.postMessage({ type: "saveDraft", sourceId: state.selected, content: draftText });
        }}
      >
        Save draft
      </button>
      <button
        id="write-snippet"
        disabled={!state.editingEnabled || editingBusy}
        onClick={() => {
          const requestId = `write-${++nextId.current}`;
          if (state.selected && reserveAction("confirmDirectWrite", requestId)) {
            vscode.postMessage({ type: "requestSnippetWrite", requestId, sourceId: state.selected, content: draftText });
          }
        }}
      >
        Apply snippet to worktree…
      </button>
      <fieldset>
        <legend>Run variants</legend>
        {(["original", "current", "draft"] as const).map((variant) => (
          <label key={variant}>
            <input type="checkbox" id={`run-${variant}`} defaultChecked />
            {variant}
          </label>
        ))}
      </fieldset>
      <button
        id="request-run"
        disabled={!state.editingEnabled || editingBusy}
        onClick={() => {
          if (activeRunId || state.pendingAction) return;
          const variants = (["original", "current", "draft"] as SnippetVariant[]).filter((variant) => {
            const checkbox = document.getElementById(`run-${variant}`);
            return !!checkbox && "checked" in checkbox && (checkbox as HTMLInputElement).checked;
          });
          if (!variants.length) {
            dispatch({ type: "local:setActionStatusText", text: "Select at least one variant." });
            return;
          }
          const requestId = `run-${++nextId.current}`;
          if (!reserveAction("confirmRun", requestId)) return;
          setActiveRunId(requestId);
          dispatch({ type: "local:setActiveRun", requestId });
          vscode.postMessage({ type: "requestRun", requestId, variants });
        }}
      >
        Run selected variants…
      </button>
      <button
        id="cancel-run"
        onClick={() => {
          if (activeRunId) vscode.postMessage({ type: "cancelRun", requestId: activeRunId });
        }}
      >
        Cancel run
      </button>

      <ConfirmationPanel confirmation={state.confirmation} onRespond={respondToConfirmation} />
      <p id="action-status" role="status">
        {state.actionStatusText}
      </p>
      <pre id="run-output" aria-live="polite">
        {state.runOutputLines.join("\n")}
      </pre>

      <section id="signature-section">
        <p id="signature-status" role="status">
          {state.signatureUnavailableReason !== undefined
            ? `Signature unavailable: ${state.signatureUnavailableReason}`
            : state.signatureParameters
              ? `${state.signatureParameters.length} parameter(s)${state.signatureCached ? " (cached)" : ""}.`
              : state.currentTargetId
                ? "Introspecting signature…"
                : ""}
        </p>
        <div id="signature-form" ref={signatureFormRef} data-state={signatureUnavailable ? "unavailable" : undefined}>
          {parameters.map((param) => (
            <ParameterRow key={param.name} param={param} invalid={invalidRawJsonParams.has(param.name)} onValidate={validateRawJson} />
          ))}
        </div>
        <p id="signature-form-validity" role="status">
          {invalidRawJsonParams.size > 0 ? "Fix invalid JSON before calling." : ""}
        </p>
      </section>

      <section id="call-box" ref={callBoxRef}>
        <button
          id="call-function"
          disabled={callDisabled}
          onClick={() => {
            if (state.pendingAction || editingBusy || !state.currentTargetId || !signatureFormRef.current) return;
            const args = gatherArgs(signatureFormRef.current, parameters);
            if (!args) return;
            const sourceId = state.selectedPair?.right ?? state.selectedPair?.left;
            if (!sourceId) return;
            const requestId = `call-${++nextId.current}`;
            if (!reserveAction("confirmCall", requestId)) return;
            vscode.postMessage({ type: "requestCall", requestId, sourceId, targetId: state.currentTargetId, args });
          }}
        >
          Call function
        </button>
        <p id="call-status" role="status" />
        <pre id="call-result" aria-live="polite">
          {state.callResult ? renderCallResultText(state.callResult.result, state.callResult.returnRepr) : state.callResultLines.join("\n")}
        </pre>
      </section>
    </>
  );
}

createRoot(document.body).render(<App />);
