import type { AnalysisGraph, Edge, Entity, SourceId } from "./protocol.js";
import type { EdgeVintage } from "../webview/graphView.js";
import type { SnapshotStore } from "./snapshots/snapshotStore.js";
import type { CorrelatedDiffEntry } from "./navigation/sourceProvider.js";
import { computeContentHash, createSourceId, resolveSource, StaleSourceError } from "./navigation/sourceProvider.js";
import type { DraftStore } from "./editing/draftStore.js";
import type { DirectWriteRequest, WriteEffectPreview, WriteReceipt } from "./editing/writeGuard.js";
import { WriteConfirmationDeclinedError, WriteGuardError } from "./editing/writeGuard.js";
import type { RunOptions, RunResult, SnippetSource, SnippetVariant } from "./execution/dockerRunner.js";
import { isOversized, webviewToHostMessageSchema } from "./webviewProtocol.js";
import { filterGraph, suppressAncestorSelfReferences, type GraphFilter } from "../webview/graphView.js";
import type { HostToWebviewMessage } from "./webviewProtocol.js";
import { diffLines } from "./diff/lineDiff.js";

/**
 * Builds a single display graph out of up-to-two comparison sides for the webview to
 * render. This merge is display-only: `webview/graphView.ts`'s change-status colouring and
 * `correlateDiff`'s entity pairing remain the sole authority for what changed - this
 * function only decides which single node/edge representation to show per qualified name
 * so both sides can be rendered together, preferring the right (current) side's shape.
 */
export function mergeGraphsForDisplay(left: AnalysisGraph | undefined, right: AnalysisGraph | undefined): AnalysisGraph {
  const snapshot = right?.snapshot ?? left?.snapshot;
  if (!snapshot) throw new Error("At least one comparison side is required to build a display graph");
  const byQualifiedName = new Map<string, Entity>();
  for (const node of left?.nodes ?? []) byQualifiedName.set(node.qualifiedName, node);
  for (const node of right?.nodes ?? []) byQualifiedName.set(node.qualifiedName, node);
  const byEdgeKey = new Map<string, Edge>();
  for (const edge of [...(left?.edges ?? []), ...(right?.edges ?? [])]) byEdgeKey.set(edgeKey(edge), edge);
  return {
    snapshot,
    nodes: [...byQualifiedName.values()],
    edges: [...byEdgeKey.values()],
    diagnostics: [...(left?.diagnostics ?? []), ...(right?.diagnostics ?? [])],
  };
}

function edgeKey(edge: Edge): string {
  return `${edge.kind}:${edge.source}:${edge.span.path}:${edge.span.startByte}:${edge.span.endByte}`;
}

function buildSourceIndex(
  store: SnapshotStore,
  left: AnalysisGraph | undefined,
  right: AnalysisGraph | undefined,
): Record<string, { left?: SourceId; right?: SourceId }> {
  const index: Record<string, { left?: SourceId; right?: SourceId }> = {};
  for (const node of mergeGraphsForDisplay(left, right).nodes) {
    const sides: { left?: SourceId; right?: SourceId } = {};
    for (const side of ["left", "right"] as const) {
      const graph = side === "left" ? left : right;
      const entity = graph?.nodes.find(candidate => candidate.qualifiedName === node.qualifiedName);
      if (!graph || !entity) continue;
      const content = store.getFileContent(graph.snapshot, entity.span.path);
      if (content !== undefined) sides[side] = createSourceId(graph.snapshot, entity.span.path, content, entity.span.startByte, entity.span.endByte);
    }
    index[node.id] = sides;
  }
  return index;
}

/**
 * Selects the snapshot owning each displayed relationship location. This deliberately
 * mirrors `mergeGraphsForDisplay`: a matching current/right edge wins; a left/original
 * edge is used only when the relationship exists on that side alone. No endpoint span is
 * substituted when the recorded edge span cannot be resolved.
 */
