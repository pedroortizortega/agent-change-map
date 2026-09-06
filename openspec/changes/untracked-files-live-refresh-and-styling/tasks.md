# Tasks: Untracked Files, Live Refresh, and Graph Styling

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~930 total (PR1 ~330, PR2 ~380, PR3 ~220) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Tracker branch → PR 1 (matcher + untracked capture + provenance) → PR 2 (ComparisonController + refresh + SnapshotStore) → PR 3 (graph visual polish) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Slice A: `sourceFileMatcher` + untracked capture + provenance + fixture/test rewrites | PR 1 (base: tracker branch) | `npm run test:unit -- sourceFileMatcher gitState` and `npm run test:integration -- gitState` | `npm run test:e2e` (diagram/nav scenarios stay green) | `src/analysis/sourceFileMatcher.ts`, `src/git/gitService.ts` matcher param + `listUntrackedPaths`, `src/extension.ts` `.py` filter removal, `test/unit/sourceFileMatcher.test.ts`, `test/integration/gitState.test.ts` fixture renames |
| 2 | Slice B: `ComparisonController`, refresh protocol, auto-refresh watcher, `SnapshotStore` LRU | PR 2 (base: PR 1 branch) | `npm run test:unit -- comparisonController webviewHost webviewProtocol snapshotStore webviewDom` | `npm run test:e2e` (refresh scenario) | `src/comparisonController.ts`, `src/webviewHost.ts` refresh bits, `src/webviewProtocol.ts` refresh messages, `src/snapshots/snapshotStore.ts` LRU, `webview/index.ts` `preservedRuns`/`selectedNodeId`, `package.json` `agentChangeMap.autoRefresh` setting |
| 3 | Slice C: Bezier edges, kind encoding fix, node-label font, provenance badge, CSS custom properties | PR 3 (base: PR 2 branch) | `npm run test:unit -- graphView webviewDom` | `npm run test:e2e` (diagram scenarios) | `webview/graphView.ts`, `webview/styles.css` |

Each slice is independently revertible per the design's Migration/Rollout section; reverting Slice A requires re-adding `buildGraphForSelection`'s `.py` filter (noted so a partial revert is not silently lossy).

## Phase 1: Slice A — `SourceFileMatcher` (PR 1)

- [x] 1.1 RED `test/unit/sourceFileMatcher.test.ts` — Case 1: `.py` matches, `.PY` matches (case-insensitive), `.pyc`/`.txt`/extensionless do not match, `a.python.txt` (mid-string `.py`) does not match.
- [x] 1.2 RED `test/unit/sourceFileMatcher.test.ts` — Case 2: `createSourceFileMatcher([".py", ".sql"])` matches both extensions, proving extensibility without pipeline rework.
- [x] 1.3 GREEN create `src/analysis/sourceFileMatcher.ts` (zero imports): `SourceFileMatcher` interface (`extensions`, `matches(posixPath)`), `createSourceFileMatcher(extensions)` factory, `defaultSourceFileMatcher = createSourceFileMatcher([".py"])`.
- [x] 1.4 REFACTOR: confirm the module has no runtime dependency on `src/git` or `src/analysis` internals — it stays a pure predicate.

## Phase 2: Slice A — Untracked Capture Wiring (PR 1)

