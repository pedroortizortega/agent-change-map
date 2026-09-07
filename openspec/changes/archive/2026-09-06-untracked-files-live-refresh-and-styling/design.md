# Design: Untracked Files, Live Refresh, and Graph Styling

## Technical Approach

Three independently revertible slices over one shared new collaborator. Slice A introduces
`src/analysis/sourceFileMatcher.ts` as the **single** extension-filtering point and routes
*every* capture path through it — commit tree entries, tracked worktree paths, and the new
`git ls-files --others --exclude-standard` untracked paths — while `buildGraphForSelection`'s
late `.py` filter is deleted. Slice B lifts the one-shot command closure into a
`ComparisonController` that owns `references`/`repoRoot`/`extensionRoot`/`store`/`session` and
exposes one `capture()` used by both the initial load and a new `requestRefresh` intent, with
an LRU-bounded `SnapshotStore` underneath. Slice C is a pure `webview/graphView.ts` +
`webview/styles.css` edit: cubic-Bezier edges, a distinct `method` encoding, a
`font-family`-carrying label class, and an additive provenance badge.

Constraint that shapes all three: the archived `diff-view-and-graph-styling` contract is
locked — stable `data-*` attributes, outline-only boxes, arrowhead-at-destination, strict CSP,
theme-varying values in CSS and geometry-carrying values in the SVG string (archived Decision
6). Nothing here relaxes it; provenance is added to the `data-*` table, never substituted into
an existing attribute.

## Architecture Decisions

