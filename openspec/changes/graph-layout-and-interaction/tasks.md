# Tasks: Graph Layout and Interaction

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~870 total (PR1 ~360, PR2 ~340, PR3 ~170 — design's own forecast, confirmed by this breakdown) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Tracker branch → PR 1 (edgeGeometry + routing + sibling ordering) → PR 2 (positionOverrides + drag) → PR 3 (wheel-zoom) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | `edgeGeometry.ts` extraction + waypoint routing + Kahn sibling order + `viewBox` attrs | PR 1 (base: tracker branch) | `npm run test:unit -- edgeGeometry graphView` | `npm run test:e2e` (click-navigation stays green) | `webview/edgeGeometry.ts`, `webview/graphView.ts` routing/ordering/`viewBox` edits, `tsconfig.build.json` include entry |
| 2 | `positionOverrides.ts` + pointer-drag state machine + drag CSS | PR 2 (base: PR 1 branch) | `npm run test:unit -- positionOverrides webviewDom` | `npm run test:e2e` (click-navigation, disambiguation) | `webview/positionOverrides.ts`, `webview/index.ts` drag wiring, `webview/styles.css` `.dragging` rule |
| 3 | Wheel-zoom handler + `resetViewBox` wiring | PR 3 (base: PR 2 branch) | `npm run test:unit -- webviewDom` | `npm run test:e2e` (no regression to panel scroll) | `webview/index.ts` wheel handler + `resetViewBox`, no host/protocol change |

Each slice is independently revertible per the design's Migration/Rollout section: dropping PR 3
removes the `viewBox` reset/wheel listener only; dropping PR 2 removes pointer wiring and the
override map; dropping PR 1 restores the inline fixed-anchor Bezier and array-order siblings.

## Phase 1: Slice A — `edgeGeometry.ts` (PR 1)

- [x] 1.1 RED `test/unit/edgeGeometry.test.ts` — Case 1: `segmentIntersectsRect` true through a box, false on a boundary touch, false for a box aside.
- [x] 1.2 RED `test/unit/edgeGeometry.test.ts` — Case 2: `edgePathFor` with no obstacles and a resolved target matches the existing byte-identical Bezier golden.
- [x] 1.3 RED `test/unit/edgeGeometry.test.ts` — Case 3: missing target box → unchanged dashed stub, never routed even with intersecting obstacles.
- [x] 1.4 RED `test/unit/edgeGeometry.test.ts` — Case 4: one intervening box → `d` contains `M`/`L`/`C`, waypoint x is `DETOUR_CLEARANCE` clear of the obstacle.
- [x] 1.5 RED `test/unit/edgeGeometry.test.ts` — Case 5: side choice — obstacle left of the line detours right, mirrored fixture detours left, centred tie → left.
- [x] 1.6 RED `test/unit/edgeGeometry.test.ts` — Case 6: two stacked obstacles → two waypoints in top-to-bottom encounter order.
- [x] 1.7 RED `test/unit/edgeGeometry.test.ts` — Case 7: more obstacles than `MAX_DETOURS` terminates, `<= MAX_DETOURS` waypoints, well-formed `d`, no throw.
- [x] 1.8 RED `test/unit/edgeGeometry.test.ts` — Case 8: `obstaclesFor` excludes source/target boxes, any ancestor box containing an anchor, and any box fully inside source/target.
- [x] 1.9 RED `test/unit/edgeGeometry.test.ts` — Case 9: every routed `d` ends with a `C` landing exactly on the target top-center anchor.
- [x] 1.10 GREEN create `webview/edgeGeometry.ts` (pure, no DOM, no imports): `Rect`, `Point`, `CURVE_MIN_DROP=16`, `STUB_LEN=28`, `DETOUR_CLEARANCE=12`, `MAX_DETOURS=3`, `sourceAnchor`, `targetAnchor`, `segmentIntersectsRect` (Liang–Barsky slab, `EPS=1e-6`), `obstaclesFor`, `routeWaypoints`, `edgePathFor` — implement exactly the design's path-string format table and detour-loop pseudocode. Make cases 1.1–1.9 pass.
- [x] 1.11 GREEN edit `tsconfig.build.json`: add `webview/edgeGeometry.ts` to `include` (`tsconfig.webview.json` needs no change — `webview/**/*.ts` already covers it).
- [x] 1.12 REFACTOR: confirm `edgeGeometry.ts` has zero imports and zero DOM references (dual-compile safety).

## Phase 2: Slice A — Wire `graphView.ts` to `edgeGeometry` (PR 1)

- [x] 2.1 GREEN edit `webview/graphView.ts`: delete local `Rect`, `CURVE_MIN_DROP`, `STUB_LEN`, and `renderEdge`'s inline path computation; import `edgePathFor` from `./edgeGeometry.js` and call `edgePathFor(boxes, edge.source, targetId)`.
- [x] 2.2 RED `test/unit/graphView.test.ts` — Case 13: a fixture whose straight edge crosses an unrelated box renders a `d` containing `L` waypoints.
- [x] 2.3 RED `test/unit/graphView.test.ts` — Case 14: the existing non-crossing fixture's `d` is byte-unchanged (majority-case regression proof).
- [x] 2.4 GREEN confirm 2.2/2.3 pass through the wired `edgePathFor` call from 2.1.

## Phase 3: Slice A — Sibling Ordering (PR 1)

- [x] 3.1 RED `test/unit/graphView.test.ts` — Case 15: siblings with a `call` edge B→A place A above B (rendered `transform` y order).
- [x] 3.2 RED `test/unit/graphView.test.ts` — Case 16: siblings with no non-`contains` edges keep exact array order.
- [x] 3.3 RED `test/unit/graphView.test.ts` — Case 17: a sibling cycle (A→B, B→A) emits every sibling exactly once, deterministically.
- [x] 3.4 RED `test/unit/graphView.test.ts` — Case 18: root-level nodes obey the same ordering.
- [x] 3.5 GREEN edit `webview/graphView.ts`: add `edges` param to `computeChildrenOf`, implement the Kahn topological sort per bucket exactly as the design specifies (smallest-original-index tie-break, cycle handling), plugged in after bucketing and before `place()`. `renderFlatSvg` stays array-order/untouched.
- [x] 3.6 REQUIRED VERIFICATION — RAN and the design's own prediction did **NOT** fully hold; declared explicitly (not silently edited), see "Deviations" in the apply report. Root cause: the design's literal "add arc source→target" pseudocode, read with standard Kahn convention (u before v), places the caller before the callee — but tasks.md Case 15 explicitly requires the opposite ("call edge B→A place A above B"). Implemented the arc as `target -> source` (callee ready before caller) to satisfy Case 15/18, which are the concrete, unambiguous acceptance criteria. This exposed a second-order effect the design didn't anticipate: `nestedGraph()`'s root bucket has exactly the "single arc" the design describes (from `function:pkg.a.f`, nested inside `package:pkg`, calling root-level `function:pkg.b.g`), and with the corrected arc direction this reverses `package:pkg` vs `function:pkg.b.g`'s root order (design predicted it would match array order under the literal, non-reversed arc reading). Two pre-existing assertions were rewritten as a result (not silently): the "Bezier edges: control-point drop" test and the Phase-2 "byte-unchanged" golden test were switched from `nestedGraph()` to minimal two-node fixtures, since their intent (pure-formula/no-obstacle invariants) is independent of `nestedGraph()`'s specific layout, which now legitimately produces a routed (waypointed) edge for that one call edge.

## Phase 4: Slice A — `viewBox` Attribute and Data Contract (PR 1)

- [x] 4.1 RED `test/unit/graphView.test.ts` — Case 19: both `renderGraphSvg` and `renderFlatSvg` roots carry `viewBox="0 0 {width} {height}"` matching their `width`/`height`.
- [x] 4.2 GREEN edit `webview/graphView.ts`: emit `viewBox="0 0 {width} {height}"` on both SVG roots (attribute only — no wheel logic here; that belongs to PR 3's `webview/index.ts` work per the design's File Changes table).
- [x] 4.3 RED `test/unit/graphView.test.ts` — Case 20: `KIND_STYLE`, status classes, and every `data-*` attribute are unchanged on the routed fixture.
- [x] 4.4 GREEN confirm case 20 passes with no incidental `data-*` change from Phases 1–3's edits.
- [x] 4.5 Run `npm run lint && npm run typecheck && npm run test:unit -- edgeGeometry graphView && npm run test:e2e` and confirm all green before opening PR 1 against the tracker branch.

## Phase 5: Slice B — `positionOverrides.ts` (PR 2, base: PR 1 branch)

- [ ] 5.1 RED `test/unit/positionOverrides.test.ts` — Case 10: `set`/`get` round-trip; `set` on an existing id refreshes recency.
- [ ] 5.2 RED `test/unit/positionOverrides.test.ts` — Case 11: exceeding `MAX_POSITION_OVERRIDES` evicts the least-recently-set id; `size` stays capped.
- [ ] 5.3 RED `test/unit/positionOverrides.test.ts` — Case 12: `pruneTo` drops ids absent from the present set, keeps present ones, never throws.
- [ ] 5.4 GREEN create `webview/positionOverrides.ts` (pure, no DOM): `MAX_POSITION_OVERRIDES=200`, `Offset { dx, dy }`, `PositionOverrides` class (`get`, `set` delete-then-set LRU touch + evict oldest, `pruneTo`, `size`).

## Phase 6: Slice B — Drag State Machine Wiring (PR 2)

- [ ] 6.1 GREEN edit `webview/index.ts`: add module state exactly as the design specifies — `DRAG_THRESHOLD=5`, `positionOverrides`, `baseTransforms`, `dragState`, `suppressNextClick`, plus `readBoxes()` (parse ancestor `translate(x,y)` off `<g>`s, `w`/`h` off child `<rect>`).
- [ ] 6.2 GREEN implement `pointerdown`: `stopPropagation`, `suppressNextClick = false`, `movedIds` from the DOM subtree (dragged `<g>` + `querySelectorAll("[data-node-id]")`), snapshot `boxes`, cache affected `edges`, feature-guarded `setPointerCapture`, bind `pointermove`/`pointerup` on `document`.
- [ ] 6.3 GREEN implement `pointermove`: below `DRAG_THRESHOLD` → return with no side effect; above threshold → `moved=true`, add `.dragging` class, update dragged `<g>` `transform`, build `liveBoxes` from the snapshot offset by accumulated delta, recompute each cached edge's `d` via `edgePathFor(liveBoxes, …)`.
- [ ] 6.4 GREEN implement `pointerup`: if `moved` → commit `positionOverrides.set`, full edge pass over `liveBoxes`, remove `.dragging`, `suppressNextClick=true`; if `!moved` → no-op, native click fires unchanged. Release capture, clear `dragState`.
- [ ] 6.5 GREEN edit the existing per-node click listener: add `if (suppressNextClick) return;` guard before `choosePair(...)`, cleared only by the next `pointerdown` (never by the click handler itself).
- [ ] 6.6 GREEN edit `webview/styles.css`: add `.node.dragging { cursor: grabbing; }` (existing `.node, .edge { cursor: pointer; }` untouched).

## Phase 7: Slice B — Drag and Persistence Test Cases (PR 2)

- [ ] 7.1 RED `test/unit/webviewDom.test.ts`: add the `drag(selector, from, to)` helper (composed from a `pointer(type, target, x, y)` primitive) alongside the existing `click()` helper.
- [ ] 7.2 RED `test/unit/webviewDom.test.ts` — Case 21: above-threshold drag updates the dragged node's `transform`.
- [ ] 7.3 RED `test/unit/webviewDom.test.ts` — Case 22: an attached edge's `d` changes after a `pointermove`, before `pointerup` (live re-route proof, not on-drop).
- [ ] 7.4 RED `test/unit/webviewDom.test.ts` — Case 23: below-threshold (2px) sequence still fires click-to-navigate (`inspectSources` posted).
- [ ] 7.5 RED `test/unit/webviewDom.test.ts` — Case 24: above-threshold drag posts no `inspectSources` (click suppressed); a subsequent full pointerdown→click still navigates.
- [ ] 7.6 RED `test/unit/webviewDom.test.ts` — Case 25: container drag — a descendant's edge `d` equals `edgePathFor` over boxes offset by the accumulated delta.
- [ ] 7.7 RED `test/unit/webviewDom.test.ts` — Case 26: a dragged position survives a simulated refresh render (`transform` = base + dx/dy).
- [ ] 7.8 RED `test/unit/webviewDom.test.ts` — Case 27: an override for a node absent after refresh is dropped without error while a surviving node's override still applies.
- [ ] 7.9 GREEN confirm cases 21–27 pass through Phase 6's drag wiring plus `applyPositionOverrides()` (record `baseTransforms`, prune stale ids, re-apply dx/dy, full edge pass) called from the render path.
- [ ] 7.10 Run `npm run lint && npm run typecheck && npm run test:unit -- positionOverrides webviewDom && npm run test:e2e` and confirm all green (click-navigation scenario stays green untouched) before opening PR 2 against the PR 1 branch.

## Phase 8: Slice C — Wheel-Zoom (PR 3, base: PR 2 branch)

- [ ] 8.1 RED `test/unit/webviewDom.test.ts` — Case 28: first paint through the index render path carries a `viewBox` equal to `width`/`height`.
- [ ] 8.2 RED `test/unit/webviewDom.test.ts` — Case 29: wheel up over `#graph` shrinks `w`/`h` by `1/ZOOM_STEP` and keeps the cursor's user-space point fixed (exact numbers).
- [ ] 8.3 RED `test/unit/webviewDom.test.ts` — Case 30: wheel down zooms out; repeated ticks clamp at `ZOOM_MIN`; repeated up-ticks clamp at `ZOOM_MAX`.
- [ ] 8.4 RED `test/unit/webviewDom.test.ts` — Case 31: a wheel targeting `#graph` is `defaultPrevented`.
- [ ] 8.5 RED `test/unit/webviewDom.test.ts` — Case 32: a wheel dispatched on `#diff-panel` is not `defaultPrevented` and leaves `viewBox` unchanged.
- [ ] 8.6 RED `test/unit/webviewDom.test.ts` — Case 33: a new `graph` render after zooming resets `viewBox` to the base.
- [ ] 8.7 GREEN edit `webview/index.ts`: add `viewBox` state and `ZOOM_STEP=1.1`, `ZOOM_MIN=0.2`, `ZOOM_MAX=5`; bind one `wheel` listener on `byId("graph")` with `{ passive: false }` implementing the design's exact scoping guard, clamp formula, and `getBoundingClientRect()` cursor-to-user-space conversion (with the jsdom zero-size fallback to `baseW`/`baseH`).
- [ ] 8.8 GREEN edit `webview/index.ts`: add `resetViewBox()` (reads the just-rendered `<svg>`'s `width`/`height`, rewrites `viewBox`), called at the end of `case "graph":`; `case "graphSummary":` with `loadReason === "initial"` also sets `viewBox = undefined`.
- [ ] 8.9 GREEN confirm cases 28–33 pass.
- [ ] 8.10 Run `npm run lint && npm run typecheck && npm run test:unit -- webviewDom && npm run test:e2e` and confirm all green (panel-scroll-outside-graph regression check) before opening PR 3 against the PR 2 branch.
</content>
