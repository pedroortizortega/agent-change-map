# Tasks: Edge Router Performance (visibility-graph + A*)

## Direct-curve tension — RESOLVED (no design decision needed)

Read `webview/edgeGeometry.ts:633-726` and `test/unit/coordinatedRouting.test.ts:23-32`.
`edgePathsFor` (the coordinated multi-edge pass) **already never emits a Bezier
`C` command for any edge, crossing or not** — every routed edge, including a
direct/no-obstacle one, goes through port/candidate search and
`roundedPolylinePath` (orthogonal-by-construction), confirmed by the existing
test's explicit `expect(path).not.toMatch(/C/)`. The smooth Bezier curve only
comes from the single-edge `edgePathFor` fallback (D-2, untouched, invoked
only for a missing box or when no A* path is found). The new router preserves
this exactly: `routeOne` success → `roundedPolylinePath` (orthogonal);
`routeOne` failure → unchanged `edgePathFor` fallback. The base spec's
"direct curve" scenario refers to that single-edge fallback, not the
coordinated pass. No spec conflict; nothing to flag to the user here.

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~1,500-1,900 (design.md, verified against real `wc -l`: edgeGeometry.ts 726, coordinatedRouting.test.ts 263, edgeGeometry.test.ts 664, graphLayout.test.ts 564 — all confirmed) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Gate (PR0, spike-only) → PR1 → PR2 → PR3a → PR3b → PR4 → PR5 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — **orchestrator must ask the user** |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

Slice 3 (`edgeGeometry.ts` swap + property-suite rewrite, ~770 lines) does not
fit 400 lines even at its smallest natural boundary and cannot be split
without a red main, because the algorithm swap and its property suite must
land together. **Confirmed, refined into two steps** (design.md's own
suggestion): PR3a = swap + minimal green suite (~400-450), PR3b = full
property suite (~320-370). This keeps every PR green and under/near budget
except PR3a, which stays borderline and may need a `size:exception` if the
minimal suite can't shrink further — flag this explicitly at apply time.

### Suggested Work Units

| Unit | Goal | PR | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 0 | Nested fixture + gate decision (spike only, not shipped) | PR0 (throwaway/doc) | `npx tsx openspec/changes/edge-router-performance/perf/measure-layout.ts` | Manual spike run | Delete spike files, no production code touched |
| 1 | `routingGraph.ts` + tests | PR1 | `npx vitest run test/unit/routingGraph.test.ts` | N/A — no production caller yet | Delete new file + test |
| 2 | `routeSearch.ts` + tests | PR2 | `npx vitest run test/unit/routeSearch.test.ts` | N/A — no production caller yet | Delete new file + test |
| 3a | `edgeGeometry.ts` swap + minimal green suite | PR3a | `npx vitest run test/unit/coordinatedRouting.test.ts test/unit/edgeGeometry.test.ts` | `npm run dev` webview, open sample repo diagram | Revert `edgePathsFor`/`routeCost`/`routingPorts` bodies (signature unchanged) |
| 3b | Full property-based suite | PR3b | `npx vitest run test/unit/coordinatedRouting.test.ts` | Same webview manual check | Revert added property tests only |
| 4 | Scoped drag re-route | PR4 | `npx vitest run test/unit/graphLayout.test.ts` | Drag a node/container in `npm run dev` webview | Remove `{movedIds, previousOccupancy}` param, drag falls back to full re-route |
| 5 | Threshold + perf probe | PR5 | `npx vitest run test/unit/graphLayout.test.ts` | `npx tsx .../perf/measure-layout.ts` on nested fixture | Revert `webviewProtocol.ts` constant |

## Phase 0: Gating Sequence — GO/NO-GO before any production code (not a formality)

This mirrors the Phase-0 STOP gate that already caught the D1-D3 approach's
failure. Both binding measurement gates below (Block F, `OVERSIZED_THRESHOLDS`)
were deliberately left unresolved in design.md pending real Bash measurement
on a realistic NESTED fixture — every prior spike used a flat single-column
fixture, which design.md flags as the dominant unmeasured risk (~6x grid
density difference). Do not build Phase 1-5 around a projection.