- [x] 2.1 RED `test/integration/gitState.test.ts` — Case 3: a never-staged `.py` file appears in a worktree capture with `provenance: "untracked"`.
- [x] 2.2 RED `test/integration/gitState.test.ts` — Case 4 (Threat Matrix row "Documentation-like paths"): untracked `.txt`/`README.sh`/`requirements.txt` excluded.
- [x] 2.3 RED `test/integration/gitState.test.ts` — Case 5 (Threat Matrix row "Documentation-like paths"): untracked `setup.py` included and analyzed.
- [x] 2.4 RED `test/integration/gitState.test.ts` — Case 6: a `.gitignore`d untracked `.py` is excluded by `--exclude-standard`.
- [x] 2.5 GREEN edit `src/git/gitService.ts`: add `listUntrackedPaths(canonicalPath)` running `git ls-files --others --exclude-standard` through existing `runGit` (`shell: false`, argv array, timeout, output cap), filtered by the matcher.
- [x] 2.6 GREEN edit `src/git/gitService.ts`: add optional `matcher: SourceFileMatcher = defaultSourceFileMatcher` last parameter to `captureCommitState`, `beginWorktreeCapture`, `captureWorktreeState`, `captureGitState`; apply matcher to commit tree entries and both tracked/untracked worktree lists; add `provenance: "tracked" | "untracked"` to `CapturedFile`; add `untrackedPaths: string[]` to `WorktreeCaptureBegin`; merge tracked-then-untracked into one `paths` list (disjoint by git definition).
- [x] 2.7 GREEN switch `statusFingerprint` invocation from `--untracked-files=no` to `--untracked-files=all`.
- [x] 2.8 REFACTOR: confirm `finishWorktreeCapture`'s two-phase stability comparison, size guard, and binary-content guard run unchanged (no new silent-skip path) for both tracked and untracked entries.

## Phase 3: Slice A — Stability, Limits, and Commit Isolation (PR 1)

- [x] 3.1 RED `test/integration/gitState.test.ts` — Case 7: untracked file created after `begin` → `GitCaptureInstabilityError`.
- [x] 3.2 RED `test/integration/gitState.test.ts` — Case 8: untracked file deleted after `begin` → `GitCaptureInstabilityError`.
- [x] 3.3 RED `test/integration/gitState.test.ts` — Case 9: untracked file edited after `begin` (status letter unchanged) → `GitCaptureInstabilityError`.
- [x] 3.4 RED `test/integration/gitState.test.ts` — Case 10: oversized untracked `.py` → `GitCaptureLimitError`; binary untracked `.py` → `GitBinaryContentError`.
- [x] 3.5 RED `test/integration/gitState.test.ts` — Case 11: tracked + untracked count crossing `DTO_LIMITS.maxFiles` → `GitCaptureLimitError`.
- [x] 3.6 RED `test/integration/gitState.test.ts` — Case 12: `captureCommitState` of the same repo contains no untracked file, every entry `provenance: "tracked"` (Threat Matrix row "Commit state" — empty index, commit capture case).
- [x] 3.7 RED `test/integration/gitState.test.ts` — Case 13: `computeContentDigest` byte-identical for the same files with differing `provenance` (Decision 4 proof — provenance excluded from hashing).
- [x] 3.8 RED `test/integration/gitState.test.ts` — Case 14 (Threat Matrix row "Git repository selection"): a worktree path escaping the repo still throws `GitSelectionError` before any untracked listing runs.
- [x] 3.9 RED `test/integration/gitState.test.ts` — Case 15 (Threat Matrix row "Commit state"): a staged-new file is `provenance: "tracked"`, not `"untracked"` (not `--others`).
- [x] 3.10 RED `test/integration/gitState.test.ts` — Threat Matrix row "Commit state", third planned RED test: an empty index plus one untracked `.py` captures that file with correct provenance.
- [x] 3.11 GREEN: implement/adjust `finishWorktreeCapture`, `assertWithinCaptureLimits`, `assertContentWithinSizeLimit`, `decodeUtf8OrThrow`, and disjointness assertion so 3.1–3.10 pass with no behavior beyond what the design specifies. (Also added `readCaptureFileOrThrowInstability` to translate an ENOENT from a file disappearing mid-capture into `GitCaptureInstabilityError` instead of a raw filesystem error — required for 3.2 to pass, not previously covered for the tracked path either.)
- [x] 3.12 REFACTOR: confirm no capture code path performs an inline extension check outside `sourceFileMatcher` (spec requirement "Filter capture through a single file matcher").

## Phase 4: Slice A — Existing Test Rewrites and Late-Filter Removal (PR 1)