function buildEdgeSourceIndex(
  store: SnapshotStore,
  left: AnalysisGraph | undefined,
  right: AnalysisGraph | undefined,
  graph: AnalysisGraph,
): ({ sourceId: SourceId; side: "left" | "right" } | undefined)[] {
  return graph.edges.map((displayed) => {
    const rightEdge = right?.edges.find(candidate => edgeKey(candidate) === edgeKey(displayed));
    const leftEdge = left?.edges.find(candidate => edgeKey(candidate) === edgeKey(displayed));
    const edge = rightEdge ?? leftEdge;
    const side = rightEdge ? "right" : leftEdge ? "left" : undefined;
    const snapshot = rightEdge ? right?.snapshot : leftEdge ? left?.snapshot : undefined;
    if (!edge || !side || !snapshot) return undefined;
    const content = store.getFileContent(snapshot, edge.span.path);
    if (content === undefined) return undefined;
    return { side, sourceId: createSourceId(snapshot, edge.span.path, content, edge.span.startByte, edge.span.endByte) };
  });
}

/**
 * Derives each displayed edge's vintage by comparing its identity key against the left
 * (original) and right (worktree) comparison sides independently — pure key comparison, so
 * it is correct even when `store.getFileContent` fails for that edge's file (success
 * criterion 7). Index-aligned with `graph.edges`, mirroring `buildEdgeSourceIndex`'s
 * convention. "current" when the right side has the key, or the edge's `span.path` is
 * untracked; otherwise "removed" (present-on-both-sides therefore collapses to "current").
 */
export function buildEdgeVintages(
  left: AnalysisGraph | undefined,
  right: AnalysisGraph | undefined,
  graph: AnalysisGraph,
  untrackedPaths: readonly string[],
): EdgeVintage[] {
  const rightKeys = new Set((right?.edges ?? []).map(edgeKey));
  return graph.edges.map((edge) => (rightKeys.has(edgeKey(edge)) || untrackedPaths.includes(edge.span.path) ? "current" : "removed"));
}

/** Applied when a `requestGraphView` message omits `vintages` or it is explicitly empty:
 * ghost/removed edges stay hidden until the user opts in (success criterion 4). */
const DEFAULT_VINTAGES: EdgeVintage[] = ["current"];

export interface SessionDeps {
  /** Resolved by the extension host, never supplied by a webview message. */
  repoRoot: string;
  store: SnapshotStore;
  draftStore: DraftStore;
  post: (message: HostToWebviewMessage) => void;
  /** Opens the resolved content at an exact, revalidated source location. Never called for a stale/unresolved source. */
  openSource: (sourceId: SourceId, side: "left" | "right", content: string) => void | Promise<void>;
  performWrite: (request: DirectWriteRequest) => Promise<WriteReceipt>;
  runSnippet: (source: SnippetSource, options?: RunOptions) => Promise<RunResult>;
  /**
   * Re-runs capture/diff/analysis for the panel's original selection and re-loads the
   * result. Absent when the session is constructed without refresh support (e.g. a stale
   * test double); the `requestRefresh` intent then always refuses rather than fabricating
   * a success.
   */
  requestRefresh?: () => Promise<void>;
  /** Invoked whenever the session transitions from busy to idle, so a queued auto-refresh can re-fire. */
  onIdle?: () => void;
}

/**
 * Host-side orchestration for one webview panel. Owns every trust boundary the design
 * requires the extension host (not the webview) to hold: validating every inbound
 * message, resolving sources with `StaleSourceError` refusal semantics, requiring an
 * explicit round-tripped confirmation before an oversized render, a direct write, or a
 * Docker run, and never fabricating a result for a declined or failed action.
 */
export class ChangeMapSession {
  private left: AnalysisGraph | undefined;
  private right: AnalysisGraph | undefined;
  private diff: CorrelatedDiffEntry[] = [];
  private sourceIndex: Record<string, { left?: SourceId; right?: SourceId }> = {};
  private activeSources: Partial<Record<SnippetVariant, SnippetSource>> = {};
  private selectedSource: SourceId | undefined;
  private readonly usedRequestIds = new Set<string>();
  private readonly pendingWriteConfirmations = new Map<string, (confirmed: boolean) => void>();
  private readonly pendingRunConfirmations = new Map<string, (confirmed: boolean) => void>();
  private readonly activeRuns = new Map<string, AbortController>();

  private untrackedPaths: string[] = [];

  constructor(private readonly deps: SessionDeps) {}

  /** True while a write confirmation, a run confirmation, or an active run is outstanding. */
  isBusy(): boolean {
    return this.pendingWriteConfirmations.size > 0 || this.pendingRunConfirmations.size > 0 || this.activeRuns.size > 0;
  }

  /** Posts a `refreshDeferred` notification (auto-refresh queued rather than dropped while busy). */
  notifyRefreshDeferred(reason: string): void {
    this.deps.post({ type: "refreshDeferred", reason });
  }

