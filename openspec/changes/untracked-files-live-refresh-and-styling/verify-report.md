# Verification Report: untracked-files-live-refresh-and-styling

**Mode**: full artifacts (proposal + specs + design + tasks all present)
**Verdict**: PASS

## Completeness

- Tasks: all checked `[x]` across Phases 1-12 in `tasks.md`, matching current code state.
- All 4 chained PRs merged into `feat/untracked-files-live-refresh-and-styling`:
  PR 1 (#11, matcher + untracked capture + provenance), PR 2a (#12, ComparisonController manual
  refresh + SnapshotStore LRU + webview state preservation), PR 2b (#13, auto-refresh watcher),
  PR 3 (#14, graph visual polish).
- The "Split note" in `tasks.md` (original combined PR 2 apply pass landed ~789 authored lines,
  ~2x the design's ~380-line estimate, split after the fact into PR 2a/PR 2b rather than
  accepting a `size:exception`) is documented accurately; Phase 7's tasks were left unchecked
  until PR 2b's own apply pass, matching the note's own description.

## Commands run and results

| Command | Result |
|---|---|
| `npm run lint` (`eslint src test webview --max-warnings=0`) | exit 0, no output |
| `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit`) | exit 0, no errors |
| `npx vitest run test/unit test/integration` | 20 files / 187 tests, all passed |
| `npm run test:e2e` (`node scripts/vscode-harness.mjs`, full VS Code Extension Development Host) | exit 0 — all 9 scenarios passed: selection, exact navigation, stale navigation refusal, draft save, forged repository root refusal, direct save, oversized consent, refresh, explicit run/stream, explicit cancel |

Note on the prior change's e2e flake: the archived `diff-view-and-graph-styling` verify report
(`openspec/changes/archive/2026-09-06-diff-view-and-graph-styling/verify-report.md`) recorded a
pre-existing, unrelated W1 finding — the "direct save" e2e scenario intermittently observed a
`graph` message instead of `directWriteResult` due to a message-ordering race. Running the full
e2e suite for this change, the **direct save scenario passed** (`[e2e] direct save scenario ok`),
with no ordering failure observed. This is not proof the underlying race is fixed (nothing in
this change's design or diff touches the write/session ordering path), but it did not reproduce
in this run and no regression was introduced.

## Spec compliance matrix

### git-state-comparison (6 requirements, 12 scenarios)

| Requirement | Scenario | Covering test |
|---|---|---|
| Filter capture through a single file matcher | Tracked file filtered by the matcher | `gitState.test.ts` staged/small-state tests (all fixtures `.py`, non-`.py` never appear) + `sourceFileMatcher.test.ts` |
| " | Untracked file filtered by the same matcher | `gitState.test.ts:227` "excludes untracked documentation-like paths that the matcher does not match" |
| Worktree capture includes untracked files | Never-staged file appears in worktree capture | `gitState.test.ts:213` "includes a never-staged .py file in worktree capture with provenance untracked" |
| " | Ignored untracked file excluded | `gitState.test.ts:244` "excludes a .gitignore'd untracked .py file via --exclude-standard" |
| Captured files carry tracked/untracked provenance | Provenance flag set correctly | `gitState.test.ts:213`/`255` (per-entry `provenance` assertions), `gitState.test.ts:316` (commit path all-tracked) |
| Mid-capture stability covers untracked files | Untracked file appears mid-capture | `gitState.test.ts:263` "raises GitCaptureInstabilityError when an untracked file is created mid-capture" |
| " | Untracked file removed mid-capture | `gitState.test.ts:270` "raises GitCaptureInstabilityError when an untracked file is deleted mid-capture" |
| Size and binary guards apply uniformly | Oversized untracked file hard-fails | `gitState.test.ts:288` "hard-fails an oversized untracked .py file with GitCaptureLimitError" |
| " | Binary untracked file hard-fails | `gitState.test.ts:295` "hard-fails a binary untracked .py file with GitBinaryContentError" |
| Commit-state capture is unaffected | Commit capture ignores worktree untracked files | `gitState.test.ts:316` "commit-state capture contains no untracked file and marks every entry tracked" |

(12 scenarios total in spec; all covered — additional edited/mid-capture-status-unchanged and
count-limit-crossing scenarios covered by `gitState.test.ts:278`/`301`, and Decision-4 hashing
proof by `gitState.test.ts:328` "computes a byte-identical content digest regardless of
differing provenance".)

### change-map-visualization delta (7 requirements, 15 scenarios: 4 ADDED + 3 MODIFIED)

| Requirement | Scenario | Covering test |
|---|---|---|
| Refresh a panel in place (ADDED) | Manual refresh re-runs the pipeline | `comparisonController.test.ts:65` "requestRefresh re-runs capture and re-posts graphSummary + graph…" |
| " | Manual refresh is always available | `webviewHost.test.ts:417` "invokes deps.requestRefresh and reports success when idle" |
| Opt-in automatic refresh respects pending user decisions (ADDED) | Auto-refresh disabled by default | `comparisonController.test.ts:167` "creates no watcher when agentChangeMap.autoRefresh is false (default)" |
| " | Auto-refresh deferred during pending confirmation/active run | `comparisonController.test.ts:88` "auto-refresh while busy posts refreshDeferred and does not recapture; on idle the queued refresh fires exactly once"; `webviewHost.test.ts:425` "isBusy() is true with a pending write confirmation, a pending run confirmation, or an active run; false otherwise" |
| Refresh preserves panel state (ADDED) | Collapse state survives refresh | `webviewDom.test.ts:182` "re-issues inspectSources for the previously selected node after a refresh landing, and preserves its expanded runs" |
| " | Unsaved draft survives refresh | `webviewDom.test.ts:219` "preserves unsaved draft text across a refresh landing while clearing selection/editing" |
| Snapshot store is bounded (ADDED) | Repeated refreshes do not grow storage unbounded | `snapshotStore.test.ts:10` "evicts the least-recently-used entry once size exceeds MAX_SNAPSHOTS (8)"; `:35` "re-storing identical content (same snapshotKey) adds no new entry" |
| SVG text declares an explicit font-family (ADDED) | Rendered label has an explicit font-family | `graphView.test.ts:355` "declares a font-family for .node text in styles.css" |
| Distinguish tracked and untracked node provenance (ADDED) | Untracked node is visually distinct / provenance indicator does not obscure change status | `graphView.test.ts:375` "marks an untracked node with data-provenance and a badge circle; a tracked node gets neither"; `:386` "composes the provenance badge with a non-unchanged status without altering kind stroke-width" |
| Encode kind via dash pattern and stroke width (MODIFIED) | Container/entity/kind styling, function vs method distinct | `graphView.test.ts:191`/`219` "encodes stroke-width…containers strictly thinner than entities" / "encodes the exact KIND_STYLE table per kind" |
| Draw directional import and call edges (MODIFIED) | Resolved import/call edges curved; containment draws no edge; edge path curved not elbow | `graphView.test.ts:296` "renders a resolved edge as a cubic Bezier…"; `:309` "draws an S-curve entering the target's top edge when the target sits above the source"; `:277` "renders no element for contains edges…" |
| Preserve node and edge data attribute contract (MODIFIED) | Click-to-navigate unaffected / contract holds after refresh / provenance styling does not alter data attributes | `graphView.test.ts:460` "preserves the full node/edge data-* attribute set with exact current values"; `webviewDom.test.ts:266` "passes the host's untrackedPaths through to the rendered graph, marking an untracked node's provenance"; e2e `refresh scenario` (`test/e2e/scenarios.ts`, line ~221) |

Every requirement in both spec files has at least one currently-passing covering test. No
UNTESTED or FAILING scenario found.

## Design coherence spot-checks (source-verified, not just claimed)

1. **Unified matcher wiring (Decision 2/3)**: confirmed by direct read of `src/git/gitService.ts`
   — `captureCommitState` filters tree entries (`entries.filter(e => matcher.matches(e.path))`,
   line 239), `listTrackedPaths` filters tracked worktree paths (line 278), `listUntrackedPaths`
   filters untracked worktree paths (line 292). All three capture entry points
   (`captureCommitState`, `beginWorktreeCapture`, `captureGitState`) accept
   `matcher: SourceFileMatcher = defaultSourceFileMatcher` as their last parameter, matching the
   design's interface exactly. This is genuinely wired everywhere, not just claimed in tasks.md.
2. **Provenance excluded from hashing (Decision 4)**: confirmed by direct read —
   `computeContentDigest` (line 222) and `contentFingerprintFromEntries` (line 318) both iterate
   only `.path` and `.content`; neither function reads `.provenance`. `gitState.test.ts:328`
   proves this at runtime (byte-identical digest for differing provenance).
3. **`webview/index.ts` → `renderGraphSvg` untrackedPaths wiring**: confirmed present —
   `webview/index.ts:278` calls `renderGraphSvg(graph, message.diff, message.untrackedPaths)`,
   and `src/webviewHost.ts` plumbs `untrackedPaths` from `loadComparison`'s options through to
   the `graph` protocol message (line 177). The regression test
   `webviewDom.test.ts:266` ("passes the host's untrackedPaths through to the rendered graph,
   marking an untracked node's provenance") exists and passes.
4. **SnapshotStore LRU (Decision 8)**: confirmed by direct read of
   `src/snapshots/snapshotStore.ts` — `store()` deletes-then-re-sets the key (moves to
   most-recent) and evicts from the `Map`'s insertion-order front while `size > MAX_SNAPSHOTS`
   (8); `get()` deletes-and-re-sets on hit, refreshing recency so a currently displayed snapshot
   is never the least-recently-used entry evicted by a later `store()`. All three
   `snapshotStore.test.ts` cases pass.
5. **Auto-refresh busy-guard (Decision 7)**: traced the actual code path, not just the comment.
   `ChangeMapSession.isBusy()` (`src/webviewHost.ts:132`) = pending write confirmations OR
   pending run confirmations OR active runs. `notifyIfIdle()` (private, line 294) calls
   `deps.onIdle?.()` only when `!isBusy()`, and is invoked at exactly the four sites the design
   names: line 245 (`confirmDirectWrite` intent handler), line 357
   (`handleRequestDirectWrite`'s catch), line 394 (declined run), line 431 (`executeRun`'s
   `finally`). None of these four sites, nor `handleRequestRefresh` (manual refusal, line 269)
   nor `ComparisonController.fireAutoRefresh` (auto-refresh deferral, line 125), ever calls
   `.resolve()`, `.reject()`, `.delete()`, or `.abort()` on a pending confirmation/run as a side
   effect of a refresh attempt — refresh code paths only *read* `isBusy()`/`describeBusy()` and
   either refuse (manual) or set `queued = true` + post `refreshDeferred` (auto), matching
   Decision 7 exactly: "Neither ever discards pending state."
6. `KIND_STYLE.method` (`webview/graphView.ts`) now distinct from `.function` on both
   `stroke-width` and `rx`, matching design's table exactly (verified via
   `graphView.test.ts:219`, an exact-table assertion test).
7. Bezier edge formula (`dy = Math.max(Math.round(Math.abs(tay-say)/2), CURVE_MIN_DROP)`,
   `M...C...`) matches design.md verbatim; `ELBOW_DROP` renamed `CURVE_MIN_DROP` with unchanged
   value `16`.
8. `webview/styles.css` `:root` block declares all `--acm-*` custom properties listed in the
   design (status/edge/provenance colors), byte-identical hex values to the archived change,
   referenced by the rewritten status/edge/provenance rules (`graphView.test.ts:410`).
9. `data-*` contract: `data-provenance` is additive only; existing `data-node-id`,
   `data-edge-index`, `data-node-kind`, `data-change-status`, `data-edge-kind`,
   `data-resolution` are unchanged in emission site/value, confirmed by
   `graphView.test.ts:460`'s exact-attribute-set test and the e2e refresh/navigation scenarios.

## Findings

No CRITICAL, WARNING, or SUGGESTION findings. The prior change's e2e W1 finding (message-ordering
race on "direct save") did not reproduce in this run's full e2e pass; this change's diff does
not touch the write/session ordering path (`handleRequestDirectWrite`/`confirmDirectWrite`
sequencing is unmodified except for the new `notifyIfIdle()` calls, which fire only in the
declined/catch/finally branches — never on the write-success path).

## Verdict

**PASS** (0 CRITICAL, 0 WARNING, 0 SUGGESTION). All 12 phases / all tasks in `tasks.md` complete
and match current code. Every requirement and scenario in both spec files
(`git-state-comparison`, `change-map-visualization` delta) has at least one currently-passing
covering test — 187/187 unit+integration tests pass, all 9 e2e scenarios pass, lint and
typecheck are clean. Design decisions (unified matcher wiring across all three capture paths,
provenance excluded from content hashing, `untrackedPaths` webview wiring, SnapshotStore LRU
eviction/recency, auto-refresh busy-guard never discarding pending state, Bezier edge geometry,
kind-encoding table, CSS custom properties, `data-*` contract) were verified against actual
source — not solely against tasks.md's checkmarks — and match the design with no drift found.