- [x] 4.1 REQUIRED REVIEW (explicit design flag, not an assumption): confirm `gitState.test.ts` L79/L90/L106 (the three worktree-capture instability tests using only `a.py` in an otherwise clean tmp repo) stay green byte-unchanged under `--untracked-files=all`, and confirm no stray file (e.g. an editor backup) exists in those fixture repos that would break them. Reviewed and confirmed: fixtures are freshly `mkdtemp`'d per test, contain no stray files, and all three tests pass unchanged.
- [x] 4.2 Rewrite `gitState.test.ts` L183 (`"rejects a worktree capture containing a non-UTF-8 tracked file"`): rename fixture `binary.dat` → `binary.py` so the matcher still routes it to the binary-content guard instead of silently excluding it.
- [x] 4.3 Rewrite `gitState.test.ts` L174 (commit-capture binary test) identically: `binary.dat` → `binary.py`.
- [x] 4.4 Review `gitState.test.ts` L142 (gitlink test): keep the mode-`160000` filter and assert it still runs before the matcher (`vendor` has no extension, now filtered twice over).
- [x] 4.5 Review and update `gitState.test.ts` L43/L61/L124/L134/L162 (staged-dirty, empty index, limits, small-state): add `provenance: "tracked"` to every existing `state.files` `toEqual` assertion (all fixtures are `.py`). Actual current line numbers had drifted from the design's citations; every `state.files` `toEqual` assertion in the file (including the commit-capture and accented-UTF-8 tests) was updated by content/description rather than line number, since `CapturedFile.provenance` is now a required field on every such literal.
- [x] 4.6 Confirm `test/unit/webviewHost.test.ts`'s `SessionDeps` literals need zero edits (`requestRefresh`/`onIdle` are optional — not part of this slice's runtime change, only confirming no incidental breakage). Confirmed — `SessionDeps` literals unchanged; the only `webviewHost.test.ts` edits were two pre-existing `CapturedFile` object literals (used to seed `SnapshotStore`, unrelated to `SessionDeps`) that needed `provenance: "tracked"` added to satisfy the now-required field (see Deviations).
- [x] 4.7 GREEN edit `src/extension.ts`: delete `buildGraphForSelection`'s late `.endsWith(".py")` filter. Note precisely: `buildGraphForSelection` keeps working exactly as today without its own filter, because `captureGitState` now returns pre-filtered files via the matcher — this leaves no temporarily-broken intermediate state even though `buildGraphForSelection`'s extraction into `ComparisonController` is deferred to PR 2.
- [x] 4.8 Run `npm run lint && npm run typecheck && npm run test:unit -- sourceFileMatcher gitState && npm run test:integration -- gitState && npm run test:e2e` and confirm all green before opening PR 1 against the tracker branch. All green — see Work Unit Evidence below.

## Phase 5: Slice B — `ComparisonController` Scaffolding (PR 2, base: PR 1 branch)

- [ ] 5.1 RED `test/unit/comparisonController.test.ts` — Case 16: `requestRefresh` schema accepts a valid message and rejects a missing `requestId`.
- [ ] 5.2 GREEN edit `src/webviewProtocol.ts`: add `{ type: "requestRefresh", requestId }` (webview→host), `{ type: "refreshResult", requestId, ok: true }` / `{ ok: false, reason }` (host→webview), `{ type: "refreshDeferred", reason }`, `loadReason: "initial" | "refresh"` on `graphSummary`, `untrackedPaths: string[]` on `graph`.
- [ ] 5.3 GREEN create `src/comparisonController.ts`: owns `references`/`repoRoot`/`extensionRoot`/`store`/`session`/`matcher`, exposes `capture()` moved from `extension.ts`'s `buildGraphForSelection` closure (left/right builds, `store.get` x2, `diffSnapshots`, `correlateDiff`, `session.loadComparison(...)` with `untrackedPaths`/`loadReason`).
- [ ] 5.4 GREEN edit `src/extension.ts`: command closure constructs the `ComparisonController` instead of owning `references`/`repoRoot`/`extensionRoot`/`store`/`session` itself directly; watcher/controller disposal wired into `panel.onDidDispose`.
- [ ] 5.5 REFACTOR: confirm the `__empty__.py` placeholder for an empty file set is retained in the moved `buildGraphForSelection`.