  /** Computes the comparison summary/graph and posts it, gating the full render on explicit oversized consent. */
  loadComparison(
    left: AnalysisGraph | undefined,
    right: AnalysisGraph | undefined,
    diff: CorrelatedDiffEntry[],
    options: { untrackedPaths?: string[]; loadReason?: "initial" | "refresh" } = {},
  ): void {
    const loadReason = options.loadReason ?? "initial";
    this.activeSources = {};
    this.selectedSource = undefined;
    this.left = left;
    this.right = right;
    this.diff = diff;
    this.untrackedPaths = options.untrackedPaths ?? [];
    const display = suppressAncestorSelfReferences(mergeGraphsForDisplay(left, right));
    this.sourceIndex = buildSourceIndex(this.deps.store, left, right);
    const oversized = isOversized(display);
    this.deps.post({
      type: "graphSummary",
      nodeCount: display.nodes.length,
      edgeCount: display.edges.length,
      diagnosticCount: display.diagnostics.length,
      oversized,
      sections: display.nodes.map(node => ({ id: node.id, label: node.qualifiedName })),
      loadReason,
    });
    if (!oversized) this.sendGraph();
  }

  private sendGraph(filter?: GraphFilter): void {
    const suppressed = suppressAncestorSelfReferences(mergeGraphsForDisplay(this.left, this.right));
    const edgeVintages = buildEdgeVintages(this.left, this.right, suppressed, this.untrackedPaths);
    const effectiveFilter: GraphFilter = { ...filter, vintages: filter?.vintages ?? DEFAULT_VINTAGES };
    const display = filterGraph(suppressed, this.diff, effectiveFilter, edgeVintages);
    if (filter && isOversized(display)) {
      this.deps.post({ type: "error", message: "Filtered map is still oversized. Choose a smaller section or explicitly render the full map." });
      return;
    }
    this.deps.post({
      type: "graph",
      graph: display,
      diff: this.diff,
      sourceIndex: this.sourceIndex,
      edgeSources: buildEdgeSourceIndex(this.deps.store, this.left, this.right, display),
      edgeOrigins: buildEdgeVintages(this.left, this.right, display, this.untrackedPaths),
      untrackedPaths: this.untrackedPaths,
    });
  }

  /** Records which snippet source backs each variant for the currently selected comparison item, ahead of any run request. */
  setActiveSources(sources: Partial<Record<SnippetVariant, SnippetSource>>): void {
    this.activeSources = sources;
  }