| # | Decision | Alternatives / tradeoff | Choice and rationale |
|---|---|---|---|
| 1 | Matcher shape | A `LanguageRegistry` with per-language plugin objects; or a bare exported `const SOURCE_EXTENSIONS`. Registry is the over-engineering risk the proposal names; a bare array reintroduces a scattered predicate. | A 3-export module: `SourceFileMatcher` interface with `matches(posixPath)`, factory `createSourceFileMatcher(extensions)`, and `defaultSourceFileMatcher = createSourceFileMatcher([".py"])`. Adding SQL later is one string in one array — no pipeline rework, no registry. |
| 2 | Matcher applies to **commit** capture too | Filter only worktree capture (narrow reading of the proposal). | Filter both. `diffSnapshots` compares a commit left against a worktree right by path; filtering one side only would report **every** non-`.py` tracked file as `removed`. One filtering point means one file universe on both sides. |
| 3 | Matcher injection | Module-level import inside `gitService`. | Optional last parameter `matcher: SourceFileMatcher = defaultSourceFileMatcher` on `captureCommitState`/`beginWorktreeCapture`/`captureWorktreeState`/`captureGitState`. Testable without module mocking; zero call-site churn. |
| 4 | Provenance is **not** hashed | Add `provenance` to `computeContentDigest`/`contentFingerprintFromEntries`. | Excluded. Both helpers read only `.path`/`.content`, so adding the field is inert by construction — and that is the desired semantics: `git add` changes zero bytes, and rehashing on it would invalidate every live `SourceId.contentHash`, breaking navigation, drafts, and frozen run sources mid-session for a non-change. |
| 5 | Provenance reaches the webview off-graph | Add `provenance` to `entitySchema`/`Entity`. | `Entity` is produced and zod-validated from the Python analyzer subprocess, which knows nothing about git. The host instead puts `untrackedPaths: string[]` on the `graph` message and `renderGraphSvg` joins on `node.span.path`. Analyzer and its DTO contract stay untouched. |
| 6 | Auto-refresh toggle location | A webview toggle button + `setAutoRefresh` message + persistence. | VS Code setting `agentChangeMap.autoRefresh` (boolean, default `false`). It is a durable preference, not panel state; a webview toggle would reset on every open and needs two extra protocol messages plus a persistence story. A setting is discoverable, machine-scoped, and stubbable in tests via `vscode.workspace.getConfiguration`. |
| 7 | Manual vs. auto refresh under a pending confirmation | Treat both identically. | Split. **Auto** refresh queues (never drops) and re-fires when the session goes idle. **Manual** refresh is *refused* with `refreshResult{ok:false}` naming the pending action, because an explicit user action deserves immediate feedback rather than silent latency. Neither ever discards pending state. |
| 8 | `SnapshotStore` bounding | Clear the store on every refresh. | LRU, `MAX_SNAPSHOTS = 8`. The store is the sole authority behind `resolveSource`; clearing it on refresh turns every in-flight `SourceId` — including an active run's frozen sources — into a hard failure. LRU keeps recent generations resolvable while bounding memory. A no-op refresh reuses the same `contentDigest` key and adds nothing at all. |
| 9 | Provenance visual channel | A distinct stroke hue (collides with the status color channel, the proposal's named risk); a fill tint (breaks the locked outline-only invariant); a second dash pattern (collides with the kind dash channel). | An **additive corner badge**: `<circle class="provenance-untracked" r="3">` at the box's top-right, emitted only for untracked nodes. It is a new element on a free channel — it cannot collide with stroke color, width, dash, or `rx`, and it survives a theme that flattens any of them. |
| 10 | `font-family` placement | `font-family="…"` presentation attribute in the SVG string (CSP-legal — a presentation attribute is not inline style). | CSS, via a new `class="node-label"` hook on `<text>` and a `.node text` rule in `webview/styles.css`. Archived Decision 6 is explicit: theme-varying values belong in CSS, geometry in the string. `style-src ${cspSource}` already serves this stylesheet, which already reads `--vscode-editor-font-family`; no CSP change. |
| 11 | CSS custom properties for the hardcoded hexes | Swap in `--vscode-gitDecoration-*` / theme colors. | **Yes to locally-declared `--acm-*` custom properties on `:root` carrying today's exact hex literals; no to VS Code theme color variables.** The local indirection is a byte-for-byte-identical render with zero CSP impact and one place to change. Theme colors vary per installed theme and would silently break the archived spec's "mutually distinct" guarantee with no test able to verify a third-party palette. |

## Interfaces / Contracts

```ts
// src/analysis/sourceFileMatcher.ts  (new, zero imports)
export interface SourceFileMatcher {
  readonly extensions: readonly string[];
  matches(posixPath: string): boolean;   // case-insensitive suffix match
}
export function createSourceFileMatcher(extensions: readonly string[]): SourceFileMatcher;
export const defaultSourceFileMatcher: SourceFileMatcher; // [".py"]
```

```ts
// src/git/gitService.ts
export interface CapturedFile { path: string; content: string; provenance: "tracked" | "untracked" }
export interface WorktreeCaptureBegin {
  canonicalPath: string; fingerprint: string;
  trackedPaths: string[]; untrackedPaths: string[];   // both already matcher-filtered
  headOid: string | null; contentFingerprint: string;
}
export async function captureGitState(
  repoRoot: string, selection: GitSelection, matcher: SourceFileMatcher = defaultSourceFileMatcher,
): Promise<CapturedState>;
```

```ts
// src/webviewProtocol.ts
z.object({ type: z.literal("requestRefresh"), requestId })          // webview -> host
| { type: "refreshResult"; requestId: string; ok: true }            // host -> webview
| { type: "refreshResult"; requestId: string; ok: false; reason: string }
| { type: "refreshDeferred"; reason: string }                       // auto-refresh queued
| { type: "graphSummary"; …; loadReason: "initial" | "refresh" }    // new field
| { type: "graph"; …; untrackedPaths: string[] }                    // new field
```

```ts
// webview/graphView.ts
export function renderGraphSvg(
  graph: AnalysisGraph, diff: CorrelatedDiffEntry[], untrackedPaths: readonly string[] = [],
): string;
```

## Capture Mechanics (Slice A)

```text
captureCommitState  -> listTreeEntries -> .filter(e => matcher.matches(e.path))
                       -> assertWithinCaptureLimits(matchedCount)   // post-filter
                       -> every file provenance: "tracked"

beginWorktreeCapture -> statusFingerprint(--untracked-files=all)
                     -> listTrackedPaths()   : ls-files -s, drop mode 160000, .filter(matcher)
                     -> listUntrackedPaths() : ls-files --others --exclude-standard, .filter(matcher)
                     -> resolveHeadOidOrNull()
                     -> computeContentFingerprint(tracked ++ untracked)

finishWorktreeCapture -> assertWithinCaptureLimits(tracked.length + untracked.length)
                      -> readFile + assertContentWithinSizeLimit + decodeUtf8OrThrow  (unchanged,
                         so an oversized/binary untracked file hard-fails identically)
                      -> after-fingerprints compared exactly as today
```

- **Exact invocation**: `git ls-files --others --exclude-standard` in `canonicalPath`, through
  the existing `runGit` (`shell: false`, argv array, timeout, output cap). `--exclude-standard`
  is what keeps `.gitignore`d noise out; no mode filter is needed because `--others` never
  reports gitlinks.
- **Merge**: the two lists are concatenated (tracked first) into one `paths` list; they are
  disjoint by git's own definition, so no dedupe is required — but `finishWorktreeCapture`
  asserts disjointness and throws `GitCaptureLimitError` on a duplicate rather than reading a
  path twice.
- **Fingerprint change**: `--untracked-files=no` → `--untracked-files=all`. The two-phase
  comparison in `finishWorktreeCapture` is structurally unchanged; it simply now sees
  create/delete of untracked files as instability. `contentFingerprint` covers untracked paths
  too via the same `readTrackedContentOrMarker` (`" missing "` marker for a vanished file), so
  an untracked file *edited* mid-capture without a status letter change is still caught.
- Existing guards are reused verbatim, not re-implemented: no silent-skip path exists.

## Refresh Data Flow (Slice B)

```text
              ┌──────────────── ComparisonController (src/comparisonController.ts) ─────┐
command ─────>│ { extensionRoot, repoRoot, references, store, matcher, session }        │
              │ capture(): buildGraphForSelection(left) ‖ (right)                       │
              │            -> store.get x2 -> diffSnapshots -> correlateDiff            │
              │            -> session.loadComparison(l, r, diff, { untrackedPaths,      │
              │                                                    loadReason })        │
              └───────────▲────────────────────────────────────▲────────────────────────┘
                          │ deps.requestRefresh()              │ scheduleAutoRefresh()
             ChangeMapSession.handleIntent            FileSystemWatcher (debounced 750ms)
                 "requestRefresh"                     RelativePattern(worktree, "**/*")
                                                      + matcher.matches(uri) filter
```

- `buildGraphForSelection` moves from `extension.ts` into the controller and loses its
  `.endsWith(".py")` filter entirely; `state.files` is already matcher-filtered. The
  `__empty__.py` placeholder for an empty file set is retained.
- `SessionDeps` gains **optional** `requestRefresh?: () => Promise<void>` and
  `onIdle?: () => void`. Absent `requestRefresh`, the intent posts `refreshResult{ok:false}` —
  never a fabricated success. Optionality keeps every existing `SessionDeps` test literal green.
- `ChangeMapSession.isBusy()` (new, public) = `pendingWriteConfirmations.size > 0 ||
  pendingRunConfirmations.size > 0 || activeRuns.size > 0`. `onIdle()` is invoked wherever
  those collections are emptied (`confirmDirectWrite`, `handleRequestDirectWrite` catch,
  declined run, `executeRun`'s `finally`).
- **Auto-refresh guard**: `scheduleAutoRefresh()` debounces 750 ms, then checks `isBusy()`;
  busy ⇒ set `queued = true`, post `refreshDeferred` once, and return. `onIdle` re-arms the
  same debounced timer when `queued`. The pending confirmation is never resolved, cancelled,
  or dropped by refresh.
- Watcher lifetime: created only when the right selection is `kind: "worktree"` **and**
  `agentChangeMap.autoRefresh` is true; recreated/disposed from
  `workspace.onDidChangeConfiguration`; disposed on `panel.onDidDispose` together with the
  controller.

### State preservation across a landing refresh

| State | Mechanism |
|---|---|
| `expandedRuns` (diff collapse) | `webview/index.ts` gains `preservedRuns: Set<string>`. On `graphSummary` with `loadReason === "refresh"`, the current `expandedRuns` are copied into `preservedRuns`. The `sourcePair` case keeps its existing `expandedRuns.clear()` and then re-adds `preservedRuns`, emptying it. A plain second `sourcePair` (no refresh) has an empty `preservedRuns`, so the archived "second message resets to collapsed" test stays green untouched. |
| Unsaved draft text | `#draft-content`'s `value` is written only by `choosePair` and `navigateResult`; neither is triggered by a refresh landing. The refresh path is therefore *forbidden* from clearing it — the existing `graphSummary` reset block is guarded with `if (loadReason === "initial")`. |
| Selection | New `selectedNodeId`. After the refreshed `graph` renders, if the id still exists the webview rebinds `selectedPair` and re-issues `inspectSources`, but leaves `selected`/`editingEnabled` false: the pre-refresh `SourceId.contentHash` is stale against the new snapshot and `resolveSource` must keep refusing it. The user's typed text survives; re-navigation is one click. |

### SnapshotStore (LRU)

```ts
const MAX_SNAPSHOTS = 8;                  // 4 refresh generations x 2 sides
store(state)  { key = snapshotKey(...); this.snapshots.delete(key); this.snapshots.set(key, state);
                while (this.snapshots.size > MAX_SNAPSHOTS)
                  this.snapshots.delete(this.snapshots.keys().next().value!); }
get(id)       { … if found: delete + re-set to refresh recency, then return }
get size()    { return this.snapshots.size }   // test surface
```

`Map` iteration order is insertion order, so the first key is the least-recently-used.

## Graph Rendering (Slice C)

**Bezier edge** — replaces the 3-segment `L` elbow in `renderEdge`; `ELBOW_DROP` is renamed
`CURVE_MIN_DROP` keeping its value `16`:

```ts
const dy = Math.max(Math.round(Math.abs(tay - say) / 2), CURVE_MIN_DROP);
path = `M${sax},${say} C${sax},${say + dy} ${tax},${tay - dy} ${tax},${tay}`;
```

Both control points are vertical offsets from their own anchor, so the curve leaves the source
straight down and enters the target's top edge straight down — the end tangent is identical to
the elbow's final segment, so the existing `marker-end` /
`orient="auto-start-reverse"` arrowhead orientation is unchanged. When the target sits above or
level with the source, `tay - dy` lies above it and the result is an S-curve that still enters
downward. The ambiguous/unresolved dashed stub path is unchanged.

**Kind encoding** — `class`, `function`, `method` become mutually distinct on **two** channels:

| `kind` | `stroke-width` | `stroke-dasharray` | `rx` |
|---|---|---|---|
| `package` | `1` | `2 4` | `4` |
| `module` | `1.5` | `4 3` | `4` |
| `class` | `3.5` | — | `2` |
| `function` | `2.5` | — | `10` |
| `method` | `2` | — | `6` |

Containers (`1`, `1.5`) remain strictly thinner than every entity (`2`, `2.5`, `3.5`), so the
archived invariant holds; `method` reads as a lighter, less-round `function`.

**Label font** — `<text class="node-label" x="8" y="20">` in both `place()` and `renderFlatSvg`,
plus in `webview/styles.css`:

```css
.node text { fill: var(--vscode-editor-foreground, #ccc);
             font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace)); }
```

**Provenance** — `place()`/`renderFlatSvg` compute `const untracked = untrackedPaths.includes(node.span.path)`,
emit `data-provenance="untracked" | "tracked"` on the `<g class="node">`, and for untracked
nodes append `<circle class="provenance-untracked" cx="${w - 8}" cy="8" r="3"></circle>` after
the rect. `:root { --acm-provenance-untracked: #a371f7 }` and
`.provenance-untracked { fill: var(--acm-provenance-untracked); stroke: none }` — a hue used by
no status and no edge class.

**`:root` custom properties** — `--acm-status-added:#2ea043`, `--acm-status-removed:#f85149`,
`--acm-status-modified:#d29922`, `--acm-status-unchanged:#6e7681`, `--acm-edge-import:#4f9cf9`,
`--acm-edge-call:#c586c0`, `--acm-edge-ambiguous:#f0883e`, referenced by the existing rules.
Values are byte-identical to today's hexes.

### `data-*` contract (extended, not broken)

Every attribute in the archived table keeps its exact element, value, and emission site.
`data-provenance` is **added** to `<g class="node">`. `webview/index.ts`'s
`querySelectorAll("[data-node-id]")` / `("[data-edge-index]")` wiring and its
`graph.edges[index]` lookups still require zero changes.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/analysis/sourceFileMatcher.ts` | Create | `SourceFileMatcher`, `createSourceFileMatcher`, `defaultSourceFileMatcher` |
| `src/git/gitService.ts` | Modify | Matcher param on all capture entry points; `listUntrackedPaths`; `--untracked-files=all`; `provenance` on `CapturedFile`; `untrackedPaths` on `WorktreeCaptureBegin` |
| `src/comparisonController.ts` | Create | Owns references/repoRoot/extensionRoot/store/session; `capture()`, `refresh()`, auto-refresh watcher + debounce + busy guard |
| `src/extension.ts` | Modify | Command closure constructs the controller; `buildGraphForSelection` and the `.py` filter move out; watcher/controller disposal on `panel.onDidDispose` |
| `src/webviewHost.ts` | Modify | `requestRefresh` intent, `isBusy()`, `onIdle` calls, `untrackedPaths`/`loadReason` plumbed through `loadComparison`/`sendGraph` |
| `src/webviewProtocol.ts` | Modify | `requestRefresh`; `refreshResult`/`refreshDeferred`; `untrackedPaths`, `loadReason` |
| `src/snapshots/snapshotStore.ts` | Modify | LRU eviction, `size` getter |
| `webview/graphView.ts` | Modify | Bezier `d`, `KIND_STYLE.method`, `node-label` class, provenance attribute + badge, third `renderGraphSvg` param |
| `webview/index.ts` | Modify | Refresh button, `preservedRuns`, `selectedNodeId`, `loadReason`-guarded reset, `untrackedPaths` passthrough, `refreshResult`/`refreshDeferred` cases |
| `webview/styles.css` | Modify | `:root --acm-*`, `.node text` font-family, `.provenance-untracked` |
| `package.json` | Modify | `contributes.configuration`: `agentChangeMap.autoRefresh`, default `false` |
| `test/unit/sourceFileMatcher.test.ts` | Create | Matcher cases |
| `test/unit/comparisonController.test.ts` | Create | Refresh/deferral/watcher cases |

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | **Applicable** — the matcher now decides, at capture time, which worktree bytes are read at all. `requirements.txt`, `CMakeLists.txt`, `README.sh`, `setup.py` | The matcher is a pure extension predicate with **no** execution semantics; a matched file is only read and analyzed, never executed. `setup.py` matches (it is Python); `README.sh`/`requirements.txt`/`CMakeLists.txt` do not match and are never read. | One test each: untracked `README.sh` and `requirements.txt` excluded; untracked `setup.py` included and analyzed |
| Git repository selection | **Applicable** — a new git subprocess is added | `listUntrackedPaths` runs through the existing `runGit(canonicalPath, argv)`: `shell: false`, argv array (no interpolation), absolute cwd already validated by `validateWorktreeMembership`'s realpath containment, existing timeout and 64 MB output cap. No `git -C`, no user-supplied argument reaches argv. | One test: a worktree path escaping the repo still throws `GitSelectionError` before any untracked listing runs |
| Commit state | **Applicable** — staged, `commit -a`, empty index | Untracked listing is worktree-only; `captureCommitState` is untouched except for matcher filtering. A staged-then-modified file stays tracked; a staged brand-new file is tracked (not `--others`); an empty index yields untracked-only capture. | Three tests: staged-new file appears as `provenance: "tracked"`; empty index + one untracked `.py` captures that file; commit capture of the same repo contains no untracked file |
| Push state | **N/A** | No push, remote, or ref-writing operation exists anywhere in this change. | none |
| PR commands | **N/A** | No PR or `gh` automation exists in this codebase. | none |

## Testing Strategy

### Existing tests requiring review or rewrite (Slice A blast radius)

| File | Test | Change |
|---|---|---|
| `test/integration/gitState.test.ts` L183 | `"rejects a worktree capture containing a non-UTF-8 tracked file"` | **Rewrite.** `binary.dat` no longer matches the matcher, so it is never read and the test would go green for the wrong reason. Rename the fixture to `binary.py`. |
| `gitState.test.ts` L174 | commit-capture binary test | **Rewrite identically** — decision 2 filters commit capture too; `binary.dat` → `binary.py`. |
| `gitState.test.ts` L79 / L90 / L106 | the three instability tests | **Explicitly review** (required task, not an assumption). All three use only `a.py` in an otherwise clean tmp repo, so `--untracked-files=all` adds no noise and they should stay green byte-unchanged. Confirm no stray file (e.g. an editor backup) is created inside the fixture repo. |
| `gitState.test.ts` L142 | gitlink test | Review: `vendor` has no extension so it is now filtered twice over. Keep the mode-`160000` filter and assert it still runs *before* the matcher. |
| `gitState.test.ts` L43 / L61 / L124 / L134 / L162 | staged-dirty, empty index, limits, small-state | Review only; all fixtures are `.py`. Add a `provenance: "tracked"` expectation to each `toEqual` on `state.files` (they compare whole objects and will otherwise fail). |
| `test/unit/webviewHost.test.ts` (all `SessionDeps` literals) | — | Unchanged: `requestRefresh`/`onIdle` are optional. |
| `test/unit/graphView.test.ts` L185 | kind encoding | Extend: assert `method` ≠ `function` on both `stroke-width` and `rx`, containers still strictly thinner. |
| `graphView.test.ts` L223 | arrowhead test | Keep; add that the resolved path's `d` starts with `M` and contains `C` while ambiguous/unresolved stay `L` stubs with no `marker-end`. |
| `test/unit/webviewDom.test.ts` diff-collapse test | — | Keep as-is; it is the proof that `preservedRuns` did not change no-refresh behavior. |
| `test/e2e/scenarios.ts` | diagram/navigation scenarios | Must pass unchanged — the `data-*` contract proof. |

### New coverage (one RED test each)

**Slice 1 — untracked capture + matcher** (`sourceFileMatcher.test.ts`, `gitState.test.ts`)
1. Matcher: `.py` matches; `.PY` matches; `.pyc`/`.txt`/extensionless do not; a path containing
   `.py` mid-string (`a.python.txt`) does not.
2. Matcher: `createSourceFileMatcher([".py", ".sql"])` matches both — extensibility without rework.
3. A never-staged `.py` file appears in a worktree capture with `provenance: "untracked"`.
4. An untracked `.txt`/`README.sh`/`requirements.txt` is excluded (threat-matrix row 1).
5. An untracked `setup.py` is included (threat-matrix row 1).
6. A `.gitignore`d untracked `.py` is excluded by `--exclude-standard`.
7. Untracked file created after `begin` → `GitCaptureInstabilityError`.
8. Untracked file deleted after `begin` → `GitCaptureInstabilityError`.
9. Untracked file edited after `begin` (status letter unchanged) → `GitCaptureInstabilityError`.
10. Oversized untracked `.py` → `GitCaptureLimitError`; binary untracked `.py` → `GitBinaryContentError`.
11. Tracked + untracked count crossing `DTO_LIMITS.maxFiles` → `GitCaptureLimitError`.
12. `captureCommitState` of the same repo contains no untracked file and marks all `"tracked"`.
13. `computeContentDigest` is byte-identical for the same files with differing `provenance`
    (decision 4 proof).
14. Escaping worktree path rejected before any untracked listing (threat-matrix row 2).
15. Staged-new file is `"tracked"`, not `"untracked"` (threat-matrix row 3).

**Slice 2 — refresh + snapshot store** (`webviewHost.test.ts`, `comparisonController.test.ts`,
`webviewDom.test.ts`, `test/e2e/scenarios.ts`)
16. `requestRefresh` schema accepts a valid message and rejects a missing `requestId`.
17. `requestRefresh` with no `deps.requestRefresh` posts `refreshResult{ok:false}`.
18. `requestRefresh` re-runs capture and re-posts `graphSummary` + `graph`; a file created
    between the two captures appears in the second graph.
19. `isBusy()` is true with a pending write confirmation, a pending run confirmation, and an
    active run; false otherwise.
20. Manual refresh while busy → `refreshResult{ok:false}` and the pending confirmation still
    resolves normally afterwards.
21. Auto-refresh while busy → `refreshDeferred`, no recapture; on `onIdle` the queued refresh
    fires exactly once.
22. Auto-refresh debounce coalesces N watcher events into one capture.
23. Watcher events for a non-matching path do not schedule a refresh.
24. `agentChangeMap.autoRefresh` defaults false → no watcher created.
25. `SnapshotStore` evicts the least-recently-used past `MAX_SNAPSHOTS`; `get()` refreshes
    recency so the displayed pair is never evicted; re-storing identical content adds no entry.
26. Webview: `expandedRuns` survive a `loadReason: "refresh"` round trip; a plain second
    `sourcePair` still collapses.
27. Webview: `#draft-content` text survives a refresh landing; `selected` is cleared and a stale
    `saveDraft` is refused rather than silently applied.
28. e2e: refresh scenario — create a file, refresh, see the new node without reopening.

**Slice 3 — graph polish** (`graphView.test.ts`, `webviewDom.test.ts`)
29. Resolved edge `d` matches `/^M[\d.]+,[\d.]+ C/` with both control points offset vertically
    by `≥ CURVE_MIN_DROP`; `marker-end` still present.
30. Target above the source still yields a `C` path entering the target's top edge.
31. `KIND_STYLE` table exactly as specified; all three entity kinds mutually distinct.
32. Every `<text>` carries `class="node-label"` in both nested and flat layouts.
33. `webview/styles.css` declares a `font-family` for `.node text`.
34. Untracked node emits `data-provenance="untracked"` + one `<circle class="provenance-untracked">`;
    a tracked node emits `"tracked"` and no circle.
35. Provenance badge composes: an untracked+`removed` node keeps `class="node-box status-removed"`
    and its kind `stroke-width` unchanged.
36. `renderGraphSvg` called with the default (omitted) third argument marks every node `"tracked"`.
37. `:root` `--acm-*` properties exist and the status/edge rules reference them.

## Review Workload Forecast

Three natural chained-PR slices matching the proposal's three request groups; each has an
autonomous scope, its own verification, and an independent revert:

| PR | Scope | Est. authored lines |
|---|---|---|
| #1 | `sourceFileMatcher` + untracked capture + provenance field + `--untracked-files=all` + test rewrites | ~330 |
| #2 | `ComparisonController`, `requestRefresh`, auto-refresh guard, `SnapshotStore` LRU, state preservation | ~380 |
| #3 | Bezier, kind encoding, `node-label`/font, provenance badge, `--acm-*` properties | ~220 |

PR #1 targets the tracker branch, #2 targets #1, #3 targets #2. A single PR would land ~930
authored lines, well past the 400-line budget.

## Migration / Rollout

No migration, no persisted schema, no stored state. Host and webview ship in one build, so the
`requestRefresh`/`untrackedPaths`/`loadReason` shape changes cannot skew. `agentChangeMap.autoRefresh`
defaults to `false`, so an upgrade changes no runtime behavior until the user opts in. Each
slice reverts independently; reverting Slice A restores `listTrackedPaths`-only sourcing and
`--untracked-files=no`, but requires re-adding `buildGraphForSelection`'s `.py` filter — noted
here so a partial revert is not silently lossy.

## Open Questions

None.
