# Tasks: Diff View and Graph Styling

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 900–1,300 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Tracker branch → PR 1 (diff panel slice) → PR 2 (graph styling slice) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Slice A: host-side line diff + two-column diff panel | PR 1 | `npm run test:unit -- lineDiff webviewHost webviewProtocol webviewDom` | `npm run test:e2e` (diagram/nav scenarios) | `src/diff/lineDiff.ts`, `src/webviewHost.ts`, `src/webviewProtocol.ts`, `webview/index.ts` diff bits, `webview/styles.css` diff rules, `test/unit/lineDiff.test.ts` |
| 2 | Slice B: nested containment layout, kind encoding, drawn edges, flat-degradation | PR 2 | `npm run test:unit -- graphView` | `npm run test:e2e` (diagram/nav scenarios) | `webview/graphView.ts`, `webview/styles.css` node-box rules |

Slices are independent per design (no shared runtime code); each is revertible without touching the other.

## Phase 1: Slice A — Vendored Line Diff (`src/diff/lineDiff.ts`)

- [x] 1.1 RED `test/unit/lineDiff.test.ts`: identical sides → all `unchanged`; pure insertion; pure deletion; empty side (all-`added`/all-`removed`); one-side-missing; non-1 `leftStartLine`/`rightStartLine` offsets reflected in `leftLine`/`rightLine`.
- [x] 1.2 GREEN create `src/diff/lineDiff.ts`: BSD-3-Clause header (verbatim jsdiff notice, not MIT), vendored Myers `diffLines(left, right, offsets)` returning `DiffOp[]`, trailing-newline handling matching current `contentLines` semantics.
- [x] 1.3 REFACTOR: confirm no runtime imports outside `src/diff/`; `tsconfig.webview.json` still excludes it (webview only imports the `DiffOp` type, erased).

## Phase 2: Slice A — Wire Protocol and Host

- [x] 2.1 RED update `sourcePair` schema test coverage in protocol tests: `sources[]` entries drop `affectedLines`; new top-level `ops: DiffOp[]` field required.
- [x] 2.2 GREEN edit `src/webviewProtocol.ts`: `sourcePair` gains `ops: DiffOp[]`, drops `affectedLines` from each source entry.
- [x] 2.3 RED rewrite `test/unit/webviewHost.test.ts` L98-108 (`"marks every extant line affected when a source has no counterpart"`) to assert `ops` are all `{ op: "added", rightLine: 1 }` (or `"removed"` for the missing-right case) and that no `affectedLines` key is posted.
- [x] 2.4 GREEN edit `src/webviewHost.ts`: delete `affectedLinesForSources` and `contentLines`; in `inspectSources` build `sources` without `affectedLines`, call `diffLines(left?.content ?? "", right?.content ?? "", { leftStartLine: left?.startLine ?? 1, rightStartLine: right?.startLine ?? 1 })`, post `{ type: "sourcePair", sources, ops }`.

## Phase 3: Slice A — Diff Panel Rendering and Collapse State

- [x] 3.1 RED split `test/unit/webviewDom.test.ts` L109-122 (`"identifies affected comparison lines and navigates…"`): drop `toContain("Affected lines: 1")` and flat `<pre>` expectations; assert `.diff-row.op-removed`/`.op-added` DOM content and ghost cells. Leave the edge-navigation half of this test file untouched — it is the click-contract proof and must stay green throughout this phase.
- [x] 3.2 RED new case: ghost column — a one-sided pair (all-added or all-removed `ops`) still emits both `.side` cells per row, with the missing side's `<code class="side ghost">` empty.
- [x] 3.3 RED new case: click-to-expand — a collapsed run (`COLLAPSE_MIN_RUN = 6` unchanged ops, `CONTEXT = 3` visible at each boundary) toggles open then closed via `data-run-key`; a second `sourcePair` message resets `expandedRuns` to empty (collapsed).
- [x] 3.4 GREEN edit `webview/index.ts`: add `renderDiffPanel(ops, expandedRuns)` building the four-column CSS grid DOM (`.diff-row`, `.ln`, `.side`/`.side ghost`, `.diff-collapsed` buttons) via `createElement`/`textContent` only; module-level `expandedRuns: Set<string>` and `lastOps: DiffOp[]`; `sourcePair` case calls `expandedRuns.clear()` before rendering and stores `lastOps`; click handler toggles run key and re-renders from `lastOps`.
- [x] 3.5 GREEN edit `webview/styles.css`: add diff grid, ghost-column, `.muted` (unchanged rows), and `.diff-collapsed` run rules.
- [x] 3.6 REFACTOR: confirm `webviewDom.test.ts` L100-107 (oversized/section test) is unchanged and still passes, guarding the 300-node host gate precedes rendering.

## Phase 4: Slice B — Nested Containment Geometry (`webview/graphView.ts`)

