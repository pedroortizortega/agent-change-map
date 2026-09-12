# Exploration: untracked-files-live-refresh-and-styling

## Scope

Three usability improvements requested after hands-on testing of the Agent Change Map extension:

1. Capture untracked (never `git add`ed) new files in worktree comparisons.
2. A way to refresh the panel without closing and reopening it.
3. More polished, CodeViz-inspired boxes and arrows in the change-map graph.

## Request 1 — Capture untracked new files

**Current state**: worktree capture (`beginWorktreeCapture`/`finishWorktreeCapture` in `src/git/gitService.ts`) sources its file list exclusively from `listTrackedPaths` (`git ls-files -s`). A file that was never `git add`ed is invisible end-to-end — the user has to stage it before the extension notices it exists. Commit-side capture (`captureCommitState`, `git ls-tree` on a fixed oid) is unaffected by definition — this is a worktree-only concern. `buildGraphForSelection` already filters captured files to `.py` before analysis, so a non-`.py` untracked file capturing successfully would have the same (currently silent) no-op outcome as a non-`.py` tracked file does today.

Existing safety guards (`assertWithinCaptureLimits`, `assertContentWithinSizeLimit`, `decodeUtf8OrThrow`/`GitBinaryContentError`) are path/content-based and generalize cleanly to untracked files with no new mechanism needed. The one real gap: the stability fingerprint (`statusFingerprint`, run today with `--untracked-files=no`) currently ignores untracked files entirely, so a new untracked file appearing or being edited mid-capture would not be caught by the existing instability detection the way a tracked file's mid-capture edit is.

**Recommendation**: merge untracked-but-not-ignored paths (`git ls-files --others --exclude-standard`) into the same path list used for tracked files, with no extension filter (consistent with how tracked files are already captured regardless of extension), and switch `statusFingerprint` to `--untracked-files=all` so new/removed untracked files are covered by the same mid-capture instability detection tracked files already get.

## Request 2 — Refresh without closing/reopening the panel

**Current state**: the whole comparison (`buildGraphForSelection` for both sides, `diffSnapshots`, `correlateDiff`) runs exactly once, at the moment the `agentChangeMap.compare` command is invoked. `references`/`repoRoot`/`context.extensionPath` are local variables inside that command's closure in `src/extension.ts`, never stored anywhere a later webview message could reach. `ChangeMapSession` has no recapture logic today — the `"ready"` intent only re-renders whatever was already captured. `SnapshotStore` is an unbounded `Map`; repeated recapture of an edited worktree would accumulate entries with no eviction. The project's README is consistently built around explicit user action gating disruptive/state-changing operations (draft edits stay isolated until a deliberate direct-worktree write; snippet execution is opt-in) — nothing today happens automatically from filesystem activity.

**Options**:

1. **Manual refresh button** — a new `requestRefresh` webview→host message re-runs the same capture/diff/correlate pipeline for the panel's original selection and reloads the graph. Matches the existing explicit-action safety posture exactly; no debounce/race engineering needed.
2. **Automatic refresh via a filesystem watcher** (`vscode.workspace.createFileSystemWatcher` or `onDidSaveTextDocument`, debounced) — no extra clicks, but sits in tension with the project's explicit-action philosophy, and could land mid-edit, mid-Docker-run, or underneath an open write-confirmation dialog, with no current plan for preserving diff-panel collapse state or an unsaved draft across an auto-landed reload.
3. **Both** — manual button always on, auto-refresh as an explicit, off-by-default opt-in toggle.

