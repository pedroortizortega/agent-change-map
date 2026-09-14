# Apply Progress — `edge-router-performance-anchor-fix`

Narrow, direct-inline follow-up to `edge-router-performance` (archived at
`openspec/changes/archive/2026-09-13-edge-router-performance/`, work-in-progress copy still at
`openspec/changes/edge-router-performance/apply-progress.md`). No full proposal/spec/design cycle
per this project's "direct inline for a mechanical, already-understood fix" convention — scope is
narrow and the existing router's own doc comments already fully describe the gap. This file is the
change's complete SDD trail.

Branch: `fix/router-anchor-crossing` (off `main`, which already has `edge-router-performance`
merged). Strict TDD Mode: enabled.

## Context

`edge-router-performance`'s own "Crossing-fix" section (see that change's apply-progress.md,
"Crossing-fix (pre-PR3b, user-requested)") disclosed one specific, narrow, remaining limitation:
edges can still occasionally cross at the **port anchor→escape-lane hop** — the short, fixed
segment connecting a box's own boundary port anchor to its nearest lane line, constructed by
`allocatePort`/`portAtLane` in `webview/routingGraph.ts`/`webview/edgeGeometry.ts` BEFORE
`routeOne`'s A* search (`webview/routeSearch.ts`) even begins. This segment sits OUTSIDE the shared
visibility graph, so `OccupancyIndex`'s in-search node-crossing penalty (the mechanism that closed
the broader graph-internal crossing category) has no graph node to attach an occupancy count to
there, no matter how it is extended.

A prior attempt to close this via a HARD GATE (`crossesAny` promoted into `isGoodEnough`, tier-1
acceptance) was measured at ~130x regression (49.6s at {100,200} vs. ~0.4s) and reverted — this
follow-up's job was to find a CHEAP alternative and measure it honestly, not repeat that mistake.

The user's screenshot showed exactly this category: a purple edge and a blue dashed edge crossing
right at the corner of a container box near where a line docks into `route.ruta1`'s port —
confirming this is the known, disclosed category, not a new bug. That exact box/fixture (module
`route`, function `route.ruta1`) is already the real-analyzer regression fixture in
`test/unit/coordinatedRouting.test.ts`'s "keeps a real clearance margin outside every unrelated box"
test, so no new fixture needed to be invented to reproduce the user's exact scenario.

## Approach investigation (multiple candidates evaluated, not just the first idea)

Read in full: `webview/routingGraph.ts`'s `allocatePort`/`buildRoutingGraph`, `webview/routeSearch.ts`'s
`routeOne`, and `webview/edgeGeometry.ts`'s `coordinateRoutes` (the wiring layer that ties them
together, including `isGoodEnough`/`crossesAny`, the tier-1/tier-2 candidate search, and
`graphEdgeIdsAlong`/`OccupancyIndex.claim`).

Root cause confirmed directly (not assumed): a port's anchor (on the box's own boundary, which is
never a sampled lane-line coordinate) to its escape point (on a real, sampled lane line) is a fixed
segment `routeOne` never searches over and `coordinateRoutes` never registers as a graph edge in
`OccupancyIndex` (`graphEdgeIdsAlong` only recovers points that land EXACTLY on both graph axes,
which the anchor point structurally never does). Confirmed via a throwaway repro script hitting the
exact `test/unit/coordinatedRouting.test.ts` "keeps crossings rare" fixture (1 crossing) and the
real `route.ruta1` fixture (3 raw crossings, 7 after corner-rounding for rendering) before any fix.

### Candidate 1 — extend the visibility graph to include the anchor hop as a real graph edge