## Phase 6: Slice B — Refresh Intent and Busy Guard (PR 2)

- [ ] 6.1 RED `test/unit/webviewHost.test.ts` — Case 17: `requestRefresh` with no `deps.requestRefresh` posts `refreshResult{ok:false}` (never a fabricated success).
- [ ] 6.2 RED `test/unit/comparisonController.test.ts` — Case 18: `requestRefresh` re-runs capture and re-posts `graphSummary` + `graph`; a file created between the two captures appears in the second graph.
- [ ] 6.3 RED `test/unit/webviewHost.test.ts` — Case 19: `isBusy()` is true with a pending write confirmation, a pending run confirmation, and an active run; false otherwise.
- [ ] 6.4 RED `test/unit/webviewHost.test.ts` — Case 20: manual refresh while busy → `refreshResult{ok:false}` naming the pending action, and the pending confirmation still resolves normally afterwards.
- [ ] 6.5 GREEN edit `src/webviewHost.ts`: `SessionDeps` gains optional `requestRefresh?: () => Promise<void>` and `onIdle?: () => void`; `ChangeMapSession.isBusy()` (new, public) = `pendingWriteConfirmations.size > 0 || pendingRunConfirmations.size > 0 || activeRuns.size > 0`; wire `onIdle()` at exactly the four sites the design names: `confirmDirectWrite`, `handleRequestDirectWrite` catch, declined run, `executeRun`'s `finally`; `"requestRefresh"` intent handler refuses with `refreshResult{ok:false}` when busy (manual) or when `deps.requestRefresh` absent.
- [ ] 6.6 REFACTOR: confirm neither manual nor auto refresh ever resolves, cancels, or drops a pending confirmation (Decision 7).

## Phase 7: Slice B — Auto-Refresh Watcher (PR 2)

- [ ] 7.1 RED `test/unit/comparisonController.test.ts` — Case 21: auto-refresh while busy → `refreshDeferred`, no recapture; on `onIdle` the queued refresh fires exactly once.
- [ ] 7.2 RED `test/unit/comparisonController.test.ts` — Case 22: auto-refresh debounce coalesces N watcher events into one capture.
- [ ] 7.3 RED `test/unit/comparisonController.test.ts` — Case 23: watcher events for a non-matching path do not schedule a refresh.
- [ ] 7.4 RED `test/unit/comparisonController.test.ts` — Case 24: `agentChangeMap.autoRefresh` defaults false → no watcher created.
- [ ] 7.5 GREEN edit `package.json`: `contributes.configuration` adds `agentChangeMap.autoRefresh` (boolean, default `false`).
- [ ] 7.6 GREEN implement `scheduleAutoRefresh()` in `src/comparisonController.ts`: 750ms debounce, then `isBusy()` check — busy sets `queued = true` and posts `refreshDeferred` once and returns; `onIdle` re-arms the same debounced timer when `queued`. Watcher created only when right selection is `kind: "worktree"` AND `agentChangeMap.autoRefresh` is true, filtered by `matcher.matches(uri)`; recreated/disposed from `workspace.onDidChangeConfiguration`; disposed on `panel.onDidDispose`.
- [ ] 7.7 REFACTOR: confirm the watcher uses `RelativePattern(worktree, "**/*")` per the design's data-flow diagram.

## Phase 8: Slice B — `SnapshotStore` LRU (PR 2)

- [ ] 8.1 RED `test/unit/snapshotStore.test.ts` (or extend existing store test) — Case 25: `SnapshotStore` evicts the least-recently-used entry past `MAX_SNAPSHOTS = 8`; `get()` refreshes recency so the displayed pair is never evicted; re-storing identical content (same `snapshotKey`) adds no entry.
- [ ] 8.2 GREEN edit `src/snapshots/snapshotStore.ts`: `MAX_SNAPSHOTS = 8`; `store(state)` deletes-then-re-sets the key (moves to most-recent), evicts from `Map` insertion-order front while `size > MAX_SNAPSHOTS`; `get(id)` deletes-and-re-sets on hit; add `size` getter (test surface).
- [ ] 8.3 REFACTOR: confirm `Map` iteration-order-as-recency assumption is documented in a code comment next to the eviction loop.