- [x] 0.1 Created a synthetic nested `AnalysisGraph` generator (packages -> classes -> methods, varied X per package, `route0`/`route1`/... naming) plus a hand-built nested `Rect` box set for direct router stress-testing — spike file (see apply-progress.md Addendum 3), deleted after measurement.
- [x] 0.2 Implemented a full-featured throwaway visibility-graph + A* router: real D-1 tie-break (binary min-heap, `f/h/bends/stateKey` comparator), real D-5 occupancy penalty (`60+(o-1)*60`), real D-3a/D-3b container-lane construction rule (with a real bug found and fixed — containers must be excluded from build-time obstacle checks, see Addendum 3), real D-4 port/escape-lane math.
- [x] 0.3 Ran the spike at `{60,120}` through `{400,800}` on BOTH a nested fixture and a FLAT fixture (the latter added after verifying `layoutGraph` always takes the flat branch for `N > NESTED_LAYOUT_LIMITS = {60,120}`, regardless of input nesting — see Addendum 3's "critical correction"). Full table recorded in `apply-progress.md` Addendum 3.
- [x] 0.4 **GATE DECISION — Block F: KEEP** the scoped drag-drop re-route. Full re-route measured 1.6x-46x over the 250ms bar at every decision-relevant size on both fixtures — not a close call. No spec amendment needed; Phase 4 proceeds as designed.
- [x] 0.5 **GATE DECISION — OVERSIZED_THRESHOLDS: keep `{300, 600}`**, zero lines changed in `src/webviewProtocol.ts`. Measured 4,445.9ms on the realistic FLAT fixture (the one `layoutGraph` actually produces at this size) — inside the ≤5000ms 2x-margin rule; `{400,800}` measured 9,840.5ms, clearly outside it. Recorded in `apply-progress.md` Addendum 3.
- [x] 0.6 Flagged the NESTED-fixture numbers as a real but separate, out-of-scope-for-today risk (grid blow-up past design.md's own `|X| > ~30` fallback trigger) rather than a blocker, since `layoutGraph`'s `NESTED_LAYOUT_LIMITS = {60,120}` gate means production never actually feeds the router a multi-X-column box set at the sizes this change's thresholds govern — verified directly against `webview/graphLayout.ts`, not assumed. No STOP triggered.

## Phase 1: `webview/routingGraph.ts` (PR1)

- [ ] 1.1 RED: `test/unit/routingGraph.test.ts` — lane sampling never lands in a container's forbidden band (D-3a); container tags match brute-force reference; `OccupancyIndex` claim/release round-trip.
- [ ] 1.2 GREEN: implement `RoutingGraph`/`OccupancyIndex` per design.md's interfaces (~230 lines).
- [ ] 1.3 REFACTOR: extract shared geometry helpers reused by Phase 2 if any duplication appears.

## Phase 2: `webview/routeSearch.ts` (PR2)

- [ ] 2.1 RED: heap pop-order matches a reference sorted list (D-1 determinism); A* respects D-3b's `containerTags` admission predicate.
- [ ] 2.2 GREEN: implement binary min-heap + `routeOne()` with D-1 tie-break and D-5 cost model (~150 lines).

## Phase 3a: `edgeGeometry.ts` swap + minimal green suite (PR3a)

- [ ] 3a.1 RED: update `test/unit/coordinatedRouting.test.ts` minimally — orthogonal-only, no-crossing (real-analyzer fixture lines 115-153), unresolved-stub-exact — enough to prove the swap works, deferring full property list.
- [ ] 3a.2 GREEN: delete `routeCost` (601-625) and `edgePathsFor`'s body (633-726); rewrite `routingPorts` (581-599) per D-4; wire `routeOne` + fallback-to-`edgePathFor` on `undefined` (D-2). Keep everything ≤ line 579 byte-identical.
- [ ] 3a.3 Confirm `test/unit/edgeGeometry.test.ts` needs zero edits (already verified in design.md — its imports are all ≤ line 579).

## Phase 3b: Full property-based suite (PR3b)

- [ ] 3b.1 Add remaining properties per design.md's table: clearance-with-margin, port distinctness (n ≤ 8), determinism-as-reproducibility (incl. shuffled lane-insertion order + heap-swap invariance), self-loops, container-lane (kept as-is), label/header bands (kept as-is), outer-lane fallback, 200-seeded randomized sweep.
- [ ] 3b.2 Sweep `CROSSING_BASE ∈ {0,30,60,120,240,1000} × L ∈ {2,3}` per design.md's binding tuning protocol; record max-owners/excess-weight/length/bends/ms table in `apply-progress.md`; pick the knee.

## Phase 4: Scoped drag re-route (PR4) — only if Phase 0 gate says >250ms

- [ ] 4.1 RED: `test/unit/graphLayout.test.ts` — scoped re-route touches only moved-node/cascade edges, keeps others byte-identical, falls back to full re-route when no valid path exists.
- [ ] 4.2 GREEN: `graphLayout.ts` `routedPaths` accepts optional `{movedIds, previousOccupancy}`; `index.tsx`'s `onNodeDragStop` passes cascade ids (~+35/+15 lines).

## Phase 5: Threshold + perf probe (PR5)

- [ ] 5.1 Update `src/webviewProtocol.ts`'s `OVERSIZED_THRESHOLDS` to Phase 0's measured values (0-2 lines, only if changed).
- [ ] 5.2 Add nested/varied-X perf probe to `test/unit/graphLayout.test.ts` at the new boundary (`<10000ms`) alongside the existing `{60,120}` probe (`<2000ms`).

## Next Step

Do NOT start Phase 1-5 implementation until Phase 0's gate decisions (0.4, 0.5)
are recorded. Orchestrator must ask the user for chain strategy
(stacked-to-main / feature-branch-chain / size-exception) before `sdd-apply`
begins PR1.