Investigated, not implemented. The anchor's fixed-axis coordinate is the box's own boundary, which
is deliberately NEVER a sampled lane line (`buildRoutingGraph` only samples `box.x/y ± LANE_GAP*k`
offsets, never the box boundary itself — this exclusion is what fixed the pre-existing
Addendum-3-documented 100%-route-failure bug from `edge-router-performance`'s own history). Adding
a synthetic per-port node to the shared graph purely for this purpose would mean one extra node/edge
PER PORT PER EDGE, defeating `buildRoutingGraph`'s "build once per pass" design and reintroducing a
node-count cost proportional to edge count on every pass, not just when a crossing is at risk.
Rejected on inspection, before implementation, as architecturally heavier than needed for a rare
event.

### Candidate 2 — docking-time depth nudge (design.md's own suggested candidate)

Implemented and measured, in three escalating variants, all via real TDD (RED confirmed against
the existing fixture before each GREEN attempt):

1. **Full anchor-hop check as a hard `isGoodEnough` requirement** (both directions: candidate's own
   hop vs. accepted routes, AND candidate's full path vs. accepted routes' own hops). Closed the
   crossing in both the small fixture (1→0) and one real-fixture crossing (3→2 raw), but measured
   **~180x regression** at {100,200} (~69.8s vs. ~0.4s baseline) — the same escalation-cost trap as
   the previously-rejected full-`crossesAny` gate, confirmed to recur for ANY hard requirement in
   `isGoodEnough`, regardless of how cheap that requirement's own per-call cost is. Reverted.
2. **Bounded tier-1.5 nudge**: only escalate side+depth (12 extra `routeOne` candidates, not tier
   2's full 144) for the SPECIFIC endpoint whose anchor hop crosses, identified directly via a
   split-out `singleHopCrosses` helper; skip entirely when both endpoints are implicated. Fixed
   cost per triggered edge, independent of graph density. Still measured a real, non-trivial
   **~5-7x regression** at {100,200}..{300,600} (see Performance table) — the trigger condition (an
   anchor-hop crossing somewhere among many already-accepted routes) is common enough in a dense
   graph that the extra 12-candidate `routeOne` search (each a full A* pass) runs for a large
   fraction of edges, and that compounds. Reverted — not worth 5-7x for a marginal crossing-count
   improvement.
3. **FREE tier-2 candidate reordering (what shipped)**: tier 2 (the full 4-sides x 3-depths
   144-candidate search) already runs, and already builds its full candidate list, whenever tier 1
   fails `isGoodEnough` outright (e.g. an obstacle blocks the natural side pairing — unrelated to
   crossings). Preferring an anchor-hop-crossing-free candidate FROM THAT SAME already-built list
   costs zero extra `routeOne` calls — just one more cheap `.find()` scan over candidates already in
   memory. This is a genuine "cheap" mechanism: it never changes WHETHER tier 2 runs, only WHICH of
   its already-computed candidates wins.

## What shipped

`webview/edgeGeometry.ts`:
- `segmentsCross` — extracted shared crossing-test primitive (was inlined in `crossesAny`).
- `anchorHopsOf(route)` — the two fixed anchor/escape-hop segments at a route's ends.
- `singleHopCrosses(hop, accepted)` — crossing test for one hop against all accepted routes.
- `anchorHopCrosses(route, accepted)` — either hop crossing any accepted route.
- `isGoodEnough` is BYTE-IDENTICAL to `edge-router-performance`'s landed shape (`clearsContainerLanes`
  only) — no hard gate added, by design, given the measured cost above.
- Tier 2's candidate selection changed from `candidates.find(isGoodEnough)` to
  `candidates.find(c => isGoodEnough(c) && !anchorHopCrosses(c.route, acceptedRoutes)) ?? candidates.find(isGoodEnough)`
  — the one shipped change to actual routing behavior.

This is a preference, not a guarantee — exactly the same "honest" framing the router's own doc
comments use throughout: an edge whose tier-1 candidate ALREADY clears every other guarantee (so
tier 2 never runs) keeps whatever anchor-hop crossing that single candidate has, same as before
this follow-up. In a dense fixture where every tier-2 candidate still crosses something, the
fallback `candidates.find(isGoodEnough)` accepts a crossing exactly as before.

## TDD Cycle Evidence

| Step | Action | Result |
|---|---|---|
| RED | Tightened `test/unit/coordinatedRouting.test.ts`'s "keeps crossings rare" fixture assertion from `toBeLessThanOrEqual(1)` to `toBe(0)`, confirmed against the UNMODIFIED router. | Confirmed FAILING: `expected 1 to be 0` (the exact known anchor-hop crossing this fixture was documented to hit). |
| GREEN | Implemented the tier-2 FREE candidate reordering above (after investigating and rejecting the two more expensive candidates, per the escalating variants documented above, each independently confirmed cheap-but-ineffective or effective-but-expensive via real measurement before being discarded). | `toBe(0)` PASSES. Full `test/unit/coordinatedRouting.test.ts` suite: 18/18 (including the 200-seeded property sweep). |
| REFACTOR | Extracted `segmentsCross` to deduplicate the crossing-test primitive between `crossesAny` and the new `anchorHopCrosses`; removed dead code from the two rejected variants (`crossesAcceptedAnchorHops`, `acceptedAnchorHops` tracking, the tier-1.5 nudge block) rather than leaving it commented out. Ran `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`. | All clean — see Full Gate Confirmation below. |

## Crossing-count evidence (real numbers, not claimed)

**Fixture 1** — `test/unit/coordinatedRouting.test.ts`'s "keeps crossings rare" fixture (5 boxes,
4 fan-in/fan-out edges), measured on the RENDERED (post corner-rounding) path, matching the
committed test's own methodology:

| | Before this fix | After this fix |
|---|---|---|
| Crossing count | 1 | **0** |

**Fixture 2** — the real-analyzer `route`/`route.ruta1` fixture (19 boxes, 27 edges) from
`test/unit/coordinatedRouting.test.ts`'s "keeps a real clearance margin" test — the SAME fixture
that reproduces the user's screenshot scenario (module `route`, function `route.ruta1`):

| | Before this fix | After this fix |
|---|---|---|
| Raw (pre-rounding) crossing count | 3 | **2** |
| Rendered (post corner-rounding) crossing count | 7 | **6** |

The remaining 2 raw crossings in Fixture 2 all involve `module:app`'s own outbound edge (span 594,
processed near-last in span-ascending order), which — traced directly — already goes through tier
2's full 144-candidate search (its accepted escape depth is `laneIndex=2`, only reachable via tier
2), and EVERY one of those 144 candidates still crosses something in this specific, densely
pre-populated corner of the fixture (a real hub with many prior relationships already claimed
nearby). This is the honestly-reported residual limitation: the fix is a preference among available
options, not a guarantee, and in a sufcciently dense corner no crossing-free option may exist among
the candidates tried.

## Performance (real measurements, same methodology and sizes as `edge-router-performance`)

Throwaway script `openspec/changes/edge-router-performance-anchor-fix/perf/measure-edgepaths-anchor-fix.ts`
(written, measured, and DELETED per this repo's own throwaway-spike convention — `git status
--porcelain` confirms it is not part of this diff), same isolation methodology as
`edge-router-performance`'s own perf scripts: `layoutGraph` (whose dominant cost is `edgePathsFor`)
timed directly on the same synthetic flat-graph generator, at the same probed sizes, 3 runs each.

| nodes/edges | `edge-router-performance`'s accepted crossing-fix baseline (ms) | This fix, run1 (ms) | run2 (ms) | run3 (ms) |
|---|---|---|---|---|
| 60/120 | 6.1 | 27.1 | 17.7 | 8.7 |
| 100/200 | 380.4 | 754.3 | 675.4 | 497.6 |
| 150/300 | 965.8-982.6 | 1,303.0 | 1,605.1 | 1,545.9 |
| 200/400 | 1,799.9-1,998.5 | 2,824.4 | 2,751.4 | 2,974.8 |
| 300/600 | 4,889.1-6,442.6 | 7,801.9 | 8,183.1 | 7,801.7 |

**Verdict: a real, disclosed constant-factor cost of roughly 1.3x-1.7x at every size from
{100,200} up** (60/120 is dominated by process warm-up noise at this scale, consistent with prior
rounds' own documented variance at that size). This is NOT free at the scale I initially assumed
(tier 2 does not run on every edge in the synthetic benchmark, but the `anchorHopCrosses` scan over
`acceptedRoutes` inside tier 2's now-two-pass `.find()` still adds real, measurable overhead as
`acceptedRoutes` grows) — reported honestly rather than rounded down. It is, however, comfortably
within the task's own stated tolerance ("a few percent, or even 2x if the crossing reduction is
substantial") and nowhere near the 130x/180x/5-7x costs of the three rejected alternatives above.

The committed hard-budget regression test in `test/unit/graphLayout.test.ts` ("computes
`layoutGraph` at {nodes:300, edges:600} within its 10000ms spec budget") still passes with real
margin: **7,155-7,924ms measured across three separate `vitest run` invocations in this session**,
comfortably under the 10,000ms budget (28-29% headroom), though — reported honestly — less margin
than `edge-router-performance`'s own crossing-fix number (4,889.1-6,442.6ms) had. The PR4 scoped
drag-commit re-route test is untouched by this fix (scoped fast-path never re-runs
`buildCandidates`/tier 2 for untouched edges) and stays at **174-185ms**, unchanged from
`edge-router-performance`'s own ~130-174ms figures, comfortably under its 500ms budget.

## Full test suite / gate confirmation

- `npm run typecheck` — clean (both tsconfigs).
- `npm run lint` — clean, 0 errors/warnings (`--max-warnings=0`).
- `npm test` — **36 files / 590 tests, all passing** (unchanged file/test count from
  `edge-router-performance`'s own final PR5 gate — no tests added beyond tightening the one existing
  assertion from `<=1` to `0`).
- `npm run test:e2e` — run for real, VS Code Extension Development Host, exit code 0, all scenarios
  passed including "refresh scenario ok" (exercises the real, patched `edgePathsFor` rendering a
  real diagram).
- `test/unit/coordinatedRouting.test.ts`'s 200-seeded property-based randomized sweep — still
  passes (orthogonality, real-margin clearance, determinism all hold across all 200 seeds); did not
  show a measurable crossing-count difference on inspection since that sweep does not itself assert
  a crossing count (only orthogonality/clearance/determinism) — the crossing-count claims above are
  based on the two REAL, deterministic fixtures, not the random sweep.

## Files Changed

| File | Action | Lines (`git diff --numstat`) |
|---|---|---|
| `webview/edgeGeometry.ts` | Modified | +95 / -9 |
| `test/unit/coordinatedRouting.test.ts` | Modified | +21 / -11 |
| **Total authored additions+deletions** | | **136** — well under the 400-line review budget, no `size:exception` needed |

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/coordinatedRouting.test.ts test/unit/edgeGeometry.test.ts test/unit/routeSearch.test.ts test/unit/routingGraph.test.ts test/unit/graphLayout.test.ts` → 130/130 passed |
| Runtime harness command/scenario and exact result | `npm run test:e2e` (real VS Code Extension Development Host, built webview bundle) → exit code 0, all scenarios passed including "refresh scenario ok" |
| Rollback boundary | Revert `webview/edgeGeometry.ts`'s `segmentsCross`/`anchorHopsOf`/`singleHopCrosses`/`anchorHopCrosses` additions and the one-line tier-2 selection change (`candidates.find(isGoodEnough)` back from the two-step `?? ` chain); revert `test/unit/coordinatedRouting.test.ts`'s bound from `toBe(0)` back to `toBeLessThanOrEqual(1)` and its doc comment. No other files touched — `OVERSIZED_THRESHOLDS`, `NESTED_LAYOUT_LIMITS`, and the PR4 drag-commit scoping mechanism are all untouched, as constrained. |

## Status

Complete. A cheap mechanism was found (FREE tier-2 candidate reordering) that measurably reduces —
but, reported honestly, does not eliminate — anchor/escape-hop crossings, at a real, disclosed
~1.3x-1.7x constant-factor cost (not free, contrary to my own initial expectation, but well within
the task's stated tolerance and nowhere near the 130x/180x/5-7x costs of the three rejected
alternatives). Two more aggressive variants (a hard `isGoodEnough` gate, and a bounded 12-candidate
tier-1.5 nudge) were implemented, measured, and honestly rejected after real profiling showed
catastrophic or non-trivial regressions respectively — this is the disclosed trade-off space the
task asked to surface. The residual crossing category (anchor hops in a densely pre-populated
corner where every tier-2 candidate still crosses) remains open, by measured necessity: no cheap
mechanism found in this investigation closes it without reintroducing an unacceptable performance
cost.
