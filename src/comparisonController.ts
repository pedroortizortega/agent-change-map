import { analyzePython } from "./analysis/pythonAnalyzer.js";
import { defaultSourceFileMatcher, type SourceFileMatcher } from "./analysis/sourceFileMatcher.js";
import { captureGitState, type GitSelection } from "./git/gitService.js";
import { SnapshotStore, diffSnapshots } from "./snapshots/snapshotStore.js";
import { correlateDiff } from "./navigation/sourceProvider.js";
import type { ChangeMapSession } from "./webviewHost.js";
import type { AnalysisGraph } from "./protocol.js";

const DEFAULT_AUTO_REFRESH_DEBOUNCE_MS = 750;

/** A disposable handle for a filesystem watcher or configuration subscription. */
export interface FileWatcherHandle {
  dispose(): void;
}

export interface ComparisonControllerDeps {
  extensionRoot: string;
  repoRoot: string;
  references: { left: GitSelection; right: GitSelection };
  store: SnapshotStore;
  session: ChangeMapSession;
  matcher?: SourceFileMatcher;
  /** Reads whether `agentChangeMap.autoRefresh` is currently enabled. Defaults to always-false (no watcher). */
  isAutoRefreshEnabled?: () => boolean;
  /**
   * Creates a filesystem watcher rooted at the given worktree path, invoking `onChange`
   * with each changed path (any create/change/delete event) under it. The extension host
   * supplies the real `vscode.FileSystemWatcher`-backed implementation
   * (`RelativePattern(worktree, "**\/*")`); this controller stays free of a runtime `vscode`
   * import so it can be unit tested directly.
   */
  createWatcher?: (worktreePath: string, onChange: (posixPath: string) => void) => FileWatcherHandle;
  /** Subscribes to `agentChangeMap.autoRefresh` configuration changes so the watcher can be recreated/disposed. */
  onAutoRefreshConfigChange?: (callback: () => void) => FileWatcherHandle;
  /** Debounce delay override for tests, in milliseconds. Defaults to 750ms. */
  debounceMs?: number;
}

/**
 * Owns the references/repoRoot/extensionRoot/store/session for one open comparison panel
 * and exposes a single `capture()` used by both the initial load and a refresh, plus an
 * opt-in auto-refresh watcher gated by `agentChangeMap.autoRefresh` and the session's busy
 * state (Decision 6/7).
 */
export class ComparisonController {
  private readonly matcher: SourceFileMatcher;
  private watcher: FileWatcherHandle | undefined;
  private configSubscription: FileWatcherHandle | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;

  constructor(private readonly deps: ComparisonControllerDeps) {
    this.matcher = deps.matcher ?? defaultSourceFileMatcher;
    this.configSubscription = deps.onAutoRefreshConfigChange?.(() => this.reconcileWatcher());
    this.reconcileWatcher();
  }

  /** Runs capture, diff, and analysis for both comparison sides and loads the result. */
  async capture(loadReason: "initial" | "refresh" = "initial"): Promise<void> {
    const [leftGraph, rightGraph] = await Promise.all([
      this.buildGraphForSelection(this.deps.references.left),
      this.buildGraphForSelection(this.deps.references.right),
    ]);
    const leftState = this.deps.store.get(leftGraph.snapshot);
    const rightState = this.deps.store.get(rightGraph.snapshot);
    if (!leftState || !rightState) throw new Error("Captured comparison state was unexpectedly not stored.");
    const diff = diffSnapshots(leftState, rightState);
    const correlated = correlateDiff(diff, leftGraph, rightGraph);
    const untrackedPaths = rightState.files.filter(file => file.provenance === "untracked").map(file => file.path);
    this.deps.session.loadComparison(leftGraph, rightGraph, correlated, { untrackedPaths, loadReason });
  }

  /** Re-runs `capture()` for the original selection. Used by the manual `requestRefresh` intent. */
  async requestRefresh(): Promise<void> {
    await this.capture("refresh");
  }

  /** Invoked when the session transitions from busy to idle; re-fires a queued auto-refresh exactly once. */
  onIdle(): void {
    if (!this.queued) return;
    this.queued = false;
    this.armDebounce();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.dispose();
    this.configSubscription?.dispose();
  }

  private async buildGraphForSelection(selection: GitSelection): Promise<AnalysisGraph> {
    const state = await captureGitState(this.deps.repoRoot, selection, this.matcher);
    this.deps.store.store(state);
    const files = state.files.length > 0 ? state.files.map(file => ({ path: file.path, content: file.content })) : [{ path: "__empty__.py", content: "" }];
    return analyzePython({ type: "analyze", snapshot: state.snapshot, files }, this.deps.extensionRoot);
  }

  private reconcileWatcher(): void {
    const enabled = this.deps.isAutoRefreshEnabled?.() ?? false;
    const worktreePath = this.deps.references.right.kind === "worktree" ? this.deps.references.right.path : undefined;
    const shouldWatch = enabled && worktreePath !== undefined && !!this.deps.createWatcher;
    if (!shouldWatch) {
      this.watcher?.dispose();
      this.watcher = undefined;
      return;
    }
    if (this.watcher) return;
    this.watcher = this.deps.createWatcher!(worktreePath!, (posixPath) => this.onWatchedPathChanged(posixPath));
  }

  private onWatchedPathChanged(posixPath: string): void {
    if (!this.matcher.matches(posixPath)) return;
    this.armDebounce();
  }

  /** 750ms (default) debounce so N coalesced watcher events schedule exactly one capture attempt. */
  private armDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.fireAutoRefresh();
    }, this.deps.debounceMs ?? DEFAULT_AUTO_REFRESH_DEBOUNCE_MS);
  }

  private fireAutoRefresh(): void {
    if (this.deps.session.isBusy()) {
      this.queued = true;
      this.deps.session.notifyRefreshDeferred("Auto-refresh deferred: a write/run confirmation is pending or a Docker run is active.");
      return;
    }
    void this.requestRefresh();
  }
}