- [ ] 4.1 RED new case: nested geometry — a child `<g>`'s transform-derived box lies fully inside its parent's rect bounds; three-level nesting (module → class → method) all contained correctly.
- [ ] 4.2 RED new case: orphan node — an entity whose `containerId` refers to a container filtered out by `filterGraph` renders as a loose root, no placeholder box.
- [ ] 4.3 RED rewrite `graphView.test.ts` L41-47 (`"renders every node and edge…"`): keep as the `data-node-id` stability test; add assertion that `function:pkg.a.f`'s `<g>` is a DOM descendant of `module:pkg.a`'s `<g>`.
- [ ] 4.4 GREEN implement `childrenOf` map (containerId normalized to `undefined` when absent from `graph.nodes`), `measure(n)` bottom-up sizing, `place(n, x, y)` top-down absolute placement recording `boxes: Map<nodeId, Rect>`, roots stacked at `x=MARGIN` with `ROOT_GAP`, cycle guard (`visited` set demoting repeat-reached nodes to loose roots). Use named constants `NODE_H=32, HEADER_H=20, PAD_X=12, PAD_Y=10, GAP_Y=8, NODE_MIN_W=200, ROOT_GAP=24, MARGIN=16`.

## Phase 5: Slice B — Kind Encoding and Outline-Only Styling

- [ ] 5.1 RED new case: kind encoding — `stroke-width`/`stroke-dasharray`/`rx` match the design table per kind (`package`, `module`, `class`, `function`, `method`); containers strictly thinner than every entity; `class` distinguished from `function`/`method` on both width and `rx`.
- [ ] 5.2 RED new case: outline-only — every `<rect class="node-box">` carries `fill="none"`; status class still present.
- [ ] 5.3 RED rewrite `graphView.test.ts` L56-65 (`"distinguishes added, removed, and modified…"`): keep `data-change-status`; add `fill="none"` assertion on every rect.
- [ ] 5.4 GREEN implement `renderNodeRect` emitting inline `stroke-width`/`stroke-dasharray`/`rx`/`fill="none"` per the kind-encoding table, `.node-box.status-*` class for stroke color only.
- [ ] 5.5 GREEN edit `webview/styles.css`: change the four `.node-box.status-*` rules from `fill:` to `stroke:`; add `.node-box { fill: none }` and `.node-box.status-unchanged { stroke: #6e7681 }`.

## Phase 6: Slice B — Directional Edges and Ambiguity

- [ ] 6.1 RED new case: arrowhead — resolved `import`/`call` edges carry `marker-end`; ambiguous/unresolved edges do not.
- [ ] 6.2 RED new case: `contains` contributes no `<g class="edge">` element, while surviving edges retain their original `graph.edges` array indices.
- [ ] 6.3 RED rewrite `graphView.test.ts` L49-54 (`"explicitly marks ambiguous and unresolved edges…"`): keep `data-resolution` assertions; drop reliance on `<text class="edge-label">`; add "no `marker-end` on ambiguous/unresolved".
- [ ] 6.4 RED delete `graphView.test.ts` L81-85 (`"lays relationship text below every node box"`) — `.edge-label` text no longer exists; covered by 6.1/6.3 instead.
- [ ] 6.5 GREEN implement one `<defs>` block with `#acm-arrow-import`/`#acm-arrow-call` markers; `renderEdge` computing anchors (source bottom-center, target top-center) and elbow path (`ELBOW_DROP = 16`); ambiguous/unresolved/target-not-in-view edges render a dashed downward stub (`STUB_LEN = 28`, `stroke-dasharray="4 3"`, no `marker-end`), retaining `<title>` and `data-resolution`; `.edge-import`/`.arrow-import` `#4f9cf9`, `.edge-call`/`.arrow-call` `#c586c0`, ambiguity `#f0883e`; edge loop iterates `graph.edges` by index so `contains` skips rendering without shifting indices.

## Phase 7: Slice B — Flat-Degradation Threshold

- [ ] 7.1 RED new case: degradation — a 61-node graph renders via the flat stack yet stays outline-only with drawn edges (kind encoding and markers preserved).
- [ ] 7.2 GREEN add `export const NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 } as const` in `webview/graphView.ts`; check at the top of `renderGraphSvg`, returning `renderFlatSvg(...)` above the limit; `renderFlatSvg` keeps `y = 24 + index * 48` stack geometry but shares `renderNodeRect`/`renderEdge` with the nested path.
- [ ] 7.3 REFACTOR: confirm `NESTED_LAYOUT_LIMITS` reads/writes nothing shared with `OVERSIZED_THRESHOLDS` (300/600) and the two gates stay sequential and independent.

## Phase 8: Data Attribute Contract and Full Verification

- [ ] 8.1 RED new case: `data-*` stability — full attribute set (`data-node-id`, `data-node-kind`, `data-change-status`, `data-edge-index`, `data-edge-kind`, `data-resolution`) present with exact current values under the new nested/styled rendering.
- [ ] 8.2 GREEN verify `webview/index.ts`'s `querySelectorAll("[data-node-id]")`/`("[data-edge-index]")` wiring and `graph.edges[index]`/`message.edgeSources[index]` lookups require zero edits; if any edit is needed, treat it as a contract break and stop.
- [ ] 8.3 Verify `test/e2e/scenarios.ts` diagram and navigation scenarios pass unchanged — the top-layer click-contract proof.
- [ ] 8.4 Run `npm run lint && npm run typecheck && npm run test` (unit + integration + e2e) and confirm all green; document any environment-gated skips per existing README convention.
