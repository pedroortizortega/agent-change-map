import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import type { AnalysisGraph, SourceId } from "../../src/protocol.js";
import type { CorrelatedDiffEntry } from "../../src/navigation/sourceProvider.js";
import type { IntrospectionParameter, RunResult, SnippetVariant } from "../../src/execution/dockerRunner.js";
import type { WriteEffectPreview } from "../../src/editing/writeGuard.js";
import type { DiffOp } from "../../src/diff/lineDiff.js";
import type { TokenRole } from "../../src/theme/tokenPalette.js";

/** Mirrors `index.ts`'s `pendingAction` module variable (design §3). */
export interface PendingAction {
  type: "confirmRun" | "confirmDirectWrite" | "confirmCall";
  requestId: string;
}

/**
 * The confirmation description surfaced once the host has echoed back a matching
 * `*ConfirmationRequired`/`directWritePreview` message for the reserved {@link PendingAction}.
 * Ported from `index.ts`'s `confirmAction()`, which builds the same description text from the
 * DOM; here it stays as structured data so a component can render it however it likes.
 */
export type Confirmation =
  | { type: "confirmDirectWrite"; requestId: string; preview: WriteEffectPreview }
  | { type: "confirmRun"; requestId: string; variants: SnippetVariant[]; sources?: { variant: SnippetVariant; path?: string; content?: string }[] }
  | { type: "confirmCall"; requestId: string; dottedName: string; argsPreview: string };

export interface AppState {
  /** `loadReason` of the most recent `graphSummary` — drives the refresh-landing behavior below. */
  loadReason: "initial" | "refresh";
  graphSummary?: {
    nodeCount: number;
    edgeCount: number;
    diagnosticCount: number;
    oversized: boolean;
    sections: { id: string; label: string }[];
  };

  graph?: AnalysisGraph;
  diff: CorrelatedDiffEntry[];
  sourceIndex: Record<string, { left?: SourceId; right?: SourceId }>;
  edgeSources: ({ sourceId: SourceId; side: "left" | "right" } | undefined)[];
  edgeOrigins: ("current" | "removed")[];
  untrackedPaths: string[];
  /** Monotonically incremented on every `graph` message; the trigger for `fitView()` in
   * `index.tsx` (design §3) so hover/drag re-renders never re-fit the viewport. */
  graphSeq: number;
  /** The nodeId most recently chosen via `choosePair` (design keeps the name); survives a
   * `graphSummary`/`graph` refresh pair so the landing behavior below can re-navigate to it. */
  selectedNodeId?: string;

  selectedPair?: { left?: SourceId; right?: SourceId };
  selected?: SourceId;
  editingEnabled: boolean;
  draftContent?: string;
  draftSourceId?: SourceId;
  diffOps: DiffOp[];

  /** Drained by a `useEffect` in `index.tsx`: when a landing refresh's `graph` case finds the
   * previously selected node still present, this is set to its id so the effect re-posts
   * `inspectSources` — kept out of the reducer itself so it stays side-effect free (design §3). */
  pendingInspect?: string;

  actionStatusText: string;
  sourceActionsText?: string;

  /** Stale-reply guards (design §3 / D2 / D4): a `signatureResult`/`signatureUnavailable` whose
   * `requestId`/`targetId` no longer match the most recently issued request is discarded. */
  currentTargetId?: string;
  currentSignatureRequestId?: string;
  signatureParameters?: IntrospectionParameter[];
  signatureCached: boolean;
  signatureUnavailableReason?: string;

  pendingAction?: PendingAction;
  confirmation?: Confirmation;
  activeRun?: string;
  runOutputLines: string[];
  callResultLines: string[];
  callResult?: { result: RunResult; returnRepr?: string };

  themeColors?: Partial<Record<TokenRole, string>>;
}

export function createInitialState(): AppState {
  return {
    loadReason: "initial",
    diff: [],
    sourceIndex: {},
    edgeSources: [],
    edgeOrigins: [],
    untrackedPaths: [],
    graphSeq: 0,
    editingEnabled: false,
    diffOps: [],
    actionStatusText: "",
    signatureCached: false,
    runOutputLines: [],
    callResultLines: [],
  };
}

function sameSource(a: SourceId | undefined, b: SourceId): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function runResultLine(result: RunResult): string {
  if (result.kind === "success" || result.kind === "failure") return `${result.variant}: ${result.kind} (exit code ${result.exitCode})`;
  if (result.kind === "timeout") return `${result.variant}: timeout (after ${result.timeoutMs}ms)`;
  return `${result.variant}: ${result.kind}`;
}

/**
 * Pure `(AppState, HostToWebviewMessage) => AppState` — every case in `index.ts`'s
 * `handleHostMessage` switch (design §3) maps to a case here. DOM mutation and
 * `vscode.postMessage` side effects stay in `index.tsx`'s effects; this function only computes
 * the next state, including the stale-reply guards ported verbatim from `index.ts`.
 */
