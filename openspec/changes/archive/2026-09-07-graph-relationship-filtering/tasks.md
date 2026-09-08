# Tasks: Graph Relationship Filtering

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~470 total (PR1 ~180, PR2 ~200, PR3 ~90 — design's own forecast, confirmed by this breakdown) |
| 400-line budget risk | Low — every PR is individually well inside the 400-line budget |
| Chained PRs recommended | Yes |
| Suggested split | Tracker branch → PR 1 (ancestor self-reference suppression) → PR 2 (edge vintage host + protocol) → PR 3 (vintage toolbar control) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No — each PR is independently under budget and the chain order matches
the design's own dependency order (PR 2 builds on PR 1's suppressed graph; PR 3 only adds UI atop PR 2's
already-working default).
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Rollback boundary |
|---|---|---|---|---|
| 1 | `isAncestorSelfReference` + `suppressAncestorSelfReferences` in `graphView.ts`, wired into `webviewHost.ts`'s `sendGraph`/`loadComparison` pipeline before `filterGraph` | PR 1 (base: tracker branch) | `npx vitest run test/unit/graphView.test.ts test/unit/relationshipDetails.test.ts` | `webview/graphView.ts` new exports, `src/webviewHost.ts` pipeline insertion — revert restores every self-reference edge |
| 2 | `buildEdgeVintages` in `webviewHost.ts` (dedupe `edgeKey`), `GraphFilter.vintages` + `filterGraph` 4th param in `graphView.ts`, `edgeOrigins`/`vintages` on the wire protocol, `DEFAULT_VINTAGES` applied host-side | PR 2 (base: PR 1 branch) | `npx vitest run test/unit/webviewHost.test.ts test/unit/webviewProtocol.test.ts` | `src/webviewHost.ts` vintage derivation + default, `src/webviewProtocol.ts` schema fields — revert restores merged (un-vintage-filtered) edges with no wire change |
| 3 | `#filter-vintage` checkbox-group fieldset + `requestView()` wiring in `webview/index.ts`, `webview/styles.css` fieldset rules | PR 3 (base: PR 2 branch) | `npx vitest run test/unit/webviewDom.test.ts` | `webview/index.ts` fieldset + listener, `webview/styles.css` rules — revert leaves PR 2's default (`current`-only) behavior with no user control |

Per the design's Rollback Plan: PR 1 is independent of PR 2-3 and could be landed alone if the vintage
work stalls; PR 2 without PR 3 already ships the ghost-edge fix with `vintages` defaulted host-side.

## Phase 1: Ancestor Self-Reference Suppression (PR 1, base: tracker branch)