## Phase 9: Slice B — Webview State Preservation (PR 2)

- [ ] 9.1 RED `test/unit/webviewDom.test.ts` — Case 26: `expandedRuns` survive a `loadReason: "refresh"` round trip; a plain second `sourcePair` (no refresh) still collapses — explicitly keep the archived "second message resets to collapsed" test green untouched.
- [ ] 9.2 RED `test/unit/webviewDom.test.ts` — Case 27: `#draft-content` text survives a refresh landing; `selected`/`editingEnabled` are cleared and a stale `saveDraft` is refused rather than silently applied.
- [ ] 9.3 GREEN edit `webview/index.ts`: add `preservedRuns: Set<string>` — on `graphSummary` with `loadReason === "refresh"`, copy current `expandedRuns` into `preservedRuns`; `sourcePair` case keeps its existing `expandedRuns.clear()` then re-adds from `preservedRuns`, emptying it afterward. Guard the existing `graphSummary` reset block with `if (loadReason === "initial")` so `#draft-content` is untouched on refresh. Add `selectedNodeId`: after refreshed `graph` renders, if the id still exists, rebind `selectedPair` and re-issue `inspectSources`, but leave `selected`/`editingEnabled` false.
- [ ] 9.4 GREEN edit `webview/index.ts`: add a refresh action (button/command) posting `requestRefresh`; handle `refreshResult`/`refreshDeferred` cases.
- [ ] 9.5 RED `test/e2e/scenarios.ts` — Case 28: refresh scenario — create a file, refresh, see the new node without reopening the panel.
- [ ] 9.6 GREEN wire whatever e2e harness support is needed (fixture write + refresh trigger) so Case 28 passes.
- [ ] 9.7 Run `npm run lint && npm run typecheck && npm run test:unit -- comparisonController webviewHost webviewProtocol snapshotStore webviewDom && npm run test:e2e` and confirm all green before opening PR 2 against the PR 1 branch.

## Phase 10: Slice C — Bezier Edges (PR 3, base: PR 2 branch)

- [ ] 10.1 RED `test/unit/graphView.test.ts` — Case 29: resolved edge `d` matches `/^M[\d.]+,[\d.]+ C/` with both control points offset vertically by `≥ CURVE_MIN_DROP`; `marker-end` still present.
- [ ] 10.2 RED `test/unit/graphView.test.ts` — Case 30: target above the source still yields a `C` path entering the target's top edge (S-curve case).
- [ ] 10.3 GREEN edit `webview/graphView.ts`: rename `ELBOW_DROP` → `CURVE_MIN_DROP` (value unchanged, `16`); replace the 3-segment `L` elbow in `renderEdge` with `dy = Math.max(Math.round(Math.abs(tay - say) / 2), CURVE_MIN_DROP); path = "M${sax},${say} C${sax},${say + dy} ${tax},${tay - dy} ${tax},${tay}"`. Ambiguous/unresolved dashed stub path unchanged.
- [ ] 10.4 REFACTOR: confirm end-tangent still matches the elbow's final segment so `marker-end`/`orient="auto-start-reverse"` orientation is unchanged.

## Phase 11: Slice C — Kind Encoding, Label Font, Provenance Badge, CSS Properties (PR 3)