export function appReducer(state: AppState, message: HostToWebviewMessage): AppState {
  switch (message.type) {
    case "graphSummary": {
      const next: AppState = {
        ...state,
        loadReason: message.loadReason,
        selected: undefined,
        selectedPair: undefined,
        editingEnabled: false,
        graphSummary: {
          nodeCount: message.nodeCount,
          edgeCount: message.edgeCount,
          diagnosticCount: message.diagnosticCount,
          oversized: message.oversized,
          sections: message.sections ?? [],
        },
      };
      if (message.loadReason === "initial") {
        next.graph = undefined;
        next.selectedNodeId = undefined;
      }
      return next;
    }

    case "graph": {
      const next: AppState = {
        ...state,
        graph: message.graph,
        diff: message.diff,
        sourceIndex: message.sourceIndex,
        edgeSources: message.edgeSources,
        edgeOrigins: message.edgeOrigins,
        untrackedPaths: message.untrackedPaths,
        graphSeq: state.graphSeq + 1,
        pendingInspect: undefined,
      };
      // Refresh-landing re-navigation (design §3): if the previously selected node still
      // exists in the fresh snapshot, re-issue `inspectSources` for it via `pendingInspect`,
      // drained by an effect. Neither `selected` nor editing re-enables — the pre-refresh
      // SourceId is stale against this new snapshot until the user explicitly re-navigates.
      if (state.loadReason === "refresh" && state.selectedNodeId && message.sourceIndex[state.selectedNodeId]) {
        next.selectedPair = message.sourceIndex[state.selectedNodeId];
        next.pendingInspect = state.selectedNodeId;
      }
      return next;
    }

    case "sourcePair": {
      const matches = !!state.selectedPair && [state.selectedPair.left, state.selectedPair.right].some(
        (id) => id && message.sources.some((source) => sameSource(id, source.sourceId)),
      );
      if (!matches) return state;
      return { ...state, diffOps: message.ops };
    }

    case "navigateResult": {
      if (!message.ok) {
        return { ...state, actionStatusText: `Navigation refused: ${message.reason}` };
      }
      const matches = !!state.selectedPair && [state.selectedPair.left, state.selectedPair.right].some(
        (id) => sameSource(id, message.sourceId),
      );
      if (!matches) {
        return {
          ...state,
          actionStatusText: `Opened relationship at ${message.sourceId.posixPath}, bytes ${message.sourceId.startByte}–${message.sourceId.endByte}.`,
        };
      }
      return {
        ...state,
        selected: message.sourceId,
        draftContent: message.draftContent ?? message.content,
        draftSourceId: message.sourceId,
        editingEnabled: true,
        actionStatusText: `Selected ${message.sourceId.posixPath}; worktree target: ${message.sourceId.posixPath}. Only this byte span will be replaced; the rest of the captured file is preserved. External changes cause refusal.`,
      };
    }

    case "draftSaved":
      return { ...state, actionStatusText: "Draft saved (worktree unchanged)." };

    case "directWritePreview": {
      if (!state.pendingAction || state.pendingAction.type !== "confirmDirectWrite" || state.pendingAction.requestId !== message.requestId) return state;
      return { ...state, confirmation: { type: "confirmDirectWrite", requestId: message.requestId, preview: message.preview } };
    }

    case "directWriteResult": {
      if (state.pendingAction?.requestId !== message.requestId) return state;
      return {
        ...state,
        pendingAction: undefined,
        confirmation: undefined,
        actionStatusText: message.ok ? `Written: ${message.path}` : `Write refused: ${message.reason}`,
      };
    }

    case "runConfirmationRequired": {
      if (!state.pendingAction || state.pendingAction.type !== "confirmRun" || state.pendingAction.requestId !== message.requestId) return state;
      return { ...state, confirmation: { type: "confirmRun", requestId: message.requestId, variants: message.variants, sources: message.sources } };
    }

    case "runEvent": {
      if (message.requestId === state.activeRun) {
        return { ...state, runOutputLines: [...state.runOutputLines, `[${message.seq} ${message.variant} ${message.channel}] ${message.data}`] };
      }
      if (state.pendingAction?.type === "confirmCall" && state.pendingAction.requestId === message.requestId) {
        return { ...state, callResultLines: [...state.callResultLines, `[${message.seq} ${message.channel}] ${message.data}`] };
      }
      return state;
    }

    case "runResult": {
      if (message.requestId !== state.activeRun) return state;
      return {
        ...state,
        runOutputLines: [...state.runOutputLines, message.results.map(runResultLine).join("\n")],
        activeRun: undefined,
        pendingAction: undefined,
        confirmation: undefined,
      };
    }

    case "runFailed": {
      if (message.requestId !== state.activeRun) return state;
      return {
        ...state,
        runOutputLines: [...state.runOutputLines, `Run failed: ${message.reason}`],
        activeRun: undefined,
        pendingAction: undefined,
        confirmation: undefined,
      };
    }

    case "error":
      return { ...state, actionStatusText: `Error: ${message.message}` };

    case "refreshResult":
      return { ...state, actionStatusText: message.ok ? "Refreshed." : `Refresh refused: ${message.reason}` };

    case "refreshDeferred":
      return { ...state, actionStatusText: `Auto-refresh deferred: ${message.reason}` };

    case "signatureResult": {
      if (message.requestId !== state.currentSignatureRequestId || message.targetId !== state.currentTargetId) return state;
      return { ...state, signatureParameters: message.parameters, signatureCached: message.cached, signatureUnavailableReason: undefined };
    }

    case "signatureUnavailable": {
      if (message.requestId !== state.currentSignatureRequestId || message.targetId !== state.currentTargetId) return state;
      return { ...state, signatureUnavailableReason: message.reason, signatureParameters: undefined };
    }

    case "callConfirmationRequired": {
      if (!state.pendingAction || state.pendingAction.type !== "confirmCall" || state.pendingAction.requestId !== message.requestId) return state;
      return { ...state, confirmation: { type: "confirmCall", requestId: message.requestId, dottedName: message.dottedName, argsPreview: message.argsPreview } };
    }

    case "callResult": {
      return {
        ...state,
        pendingAction: undefined,
        confirmation: undefined,
        callResult: { result: message.result, returnRepr: message.returnRepr },
      };
    }

    case "themeTokens":
      return { ...state, themeColors: message.colors };

    default:
      return state;
  }
}
