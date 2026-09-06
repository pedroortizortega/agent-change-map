import { analyzePython } from "./analysis/pythonAnalyzer.js";
import { defaultSourceFileMatcher, type SourceFileMatcher } from "./analysis/sourceFileMatcher.js";
import { captureGitState, type GitSelection } from "./git/gitService.js";
import { SnapshotStore, diffSnapshots } from "./snapshots/snapshotStore.js";
import { correlateDiff } from "./navigation/sourceProvider.js";
import type { ChangeMapSession } from "./webviewHost.js";
import type { AnalysisGraph } from "./protocol.js";

export interface ComparisonControllerDeps {
  extensionRoot: string;
  repoRoot: string;
  references: { left: GitSelection; right: GitSelection };
  store: SnapshotStore;
  session: ChangeMapSession;
  matcher?: SourceFileMatcher;
}

/**
 * Owns the references/repoRoot/extensionRoot/store/session for one open comparison panel
 * and exposes a single `capture()` used by both the initial load and a manual refresh.
 */
export class ComparisonController {
  private readonly matcher: SourceFileMatcher;

  constructor(private readonly deps: ComparisonControllerDeps) {
    this.matcher = deps.matcher ?? defaultSourceFileMatcher;
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

  dispose(): void {
    // No resources held yet; a future auto-refresh watcher disposes itself here.
  }

  private async buildGraphForSelection(selection: GitSelection): Promise<AnalysisGraph> {
    const state = await captureGitState(this.deps.repoRoot, selection, this.matcher);
    this.deps.store.store(state);
    const files = state.files.length > 0 ? state.files.map(file => ({ path: file.path, content: file.content })) : [{ path: "__empty__.py", content: "" }];
    return analyzePython({ type: "analyze", snapshot: state.snapshot, files }, this.deps.extensionRoot);
  }
}