  /** Validates and dispatches one inbound webview message. Malformed input is reported, never guessed at. */
  async handleIntent(raw: unknown): Promise<void> {
    const parsed = webviewToHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.post({ type: "error", message: `Rejected malformed webview message: ${parsed.error.message}` });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ready":
        if (this.left || this.right) this.loadComparison(this.left, this.right, this.diff);
        return;
      case "confirmOversized":
        if (message.confirmed) this.sendGraph();
        return;
      case "requestGraphView":
        this.sendGraph(message);
        return;
      case "requestSnippetWrite": {
        try {
          resolveSource(this.deps.store, message.sourceId);
          const full = this.deps.store.getFileContent(message.sourceId.snapshot, message.sourceId.posixPath)!;
          const bytes = Buffer.from(full, "utf8");
          const replacement = bytes.subarray(0, message.sourceId.startByte).toString("utf8") + message.content + bytes.subarray(message.sourceId.endByte).toString("utf8");
          await this.handleRequestDirectWrite({ requestId: message.requestId, repoRoot: this.deps.repoRoot, targetPath: message.sourceId.posixPath, baseHash: computeContentHash(full), replacement });
        } catch (error) {
          this.deps.post({ type: "directWriteResult", requestId: message.requestId, ok: false, reason: String(error) });
        }
        return;
      }
      case "inspectSources": {
        const entry = this.sourceIndex[message.nodeId];
        const sources: { side: "left" | "right"; sourceId: SourceId; content: string; startLine: number; endLine: number }[] = [];
        for (const side of ["left", "right"] as const) {
          const sourceId = entry?.[side];
          if (sourceId) {
            const content = resolveSource(this.deps.store, sourceId);
            const full = this.deps.store.getFileContent(sourceId.snapshot, sourceId.posixPath)!;
            const startLine = Buffer.from(full).subarray(0, sourceId.startByte).toString("utf8").split("\n").length;
            sources.push({ side, sourceId, content, startLine, endLine: startLine + content.split("\n").length - 1 });
          }
        }
        const left = sources.find(source => source.side === "left");
        const right = sources.find(source => source.side === "right");
        const ops = diffLines(left?.content ?? "", right?.content ?? "", { leftStartLine: left?.startLine ?? 1, rightStartLine: right?.startLine ?? 1 });
        this.deps.post({ type: "sourcePair", sources, ops });
        return;
      }
      case "navigate":
        await this.handleNavigate(message.sourceId, message.side);
        return;
      case "saveDraft":
        this.handleSaveDraft(message.sourceId, message.content);
        return;
      case "requestDirectWrite":
        await this.handleRequestDirectWrite(message);
        return;
      case "confirmDirectWrite":
        this.pendingWriteConfirmations.get(message.requestId)?.(message.confirmed);
        this.pendingWriteConfirmations.delete(message.requestId);
        this.notifyIfIdle();
        return;
      case "requestRun":
        this.handleRequestRun(message.requestId, message.variants);
        return;
      case "confirmRun":
        this.pendingRunConfirmations.get(message.requestId)?.(message.confirmed);
        this.pendingRunConfirmations.delete(message.requestId);
        return;
      case "cancelRun":
        this.activeRuns.get(message.requestId)?.abort();
        return;
      case "requestRefresh":
        await this.handleRequestRefresh(message.requestId);
        return;
    }
  }

  /**
   * Manual refresh is refused (never queued) while busy, naming the pending action, because
   * an explicit user action deserves immediate feedback rather than silent latency (Decision
   * 7). Absent `deps.requestRefresh`, the intent always refuses rather than fabricating a
   * success.
   */
  private async handleRequestRefresh(requestId: string): Promise<void> {
    if (!this.deps.requestRefresh) {
      this.deps.post({ type: "refreshResult", requestId, ok: false, reason: "Refresh is not available for this panel." });
      return;
    }
    if (this.isBusy()) {
      this.deps.post({ type: "refreshResult", requestId, ok: false, reason: this.describeBusy() });
      return;
    }
    try {
      await this.deps.requestRefresh();
      this.deps.post({ type: "refreshResult", requestId, ok: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.post({ type: "refreshResult", requestId, ok: false, reason });
    }
  }

  private describeBusy(): string {
    if (this.pendingWriteConfirmations.size > 0) return "A write confirmation is pending.";
    if (this.pendingRunConfirmations.size > 0) return "A run confirmation is pending.";
    return "A Docker run is active.";
  }

  /** Fires `deps.onIdle` exactly when the session transitions from busy to idle. */
  private notifyIfIdle(): void {
    if (!this.isBusy()) this.deps.onIdle?.();
  }

  private async handleNavigate(sourceId: SourceId, side: "left" | "right"): Promise<void> {
    try {
      const content = resolveSource(this.deps.store, sourceId);
      await this.deps.openSource(sourceId, side, content);
      this.selectSource(sourceId);
      this.deps.post({ type: "navigateResult", ok: true, sourceId, content, draftContent: this.deps.draftStore.get(sourceId)?.content });
    } catch (error) {
      if (error instanceof StaleSourceError) {
        this.deps.post({ type: "navigateResult", ok: false, sourceId, reason: error.message });
        return;
      }
      throw error;
    }
  }

  private handleSaveDraft(sourceId: SourceId, content: string): void {
    try {
      const draft = this.deps.draftStore.save(this.deps.store, sourceId, content);
      if (this.selectedSource && sameSource(this.selectedSource, sourceId)) this.activeSources.draft = { variant: "draft", path: sourceId.posixPath, content: draft.content };
      this.deps.post({ type: "draftSaved", sourceId, content: draft.content });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.post({ type: "error", message: `Draft save refused: ${reason}` });
    }
  }

  private async handleRequestDirectWrite(message: {
    requestId: string;
    repoRoot: string;
    targetPath: string;
    baseHash: string;
    replacement: string;
  }): Promise<void> {
    const { requestId } = message;
    if (!this.claimRequest(requestId)) return;
    const confirm = (preview: WriteEffectPreview): Promise<boolean> => {
      return new Promise<boolean>((resolveConfirm) => {
        this.pendingWriteConfirmations.set(requestId, resolveConfirm);
        this.deps.post({ type: "directWritePreview", requestId, preview });
      });
    };
    try {
      const receipt = await this.deps.performWrite({
        repoRoot: this.deps.repoRoot,
        targetPath: message.targetPath,
        baseHash: message.baseHash,
        replacement: message.replacement,
        confirm,
      });
      this.deps.post({ type: "directWriteResult", requestId, ok: true, path: receipt.path });
    } catch (error) {
      this.pendingWriteConfirmations.delete(requestId);
      const reason =
        error instanceof WriteConfirmationDeclinedError || error instanceof WriteGuardError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      this.deps.post({ type: "directWriteResult", requestId, ok: false, reason });
      this.notifyIfIdle();
    }
  }

  private claimRequest(requestId: string): boolean {
    if (this.usedRequestIds.has(requestId)) {
      this.deps.post({ type: "error", message: `Duplicate request ID: ${requestId}` });
      return false;
    }
    this.usedRequestIds.add(requestId);
    return true;
  }

  private selectSource(sourceId: SourceId): void {
    this.selectedSource = sourceId;
    const entry = Object.values(this.sourceIndex).find(sides => [sides.left, sides.right].some(id => id && sameSource(id, sourceId)));
    this.activeSources = {};
    if (!entry) return;
    for (const [variant, id] of [["original", entry.left], ["current", entry.right]] as const) {
      if (id) this.activeSources[variant] = { variant, path: id.posixPath, content: resolveSource(this.deps.store, id) };
    }
    const draft = this.deps.draftStore.get(sourceId);
    if (draft) this.activeSources.draft = { variant: "draft", path: sourceId.posixPath, content: draft.content };
  }

  private handleRequestRun(requestId: string, variants: SnippetVariant[]): void {
    if (!this.claimRequest(requestId)) return;
    const sources = structuredClone(this.activeSources);
    const confirmed = new Promise<boolean>((resolveConfirm) => {
      this.pendingRunConfirmations.set(requestId, resolveConfirm);
      this.deps.post({ type: "runConfirmationRequired", requestId, variants, sources: variants.map(variant => ({ variant, path: sources[variant]?.path, content: sources[variant]?.content })) });
    });
    // Fire-and-forget: the caller learns the outcome exclusively through posted messages
    // (`runEvent`/`runResult`/`error`), matching every other asynchronous intent here.
    void confirmed.then(async (isConfirmed) => {
      if (!isConfirmed) {
        this.deps.post({ type: "error", message: `Run declined for request ${requestId}` });
        this.notifyIfIdle();
        return;
      }
      await this.executeRun(requestId, variants, sources);
    });
  }

  private async executeRun(requestId: string, variants: SnippetVariant[], sources: Partial<Record<SnippetVariant, SnippetSource>>): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(requestId, controller);
    const orderedVariants: SnippetVariant[] = ["original", "current", "draft"];
    const results: RunResult[] = [];
    let seq = 0;
    const emit = (variant: SnippetVariant, channel: "stdout" | "stderr" | "status", data: string): void => {
      this.deps.post({ type: "runEvent", requestId, variant, seq: seq++, channel, data });
    };
    try {
      for (const variant of orderedVariants) {
        if (!variants.includes(variant)) continue;
        emit(variant, "status", "started");
        const source = sources[variant];
        const streamed = new Set<string>();
        const result: RunResult = source
          ? controller.signal.aborted ? { variant, kind: "cancelled", stdout: "", stderr: "" } : await this.deps.runSnippet(source, { signal: controller.signal, onOutput: (channel, data) => { streamed.add(channel); emit(variant, channel, data); } })
          : { variant, kind: "unavailable" };
        if (result.kind !== "unavailable") {
          if (result.stdout && !streamed.has("stdout")) emit(variant, "stdout", result.stdout);
          if (result.stderr && !streamed.has("stderr")) emit(variant, "stderr", result.stderr);
        }
        emit(variant, "status", result.kind);
        results.push(result);
      }
      this.deps.post({ type: "runResult", requestId, results });
    } catch (error) {
      this.deps.post({ type: "runFailed", requestId, reason: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error) });
    } finally {
      this.activeRuns.delete(requestId);
      this.notifyIfIdle();
    }
  }
}

function sameSource(a: SourceId, b: SourceId): boolean {
  return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot) && a.posixPath === b.posixPath && a.startByte === b.startByte && a.endByte === b.endByte && a.contentHash === b.contentHash;
}