- [x] 1.1 RED `test/unit/graphView.test.ts` — add `selfRefGraph()` fixture (module → class → method chain, plus two peer functions in one file, per the design's Testing Strategy).
- [x] 1.2 RED `test/unit/graphView.test.ts` — `isAncestorSelfReference`: true for module→own class (direct parent) and module→own nested method (transitive, multi-step ancestor).
- [x] 1.3 RED `test/unit/graphView.test.ts` — `isAncestorSelfReference`: false for peer function→sibling function in the same file (neither is the other's ancestor/descendant).
- [x] 1.4 RED `test/unit/graphView.test.ts` — `isAncestorSelfReference`: false for `contains`-kind edges, unresolved edges, ambiguous edges, and edges referencing an unknown id.
- [x] 1.5 RED `test/unit/graphView.test.ts` — `isAncestorSelfReference`: false and terminating (no throw/hang) on a `containerId` cycle (a↔b) and on a dangling `containerId`; true when `edge.source === edge.resolution.target`.
- [x] 1.6 GREEN `webview/graphView.ts`: add `export type EdgeVintage = "current" | "removed";` and `export function isAncestorSelfReference(edge: Edge, nodes: readonly Entity[]): boolean` next to `sectionScope`'s `containerId` walk — walk from `byId.get(edge.resolution.target)` ascending `containerId` looking for `edge.source`, `seen: Set<string>` cycle guard, missing `containerId` ends the walk, equal source/target counts as self-reference. Make cases 1.2–1.5 pass.
- [x] 1.7 RED `test/unit/graphView.test.ts` — `suppressAncestorSelfReferences`: drops only the ancestor self-reference edges from `selfRefGraph()`, leaves `nodes` array identical (same reference or deep-equal).
- [x] 1.8 GREEN `webview/graphView.ts`: add `export function suppressAncestorSelfReferences(graph: AnalysisGraph): AnalysisGraph` — unconditional pre-filter dropping every `isAncestorSelfReference` edge, nodes untouched. Make 1.7 pass.
- [x] 1.9 RED `test/unit/graphView.test.ts` — rendering: `renderGraphSvg(suppressAncestorSelfReferences(selfRefGraph()), [])` emits no `<g class="edge">` for the suppressed edge, and the suppressed edge's `data-relationship-source`/`data-relationship-target` indicator count on the affected node excludes it.
- [x] 1.10 GREEN confirm case 1.9 passes with no additional production code (pure consequence of 1.6/1.8 — indicator counts already derive from `graph.edges`).
- [x] 1.11 RED `test/unit/relationshipDetails.test.ts` (new file) — regression case: a graph passed through `suppressAncestorSelfReferences` produces a details popup with no `<li>` for the suppressed edge, and remaining `edgeIndex` values still address the correct (unsuppressed) edges in the original `graph.edges` array.
- [x] 1.12 GREEN confirm case 1.11 passes (no `relationshipDetails.ts` production change needed — Decision 1: the graph handed to it is already suppressed upstream). If it fails, wire the suppressed graph into whatever test harness constructs `relationshipDetails.ts`'s input, per Decision 1 — `relationshipDetails.ts` itself stays unchanged.
- [x] 1.13 RED `test/unit/webviewHost.test.ts` — `graphSummary.edgeCount` excludes an ancestor self-reference edge present in the underlying analysis graphs.
- [x] 1.14 GREEN edit `src/webviewHost.ts`: insert `suppressAncestorSelfReferences` into the `sendGraph`/`loadComparison` pipeline immediately after `mergeGraphsForDisplay`, before `filterGraph` and before `graphSummary.edgeCount` is computed. Make 1.13 pass.
- [x] 1.15 Run `npm run lint && npm run typecheck && npx vitest run test/unit test/integration` and confirm all green before opening PR 1 against the tracker branch for this change.

## Phase 2: Edge Vintage — Host + Protocol (PR 2, base: PR 1 branch)

- [x] 2.1 RED `test/unit/webviewHost.test.ts` — `buildEdgeVintages`: a byte-shifted left/right pair yields `["current","removed"]` for the two surviving merged edges (ghost-duplicate scenario from the proposal).
- [x] 2.2 RED `test/unit/webviewHost.test.ts` — `buildEdgeVintages`: an edge present on both sides is `"current"`.
- [x] 2.3 RED `test/unit/webviewHost.test.ts` — `buildEdgeVintages`: an edge present only on the left (original) side is `"removed"`.
- [x] 2.4 RED `test/unit/webviewHost.test.ts` — `buildEdgeVintages`: an edge whose `span.path` is in `untrackedPaths` is `"current"` even with no right-side match.
- [x] 2.5 RED `test/unit/webviewHost.test.ts` — `buildEdgeVintages`: vintages are correct with a `SnapshotStore` that has no stored content (`store.getFileContent` failure has no effect — success criterion 7).
- [x] 2.6 GREEN edit `src/webviewHost.ts`: fold `mergeGraphsForDisplay`'s inline `edgeKey` local into the existing module-level `edgeKey` (one definition governs merge, source index, and vintage). Add `export function buildEdgeVintages(left: AnalysisGraph | undefined, right: AnalysisGraph | undefined, graph: AnalysisGraph, untrackedPaths: readonly string[]): EdgeVintage[]` beside `buildEdgeSourceIndex` — `"current"` when `right?.edges` has the key OR `untrackedPaths.includes(edge.span.path)`, otherwise `"removed"`. Make cases 2.1–2.5 pass.
- [x] 2.7 RED `test/unit/graphView.test.ts` — `filterGraph`: `vintages: ["current"]` keeps only the edges whose index-aligned vintage is `"current"`.
- [x] 2.8 RED `test/unit/graphView.test.ts` — `filterGraph`: `vintages: []` and `vintages: undefined` filter nothing (existing "empty = All" semantics).
- [x] 2.9 RED `test/unit/graphView.test.ts` — `filterGraph`: vintage filtering composes correctly with an existing `relationshipKinds` filter (both applied, intersection result).
- [x] 2.10 GREEN edit `webview/graphView.ts`: add `vintages?: EdgeVintage[]` to `GraphFilter`; change `filterGraph` signature to `filterGraph(graph: AnalysisGraph, diff: CorrelatedDiffEntry[], filter: GraphFilter, vintages?: readonly EdgeVintage[])` where `vintages` is index-aligned with the **input** `graph.edges`. Make cases 2.7–2.9 pass.
- [x] 2.11 RED `test/unit/webviewProtocol.test.ts` — `requestGraphView` without `vintages` is rejected (field is required, no `.optional()`/`.default()`, matching the sibling arrays' style).
- [x] 2.12 RED `test/unit/webviewProtocol.test.ts` — `requestGraphView` with `vintages: ["current"]` is accepted.
- [x] 2.13 RED `test/unit/webviewProtocol.test.ts` — `requestGraphView` with `vintages: ["stale"]` is rejected (enum violation).
- [x] 2.14 RED `test/unit/webviewProtocol.test.ts` — `requestGraphView` with 3 vintage entries is rejected (`.max(2)`).
- [x] 2.15 GREEN edit `src/webviewProtocol.ts`: add `vintages: z.array(z.enum(["current", "removed"])).max(2)` to the inbound `requestGraphView` schema; add `edgeOrigins: ("current" | "removed")[]` (inline union, no `src` → `webview` import) to the outbound `graph` message, documented as index-aligned with `graph.edges`. Make cases 2.11–2.14 pass.
- [x] 2.16 RED `test/unit/webviewHost.test.ts` — the `graph` message's `edgeOrigins.length === graph.edges.length`.
- [x] 2.17 RED `test/unit/webviewHost.test.ts` — default `sendGraph()` (no filter) already omits the left-only ghost edge from the byte-shift scenario (criterion 4: hidden before the user touches the toolbar).
- [x] 2.18 RED `test/unit/webviewHost.test.ts` — `requestGraphView` with `vintages: ["current","removed"]` restores the left-only ghost edge.
- [x] 2.19 RED `test/unit/webviewHost.test.ts` — `requestGraphView` with `vintages: ["removed"]` hides the current/worktree edge.
- [x] 2.20 GREEN edit `src/webviewHost.ts`: define `const DEFAULT_VINTAGES: EdgeVintage[] = ["current"]`; in `sendGraph`/`loadComparison`, run `buildEdgeVintages` against the suppressed graph, call `filterGraph(suppressed, diff, filter, filter?.vintages ?? DEFAULT_VINTAGES)` to produce `display`, then re-run `buildEdgeVintages(display)` (not index-mapped through the filter) to compute the posted `edgeOrigins`, alongside `buildEdgeSourceIndex(display)`. Make cases 2.16–2.19 pass.
- [x] 2.21 GREEN update the existing `requestGraphView` intent fixture at `test/unit/webviewHost.test.ts:356` to include `vintages: []` so it keeps compiling/passing against the now-required field.
- [x] 2.22 Run `npm run lint && npm run typecheck && npx vitest run test/unit test/integration` and confirm all green before opening PR 2 against the PR 1 branch.

## Phase 3: Vintage Toolbar Control (PR 3, base: PR 2 branch)

- [x] 3.1 RED `test/unit/webviewDom.test.ts` — `#filter-vintage` fieldset exists after `initialize()` with `#vintage-current` checked and `#vintage-removed` unchecked (default state).
- [x] 3.2 RED `test/unit/webviewDom.test.ts` — toggling `#vintage-removed` (checking it) posts a `requestGraphView` message whose `vintages` is `["current","removed"]`.
- [x] 3.3 RED `test/unit/webviewDom.test.ts` — unchecking both `#vintage-current` and `#vintage-removed` posts a `requestGraphView` message whose `vintages` is `[]`.
- [x] 3.4 GREEN edit `webview/index.ts` `initialize()`: after `selectControl("filter-status", …)`, build the vintage `<fieldset id="filter-vintage">` with a `<legend>Vintage</legend>` and one checkbox per `["current", "removed"] as const` (`id="vintage-${value}"`, `checked = value === "current"`, `change` listener calling `requestView`), appended to `#toolbar` — modeled exactly on the existing "Run variants" fieldset pattern. Edit `requestView()` to compute `const vintages = (["current","removed"] as const).filter(v => byId<HTMLInputElement>(\`vintage-${v}\`).checked);` and include it in the posted `requestGraphView` message. Make cases 3.1–3.3 pass.
- [x] 3.5 GREEN edit `webview/styles.css`: add `#toolbar fieldset { display: flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-panel-border, #333); padding: 2px 8px; margin: 0; }` and `#toolbar fieldset legend { padding: 0 4px; font-size: 0.85em; }`.
- [x] 3.6 REFACTOR: confirm `src/extension.ts` and `webview/relationshipDetails.ts` remain unchanged (deliberate, per the design's File Changes table) and that `test/unit/webviewDom.test.ts:29`'s JSDOM fixture needed no edit (control is built in `index.ts`, not static HTML).
- [x] 3.7 Run `npm run lint && npm run typecheck && npx vitest run test/unit test/integration` and confirm all green before opening PR 3 against the PR 2 branch.
</content>