- [ ] 11.1 RED `test/unit/graphView.test.ts` — Case 31: `KIND_STYLE` table exactly matches the design (`package` w1/dash `2 4`/rx4, `module` w1.5/dash `4 3`/rx4, `class` w3.5/rx2, `function` w2.5/rx10, `method` w2/rx6); all three entity kinds mutually distinct on width and `rx`; containers strictly thinner than every entity.
- [ ] 11.2 GREEN edit `webview/graphView.ts`: fix `KIND_STYLE.method` per the table above (currently identical to `function`).
- [ ] 11.3 RED `test/unit/graphView.test.ts` — Case 32: every `<text>` carries `class="node-label"` in both `place()` (nested) and `renderFlatSvg` (flat) layouts.
- [ ] 11.4 GREEN edit `webview/graphView.ts`: emit `<text class="node-label" x="8" y="20">` in both layout paths.
- [ ] 11.5 RED `test/unit/webviewDom.test.ts` or CSS assertion test — Case 33: `webview/styles.css` declares a `font-family` for `.node text`.
- [ ] 11.6 GREEN edit `webview/styles.css`: add `.node text { fill: var(--vscode-editor-foreground, #ccc); font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace)); }`.
- [ ] 11.7 RED `test/unit/graphView.test.ts` — Case 34: untracked node emits `data-provenance="untracked"` plus one `<circle class="provenance-untracked">`; a tracked node emits `"tracked"` and no circle.
- [ ] 11.8 RED `test/unit/graphView.test.ts` — Case 35: provenance badge composes — an untracked+`removed` node keeps `class="node-box status-removed"` and its kind `stroke-width` unchanged.
- [ ] 11.9 RED `test/unit/graphView.test.ts` — Case 36: `renderGraphSvg` called with the default (omitted) third argument marks every node `"tracked"`.
- [ ] 11.10 GREEN edit `webview/graphView.ts`: add third parameter `untrackedPaths: readonly string[] = []` to `renderGraphSvg`; in `place()`/`renderFlatSvg` compute `const untracked = untrackedPaths.includes(node.span.path)`, emit `data-provenance="untracked" | "tracked"` on `<g class="node">`, and for untracked nodes append `<circle class="provenance-untracked" cx="${w - 8}" cy="8" r="3"></circle>` after the rect.
- [ ] 11.11 RED `test/unit/webviewDom.test.ts` or CSS assertion test — Case 37: `:root` `--acm-*` properties exist and the status/edge rules reference them.
- [ ] 11.12 GREEN edit `webview/styles.css`: add `:root { --acm-status-added:#2ea043; --acm-status-removed:#f85149; --acm-status-modified:#d29922; --acm-status-unchanged:#6e7681; --acm-edge-import:#4f9cf9; --acm-edge-call:#c586c0; --acm-edge-ambiguous:#f0883e; --acm-provenance-untracked:#a371f7 }`; add `.provenance-untracked { fill: var(--acm-provenance-untracked); stroke: none }`; rewrite existing status/edge rules to reference the new custom properties (byte-identical resolved values).
- [ ] 11.13 REFACTOR: confirm every attribute in the archived `data-*` contract table keeps its exact element, value, and emission site; `data-provenance` is additive only.

## Phase 12: Slice C — Existing Test Extension and Full Verification (PR 3)

- [ ] 12.1 Extend `test/unit/graphView.test.ts` L185 (kind encoding test): assert `method` ≠ `function` on both `stroke-width` and `rx`, containers still strictly thinner.
- [ ] 12.2 Extend `test/unit/graphView.test.ts` L223 (arrowhead test): assert the resolved path's `d` starts with `M` and contains `C`, while ambiguous/unresolved stay `L` stubs with no `marker-end`.
- [ ] 12.3 Confirm `test/unit/webviewDom.test.ts`'s diff-collapse test is unchanged and still passes (proof `preservedRuns` did not change no-refresh behavior).
- [ ] 12.4 Verify `test/e2e/scenarios.ts` diagram/navigation scenarios pass unchanged — the `data-*` contract proof, per the spec requirement "Preserve node and edge data attribute contract".
- [ ] 12.5 Run `npm run lint && npm run typecheck && npm run test` (unit + integration + e2e) and confirm all green; document any environment-gated skips per existing README convention, before opening PR 3 against the PR 2 branch.
</content>
</invoke>