**Recommendation**: ship the manual refresh button as the default (Option 1); treat auto-refresh as an explicitly-requested, off-by-default follow-on if the user wants it (Option 3's shape), consistent with the README's existing "opt-in" language elsewhere. Either way, `references`/`repoRoot` need to move off the command closure onto a reachable object (`ChangeMapSession` or a sibling), and `SnapshotStore` needs bounding/eviction — unbounded growth affects manual refresh too, not only auto-refresh.

## Request 3 — More polished boxes and arrows (CodeViz-inspired)

**Current state**: the graph (just rewritten in the archived `diff-view-and-graph-styling` change) is a nested-containment SVG with kind-encoded dashed/solid outline-only rects and elbow-routed `<path>` edges with triangular `<marker>` arrowheads. The strict CSP (`buildCspMetaTag`) forbids remote resources but does not block same-document `<filter>`/`<defs>` or local CSS — no CSP obstacle to SVG filters or gradients defined inline. Colors are hardcoded hex in `webview/styles.css`, not CSS custom properties. SVG `<text>` sets only `fill`, not `font-family` — SVG text does not inherit HTML `font-family` from ancestors, so this is likely an existing, unnoticed typography bug rather than something new to introduce. `function` and `method` currently share an identical stroke-width/corner-radius pair — visually indistinguishable from each other today, which the prior change's own acceptance criteria required to be distinct.

**Concrete upgrade options** (within the constraints already locked in by the prior change: attribute contract, outline-only, dash-for-containers/solid-for-entities, arrowhead-at-destination convention, strict CSP):

1. Smoother edge routing — cubic/quadratic Bezier paths instead of the current sharp right-angle elbow, compatible with the existing `marker-end` setup.
2. Node polish — actually distinguish `function` from `method`'s stroke encoding (currently identical), add an explicit `font-family` to SVG `<text>` (likely a real fix, not just polish), and tune padding.
3. Subtle SVG `<filter>` drop-shadow/glow, CSP-compliant via a local `url(#id)` reference — recommended for hover/selected state only, not always-on, since `feGaussianBlur` applied across every node risks paint cost at the existing 60-node nested-layout scale.
4. Arrowhead refinement — a pure `d`-attribute change to the two existing marker paths, zero structural impact.
5. Hover/selected visual affordances, since nodes are already clickable — needs confirming whether `webview/index.ts` already toggles any selection class today.

**Recommendation**: prioritize Bezier edges, the function/method distinction fix, and the `font-family` fix as the core pass (low risk, high visual impact); treat the drop-shadow/glow and hover affordances as an optional follow-on given the added performance-verification and DOM-wiring work. Introducing CSS custom properties for the currently-hardcoded colors is a good, separable, strictly-additive companion improvement worth bundling in.

## Test-coverage impact (Strict TDD)

- Request 1: new cases in `test/integration/gitState.test.ts` for capturing a wholly untracked file, an untracked file appearing/disappearing mid-capture (instability detection under `--untracked-files=all`), and confirming commit-state capture is unaffected.
- Request 2: new cases in `test/unit/webviewHost.test.ts`/`test/unit/webviewProtocol.test.ts` for the `requestRefresh` message and session-level recapture; a `SnapshotStore` eviction/bounding test; `test/e2e/scenarios.ts` coverage for the end-to-end refresh flow.
- Request 3: `test/unit/graphView.test.ts` cases for the new edge path shape, the function-vs-method stroke distinction, and (if included) hover/selected class toggling.

## Risks

- Request 1: switching `statusFingerprint` to `--untracked-files=all` changes what "stable" means for every existing worktree-capture test — must verify no current instability-detection test implicitly depends on untracked noise being excluded.
- Request 1: untracked-file capture makes it more likely a symlink (mode `120000`, not currently filtered the way gitlinks are) surfaces in practice; worth flagging even if fixing it isn't bundled into this change.
- Request 2: `SnapshotStore`'s unbounded growth must be addressed regardless of which refresh option ships, or repeated refreshes create a slow memory leak for long-lived panels.
- Request 2: the interaction between a refresh and an open write/run confirmation dialog is undecided and must be resolved before implementation — silently invalidating a pending confirmation would violate the project's "never act silently" posture.
- Request 3: an always-on glow/shadow filter risks paint-performance regressions before the existing 60-node flat-degradation threshold even kicks in.

## Ready for proposal

Yes, carrying four open questions into the proposal for explicit user confirmation:

1. Request 1 scope: all non-ignored untracked files (recommended) vs. `.py`-only at the capture layer.
2. Request 1 policy: hard-fail an oversized/binary untracked file the same as a tracked one (recommended) vs. silently skip with a diagnostic.
3. Request 2 decision: manual-only (recommended default) vs. manual + off-by-default auto-refresh toggle.
4. Request 3 scope for this pass: full slice (Bezier edges + arrowhead refinement + typography/function-method fix) vs. a smaller first cut (Bezier edges only).
