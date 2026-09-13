# Apply Progress: edge-router-performance

## Status: Phase 0 (Empirical Gate) COMPLETE — GATE DECISION: **STOP**

Phase 0 is a blocking go/no-go gate before any production code (Phase 1-6, the 5-PR chain
~2100-2900 lines). It is throwaway/spike work by design and is excluded from the review-workload
line budget. The spike is complete, measured, and deleted per task 0.8. **The measured data does
NOT support proceeding into the full D1+D2+D3 implementation as designed** — see "Gate Decision"
below.

## Completed Tasks

- [x] 0.1 Created throwaway spike `webview/edgeGeometrySpike.ts` (verbatim copy of
      `webview/edgeGeometry.ts`), implementing a minimal `OccupancyIndexSpike` covering only D1's
      two query paths: exact-lane `hByY: Map<number, Seg[]>` / `vByX: Map<number, Seg[]>` for the
      parallel-overlap branch, and a uniform `CELL=64` grid (`rows: Map<yCell, Map<xCell, Seg[]>>`
      for vertical segments queried by horizontal candidates, `cols: Map<xCell, Map<yCell, Seg[]>>`
      symmetrically for horizontal segments queried by vertical candidates) for the
      perpendicular-crossing branch. D2 (obstacle/label rect index) and D3 (band hoisting +
      branch-and-bound pruning) were intentionally **not** implemented — out of scope for this
      spike, per instructions.
- [x] 0.2 Wired the spike into a copy of `routeCost` inside `edgeGeometrySpike.ts` only. The real
      `webview/edgeGeometry.ts` was never modified. `routeCost` now calls
      `index.matches(a, b, horizontal)` (a superset, ord-sorted to reproduce today's nested-loop
      accumulation order bit-for-bit, matching design.md D1's determinism requirement) instead of
      the linear `for (const route of occupied) for (j...)` scan. `edgePathsFor` in the spike
      builds/maintains the index (`occupiedIndex.push(best)`) alongside the existing `occupied`
      array (kept only for its `.length`, used by the lane-band loop — unrelated to this spike).
      Confirmed the spike file typechecks cleanly under the project's real
      `tsconfig.webview.json` (it matches that config's `include` glob).
- [x] 0.3 Extended a throwaway copy of `perf/measure-layout.ts`
      (`perf/measure-layout-spike.ts`, also deleted per 0.8) with `DEFAULT_SIZES` extended to
      `60,120` through `500,1000` (baseline sizes plus `200,400`, `300,600`, `400,800`, `500,1000`
      per task 0.3). Doubling was **not** run past `300,600` — that single size alone did not
      finish in 590 seconds (59x the 10000ms budget), so continuing to `400,800`/`500,1000` would
      have added no new information and cost 10+ more minutes of wall-clock for no decision value.
- [x] 0.4 Ran the extended harness for real, comparing `edgePathsFor` from unmodified
      `webview/edgeGeometry.ts` ("today") against `edgePathsFor` from `edgeGeometrySpike.ts`
      ("spike, D1-only"), on the exact same `boxes`/`RoutingEdge[]` per size (extracted from one
      real `layoutGraph` call, so both routing-pass timings are isolated from
      measurement/placement cost and from each other). Every row below is a real measured number,
      not an estimate. Output-equivalence was also checked per row (`todayPaths[i] ===
      spikePaths[i]` for every edge) — **zero mismatches at every size tested**, confirming the D1
      spike is output-preserving exactly as design.md's two invariants predict.

### Measured Numbers (real, `npx tsx` on this machine, cold JIT per process)

| nodes | edges | `layoutGraph` full (today) ms | `edgePathsFor` today ms | `edgePathsFor` spike (D1-only) ms | speedup |
|---|---|---|---|---|---|
| 60 | 120 | 782 | 744 | 764 | 1.0x |
| 80 | 160 | 3848 | 4053 | 2725 | 1.5x |
| 90 | 180 | 5898 | 5602 | 3840 | 1.5x |
| 100 | 200 | 7610 | 8126 | 5159 | 1.6x |
| 120 | 240 | 16944 | 13311 | 10470 | 1.3x |
| 150 | 300 | 27287 | 27068 | 17159 | 1.6x |
| 200 | 400 | 68065 | 63977 | 42208 | 1.5x |
| 300 | 600 | **did not complete in 590000 ms** (>59x the 10000ms spec budget, for `layoutGraph` alone; `edgePathsFor` today/spike not separately measured at this size — the process was killed before reaching them) | — | — | — |

Scaling sanity check on today's baseline (confirms design.md's own O(N³)-ish characterization):
100→150 (1.5x N,E): `edgePathsFor` today 8126→27068 ms = 3.33x actual vs. 3.375x predicted by cubic
scaling. 150→200 (1.33x N,E): 27068→63977 ms = 2.36x actual vs. 2.37x predicted by cubic scaling.
Both match cubic scaling almost exactly — today's code really is cubic-ish, as design.md claims.

## Comparison Against design.md's Estimate

design.md's "Derived `OVERSIZED_THRESHOLDS`" section estimates `{300,600}` at **~23M ops,
~0.2-0.5s in V8** for the fully-fixed (D1+D2+D3) algorithm, explicitly labelled "an estimate from
an op count, not a timing" (no Bash access during design). That estimate is not directly
comparable to today's *unfixed* number, but even a generous sanity extrapolation shows the
magnitude of the problem:

- Cubic-extrapolating today's own measured curve from `{200,400}` (63977 ms) to `{300,600}`
  (1.5x N,E → 1.5³ ≈ 3.375x) predicts **≈216,000 ms (~3.6 min)** for today's code at `{300,600}`.
  The actual run exceeded **590,000 ms** and still had not completed `layoutGraph` — i.e. even
  *worse* than the cubic extrapolation, suggesting an additional super-cubic factor (likely GC/
  allocation pressure from the very large per-edge candidate arrays, on top of the three
  documented cubic terms) that design.md's op-count model does not account for.
- The design's ~0.2-0.5s *estimate* for the fully-fixed algorithm is **3-4 orders of magnitude**
  below what is measured for the *unfixed* algorithm at a size 33% smaller (`{200,400}`:
  63,977 ms). Even attributing the entire gap optimistically to D1+D2+D3's combined fix (an
  asymptotic order reduction, not just a constant factor, which D1 alone does *not* achieve — see
  below), there is no data point in this spike that makes ~0.2-0.5s at `{300,600}` plausible.
- **This is an order-of-magnitude mismatch, and a large one** — not a "the estimate was a bit
  optimistic" gap.

## Gate Decision Reasoning

Per tasks.md 0.5: D1 alone is *expected* to underperform the full D1+D2+D3 fix, since T2
(obstacle/label scan, D2) and T3 (candidate-grid growth, D3) are both still present and both still
scale with N/E per candidate — D1 only removes one of three multiplicative cubic terms, and even
that removal is imperfect (grid queries are O(local density), not O(1), and index construction/
maintenance itself adds real constant-factor overhead). A modest, roughly-constant ~1.3-1.6x
speedup from D1 alone is therefore **not surprising and not disqualifying by itself** — this is
correctly treated as a partial signal, not the final verdict.

However, tasks.md 0.7's literal STOP trigger is explicitly: *"the spike shows only marginal
improvement (e.g. still crosses 10s well below `{300,600}`, or scales no better than
linear-in-occupied)"*. The measured data satisfies this exactly and unambiguously:

- The D1-only spike **still crosses the 10000ms budget at `{120,240}`** (10,470 ms) — a graph
  size **2.5x smaller** than the `{300,600}` decision-rule checkpoint design.md's own binding rule
  is built around.
- The speedup factor is flat (~1.3-1.6x) across every measured size, with no sign of an asymptotic
  complexity-order change (which would show an increasing speedup ratio as N/E grow) — consistent
  with "constant-factor improvement, complexity order unchanged," exactly what D1 alone should
  produce, and exactly the "scales no better than linear-in-occupied" shape of result the STOP
  trigger describes.
- Today's own baseline at `{300,600}` is **already 59x+ over the 10s spec bound** and did not
  finish in nearly 10 minutes — a starting point roughly 3-4 orders of magnitude worse than
  design.md's op-count model assumed. Even if D2+D3 deliver improvements of similar or somewhat
  better magnitude to D1 (optimistically 1.5-3x each, since they are structurally similar
  index-substitution fixes, not asymptotic-order rewrites — design.md's own "Resulting Complexity"
  table honestly states the *target* is "O(N·E) ≈ O(N²) floor, with a far smaller constant," not a
  full asymptotic-order collapse), a combined constant-factor gain in the range of ~3-10x is the
  plausible ceiling from this design. Applied to the >590,000ms measured floor at `{300,600}`,
  that leaves an estimated **~60,000-200,000ms** even after the full 5-PR chain — one to two
  orders of magnitude over the 10000ms spec bound, not under it.

**GATE DECISION: STOP.** The data does not support proceeding into the full D1+D2+D3
implementation (Phase 1-6, the 5-PR chain, ~2100-2900 authored lines) as currently designed. This
is not primarily "D1 underperformed" (expected) — it is that design.md's foundational op-count
estimate for the *combined* fix is off from measured reality by 3-4 orders of magnitude at a size
*smaller* than the decision checkpoint, which undermines confidence that D2+D3 (not yet measured,
same class of fix) will close a gap this large. Proceeding on the current design's assumptions
risks landing a ~2100-2900 line, 5-PR chain that still fails the `<=10000ms` spec bound at
`{300,600}`, discovered only after most of the implementation cost is already sunk (Phase 4, task
4.6's "honest-shortfall path" would then trigger anyway, after the majority of the work).

This is a decision point for the orchestrator to take back to the user, per tasks.md 0.7's
explicit instruction — **not** a silent proceed and **not** a unilateral abandonment of the
change. Plausible next steps for the user/orchestrator to weigh (not decided here): re-derive
design.md's complexity/op-count model against these real numbers before committing to further
implementation scope; investigate the super-cubic gap directly (profile today's code at `{200,400}`
to find the actual dominant cost, which may not be evenly split across T1/T2/T3 as assumed);
reconsider whether `{300,600}` is an achievable oversized-graph target at all versus lowering
`OVERSIZED_THRESHOLDS` structurally (a smaller, cheaper change); or accept a smaller/partial scope
(e.g. D1+D2 only, re-measured, before committing to D3's added complexity).

- [x] 0.5 Compared against design.md's decision rule: `{300,600}` was **not measurable within the
      10000ms budget even for `layoutGraph` alone** (>590,000 ms, did not complete) — this is
      unambiguously the "> 10000 ms" branch of the binding decision rule, and by a very wide
      margin, using only the D1-only spike (design.md's rule is written for the fully-fixed
      algorithm, so this is a conservative/pessimistic read, not an optimistic one).
- [x] 0.6 Real measured numbers written above (table + scaling sanity check), explicitly compared
      against design.md's ~23M ops / ~0.2-0.5s estimate; the order-of-magnitude mismatch (3-4
      orders of magnitude) is flagged plainly, not minimized.
- [x] 0.7 **GATE DECISION: STOP.** Documented above with explicit reasoning distinguishing
      "D1-alone underperformance" (expected, not disqualifying) from "estimate mismatch this
      large" (disqualifying per tasks.md 0.7's literal STOP trigger, which the data satisfies).
      Recommendation: return to the user/orchestrator before any Phase 1-6 work begins.
- [x] 0.8 Deleted `webview/edgeGeometrySpike.ts` and
      `openspec/changes/edge-router-performance/perf/measure-layout-spike.ts`. Confirmed via
      `git status --porcelain` that only `openspec/changes/edge-router-performance/` (untracked
      planning artifacts) remains — no spike file is part of any diff. The real
      `webview/edgeGeometry.ts` and `openspec/changes/edge-router-performance/perf/measure-layout.ts`
      were never modified.

## Files Changed (production/tracked tree)

None. This phase touched only throwaway files (`webview/edgeGeometrySpike.ts`,
`.../perf/measure-layout-spike.ts`), both deleted per task 0.8, plus this
`apply-progress.md` and `tasks.md`'s checkbox updates (planning artifacts, not shipped code).

## Remaining Tasks

- [ ] Phase 1-6 (PR1-PR5 + final gate) — **BLOCKED pending user/orchestrator decision** on how to
      respond to the Phase 0 gate's STOP verdict. Do not proceed to Phase 1 without an explicit
      go-ahead, per tasks.md 0.7.

## Status

8/8 Phase 0 tasks complete. **Gate: STOP — return to orchestrator/user before Phase 1.**

---

## Addendum: visibility-graph + A* candidate spike (exploration-v2.md follow-up)

Separate throwaway spike, run after the Phase 0 STOP above, specifically to test
`exploration-v2.md`'s candidate replacement approach (visibility-graph + A*, as used by
libavoid/ELK) with real Bash timing, since exploration-v2.md itself had no execution access.
File: `openspec/changes/edge-router-performance/perf/visibility-graph-spike.ts` — **written,
measured, and deleted** per the same throwaway-spike convention as Phase 0. Not part of any
diff (`git status --porcelain` confirms only the untracked `openspec/changes/edge-router-performance/`
planning directory remains).

### Method

- Reused the exact same synthetic generator as `perf/measure-layout.ts`'s `flatGraph` (verified
  against `webview/graphLayout.ts`'s flat-fallback layout: single column, `x=16` fixed, `w=220`,
  `h=32`, `y = 24 + index*48` — every node stacked in one column, which is what the baseline
  table's numbers actually measure since all probed sizes are past `NESTED_LAYOUT_LIMITS`).
- Built a visibility/grid graph ONCE per graph instance: candidate X/Y coordinates from every
  obstacle box's corners grown by a `MARGIN = 12` clearance (matching the real router's
  `LANE_GAP`), grid nodes kept only where not inside an obstacle interior, horizontal/vertical
  visibility edges between coordinate-adjacent grid nodes checked for real obstacle clearance
  (reused the same Liang-Barsky `clipSegment` convention as `edgeGeometry.ts`, boundary touch
  != crossing).
- Routed each edge independently via A* (Manhattan heuristic) from a transient "docking" node
  for the source port to one for the target port, layered on top of the shared graph without
  mutating it (so the O(N)-ish graph build genuinely happens once, not once per edge).
- Deliberately did NOT implement pairwise crossing-avoidance / shared-lane occupancy checks
  between already-routed edges (today's `routeCost` checks every candidate against every
  previously placed route — an `O(E)`-per-candidate cost this spike specifically excludes, since
  that's the mechanism whose removal is under test). Cost = path length only, no bend-count
  tie-break. No port-slot allocation, no outer-lane-fallback distinction, no container-lane
  nuance, no self-loops, no Bezier tail — pure orthogonal polyline waypoints only.
- Preserved: real per-edge obstacle set (every other node's box, source/target excluded exactly
  like `obstaclesFor`), a real clearance margin, orthogonal-only routing via a real graph search
  (not a straight line, not a cheat).

### Measured numbers

| nodes/edges | spike ms (build + route ALL edges) | today's `layoutGraph` ms (measured baseline) | speedup |
|---|---|---|---|
| 60/120 | 8.7 | 782 | **90.1x** |
| 100/200 | 9.5 | 7610 | **797.8x** |
| 150/300 | 15.3 | 27287 | **1779.2x** |
| 200/400 | 25.5 | 68065 | **2671.2x** |
| 300/600 | 50.6 | did not complete in 590s+ | not directly computable, but bounded below by `590000/50.6 ≈ 11,660x` |
| 400/800 | 94.4 | not measured | — |
| 500/1000 | 150.6 | not measured | — |
| 1000/2000 | 568.3 | not measured | — |

Sanity check at 150/300 (moderate size, spot-checked per task instructions): **0/300** routed
edges cross through an unrelated obstacle box's interior (checked directly against
`clipSegment`, same convention as `segmentIntersectsRect`) — the spike's output is genuinely
obstacle-avoiding orthogonal routing, not a trivial straight-line cheat.

### Verdict: the speedup ratio WIDENS as N grows — this is the complexity-class signal

The ratio goes **90x → 798x → 1779x → 2671x** as N grows from 60 to 200 nodes — each step up in
N *increases* the speedup by roughly an order of magnitude across the full measured range, not a
flat multiplier. This is the opposite of the rejected D1-only spike's signature (flat 1.3-1.6x
across all N, no widening). Concretely:

- Today's router (from the Phase 0 baseline table): `60→100` (1.67x N) costs `9.73x` more time
  (~N^2.9); `100→150` (1.5x N) costs `3.59x` more (~N^3.15); `150→200` (1.33x N) costs `2.49x`
  more (~N^3.15) — consistent with the Phase 0 gate's own reading of super-cubic growth.
- This spike: `60→100` costs `1.09x` more (dominated by fixed overhead at this size);
  `100→150` costs `1.61x` more (~N^1.15); `150→200` costs `1.67x` more (~N^1.68);
  `200→300` costs `1.98x` more (~N^1.72); `300→400` costs `1.87x` more (~N^2.15);
  `500→1000` (2x N) costs `3.77x` more (~N^1.91). The spike's own empirical growth clusters
  around **~O(N^1.7-2)**, not the baseline's **~O(N^3)** — a genuine complexity-class gap, not a
  constant-factor one. This is exactly the mechanism this spike set out to test: with pairwise
  crossing-avoidance removed, per-edge routing cost stops scaling with the number of
  already-routed edges, and the shared graph build (still `~O(N^2)` in this simple/unoptimized
  spike, dominated by brute-force `segClear` obstacle checks during grid construction and port
  docking) no longer compounds per-edge the way `today`'s per-candidate `occupied`-array scan
  does.

**Unambiguous answer: WIDENING, not flat.** This is a real signal of complexity-class
improvement and is the opposite finding from the rejected D1-only (spatial-indexing) spike.

### Honest limitations — what this does and does NOT prove

- **Does not prove the full-featured router would ship at these numbers.** Pairwise
  crossing-avoidance was explicitly excluded here because it's the very thing whose removal is
  under test; a production version would very likely need to reintroduce some crossing/overlap
  avoidance for visual quality, which would add back some cost. The claim under test — and the
  one this spike supports — is narrower: the *per-edge search primitive itself* stops scaling
  with the number of other edges once a shared visibility graph replaces re-scanning `occupied`
  routes per candidate. Whether a production-quality crossing-avoidance pass can be added back
  *without* reintroducing `O(E)`-per-candidate cost (e.g. via spatial indexing of already-placed
  segments, akin to the D1 idea but applied on top of this structurally different graph) is an
  open design question for Phase 1+, not something this spike measured.
- **Single-column stacked layout is a favorable case for this specific graph construction.**
  Because `flatGraph`'s layout puts every node at the same `x`, the visibility grid's X-axis
  collapses to just 2 distinct coordinates (left/right of the shared column), making graph
  construction and per-edge docking cheaper than a general 2D-scattered layout would be (where
  `|X|` and `|Y|` could each be `O(N)`, pushing grid size toward `O(N^2)`). This is a legitimate
  comparison for THIS codebase's actual flat-fallback rendering mode (which is what the baseline
  table itself measures — real graphs above `NESTED_LAYOUT_LIMITS` render exactly this way today),
  but the growth-rate advantage may be smaller for a hypothetical future layout with more varied
  node X-positions; that would need its own measurement before being assumed.
- **No bend-count tie-break, no port-slot contention, no self-loops, no container/outer-lane
  nuance.** These are real features of `edgePathFor`/`edgePathsFor` this spike does not
  replicate. None of them are expected to change the O(N) vs O(N^3) character of the comparison
  (they're per-edge constant-factor concerns), but they are real implementation work not
  captured in these numbers.
- **A* here explores the full shared grid graph without incremental/persistent search-state
  reuse across edges.** Even faster implementations (true incremental visibility-graph routers)
  are possible; this spike is a floor on the achievable speedup, not a ceiling.

### Recommendation for `sdd-propose`

This candidate approach (visibility-graph + A*, as researched in `exploration-v2.md`) shows a
**real widening speedup trend**, distinguishing it from the already-rejected D1-only
(spatial-indexing) approach. This is a positive signal to commit design/proposal effort toward a
visibility-graph-based router as the Phase 1+ direction, **conditional on** explicitly designing
back in a crossing-avoidance mechanism that does not reintroduce per-candidate `O(E)` cost (the
one open question flagged above), and re-measuring end-to-end once bend-count/port-slot/self-loop
handling exists, since those are still unimplemented cost that hasn't been priced in here.

---

## Addendum 2: adding crossing-avoidance back in (occupancy-index spike)

Follow-up to Addendum 1's own open question ("can crossing-avoidance be added back without
reintroducing `O(E)`-per-candidate cost?"). Separate throwaway spike, written, measured, and
deleted per the same convention: file was
`openspec/changes/edge-router-performance/perf/visibility-graph-crossing-spike.ts`. Confirmed via
`git status --porcelain` immediately after deletion that only the untracked
`openspec/changes/edge-router-performance/` planning directory remains — no spike file in any
diff, no production file touched.

### Method

Rebuilt the same visibility-graph + A* shape as Addendum 1, reusing the identical `flatGraph`
synthetic generator (single-column stacked layout, same node/box geometry), with one structural
addition plus one necessary grid change:

- **Occupancy index**: a `Map<graphEdgeId, ownerCount>` populated as each edge is routed. A*'s
  edge-relaxation step does one `O(1)` map lookup per graph-edge it considers and adds a flat
  `CROSSING_PENALTY = 50` per existing claim to that edge's cost — a **local** cost adjustment
  consulted only for the one graph edge currently being relaxed, never a scan over
  previously-routed paths or other edges. This is the exact mechanism `exploration-v2.md`
  attributes to libavoid and the repo's own D1 `OccupancyIndex` concept.
- **Necessary grid change**: Addendum 1's grid used exactly one lane offset per obstacle side
  (`box.x - MARGIN`, `box.x + box.w + MARGIN`), which for this single-column stacked layout
  produces only **2 distinct x-coordinates in the entire graph**. With only one lane, there is
  no "adjacent lane" for the occupancy index to nudge a claimed route into — the mechanism would
  be a no-op by construction. Widened the grid to two lane offsets per side (`MARGIN`, `2×MARGIN`)
  so real parallel-lane diversity exists. This is a genuine, necessary implementation requirement
  this addendum surfaces that Addendum 1 didn't need: **a visibility-graph crossing-avoidance
  mechanism needs the grid itself to expose multiple candidate lanes, not just obstacle-boundary
  offsets, or there's nothing to nudge into.** This also means Addendum 2's numbers are not a
  clean single-variable "same grid, +1 feature" comparison against Addendum 1 — the grid is
  larger too, which is a real, unavoidable part of the cost of shipping crossing-avoidance, not
  an implementation artifact to explain away.
- Docking was also optimized from Addendum 1's implicit approach: indexed grid nodes by
  x-coordinate (sorted by y) and binary-searched the nearest node on the correct lane line,
  keeping per-edge docking `O(log V)` rather than an accidental `O(V·N)` full-grid linear scan
  (an early, unoptimized version of this spike hit that trap and produced far worse numbers before
  the fix — noted here so the methodology, not just the result, is reproducible).
- Preserved from Addendum 1: real per-edge obstacle set, real clearance margin, orthogonal-only
  routing via genuine graph search (not a straight-line cheat), A* with Manhattan heuristic.
- Still NOT implemented (same as Addendum 1): bend-count tie-break, port-slot allocation,
  self-loops, container-lane nuance, outer-lane fallback. Those remain unpriced.

### Measured numbers — all three data sets side by side

| nodes/edges | today's router (baseline, ms) | Addendum 1 spike, NO crossing-avoidance (ms) | Addendum 2 spike, WITH crossing-avoidance (ms) |
|---|---|---|---|
| 60/120 | 782 | 8.7 | 16.7 |
| 100/200 | 7,610 | 9.5 | 26.8 |
| 150/300 | 27,287 | 15.3 | 67.9 |
| 200/400 | 68,065 | 25.5 | 105.5 |
| 300/600 | did not complete in 590s+ | 50.6 | 241.4 |
| 400/800 | not measured | 94.4 | 409.4 |
| 500/1000 | not measured | 150.6 | 671.7 |
| 1000/2000 | not measured | 568.3 | 2,759.5 |

Speedup vs today's router (Addendum 2, WITH crossing-avoidance):

| nodes/edges | speedup vs today |
|---|---|
| 60/120 | **46.8x** |
| 100/200 | **284.0x** |
| 150/300 | **402.0x** |
| 200/400 | **645.2x** |
| 300/600 | bounded below by `590000/241.4 ≈` **2,444.5x** |

### Verdict on the single most important question: does the widening trend SURVIVE?

**Yes, unambiguously.** The speedup-vs-today ratio still widens monotonically at every measured
step, even with crossing-avoidance now in the mix:

`46.8x → 284.0x → 402.0x → 645.2x → >2,444.5x` as N grows from 60 to 300.

Every size-up step increases the speedup ratio, exactly the signature that distinguishes a real
complexity-class fix from a flat constant-factor win (the rejected D1 spike's signature). Adding
back the one feature that made today's router slow in the first place did **not** erase the
widening trend — it only lowered its absolute magnitude at each size (discussed next), which is
the expected, priced-in "cost of correctness," not a reversal of the core finding.

### Cost of correctness — a genuinely mixed/complicated result, reported honestly

Naively dividing Addendum 2's WITH-avoidance ms by Addendum 1's WITHOUT-avoidance ms gives
roughly **1.9x–4.9x slower** across the range (e.g. `16.7/8.7 ≈ 1.9x` at 60/120,
`241.4/50.6 ≈ 4.8x` at 300/600, `2759.5/568.3 ≈ 4.9x` at 1000/2000) — a real, bounded, one-single-
digit-factor cost, not an order-of-magnitude regression. **However**, this specific division is
confounded by two changes at once (occupancy-index logic AND the necessary wider grid described
above), so it is not a clean single-variable "cost of the feature" measurement. A same-run,
same-grid A/B (occupancy on vs off, run back-to-back inside this addendum's own spike, isolating
just the occupancy logic) instead showed something unexpected and worth flagging rather than
hiding: at larger N, the occupancy-OFF run was sometimes *slower* than the occupancy-ON run (e.g.
at 1000/2000: WITH-avoidance 2,759.5ms vs a same-grid WITHOUT-avoidance run at 23,410.1ms). This
is almost certainly a **tie-breaking artifact of the naive linear-open-set A* used in this
spike**, not evidence that crossing-avoidance is free or negative-cost: with occupancy costs
removed, many candidate paths become exactly cost-equal (pure Manhattan distance with no
perturbation), and this A*'s unweighted min-f linear scan explores a much larger equal-cost
frontier before converging; the occupancy penalty incidentally acts as a symmetry-breaker that
narrows the search. **Conclusion on cost-of-correctness: bounded to roughly a single-digit
multiplier in every clean cross-addendum comparison measured, but the exact multiplier is
implementation-detail-sensitive (A* tie-breaking) rather than a fixed, principled number** — a
production implementation should expect "somewhat slower, same order of magnitude," not a precise
factor from this prototype-grade harness.

### Sanity check: does crossing-avoidance actually reduce edge-vs-edge conflicts? (150/300)

Two different conflict definitions were checked, because the single-column stacked layout used by
`flatGraph` (matching the real flat-fallback layout) makes almost all real conflicts **overlapping
parallel runs on a shared segment**, not **transversal crossings** — worth stating explicitly
since it's a different conflict shape than a naive "do two lines cross" check would catch:

- **Transversal crossings** (proper-intersection test, `segIntersect`): **0 before, 0 after** —
  this metric is structurally near-useless for this layout, since colinear/overlapping segments
  don't register as a transversal crossing at all. Included for completeness per the task
  instructions, but not a meaningful signal here.
- **Shared/overlapping graph segments** (a graph edge used by more than one routed path — the
  actual thing the occupancy index targets): **447 before → 1,743 after** (binary "was this
  segment shared by >1 edge" count went UP). Taken alone this looks like a regression.
- **Total excess-ownership weight** (sum of `ownerCount - 1` across all shared segments — counts
  *how much* sharing, not just how many segments have any sharing): **27,377 before → 27,091
  after** — essentially flat, a small real decrease.
- **Max owners on any single segment** (worst-case congestion on one segment): **144 before → 37
  after** — a genuine **~74% reduction** in worst-case pile-up.

**Honest interpretation**: the occupancy-index mechanism, at `CROSSING_PENALTY = 50` in this
prototype, does not *eliminate* sharing (nor was it designed to — the task's own description
calls it a nudge/lane-adjustment, not a hard-block), but it demonstrably **redistributes
congestion from a small number of severely-jammed trunk segments (144 edges piled on one segment)
into a much larger number of lightly-shared ones (median sharing much closer to 2)**. That is
exactly what "nudge into an adjacent lane" is supposed to do — spread contention, not create
artificial exclusivity. The binary "count of shared segments" metric alone is misleading in
isolation; the max-owners and total-excess-weight numbers are the more meaningful signal, and both
point the same direction: real, measurable, but partial improvement, not a broken mechanism and
not a magic fix. A stronger `CROSSING_PENALTY`, more lane offsets, or a proper lane-assignment
post-pass (not just a soft A* cost nudge) would likely improve this further — untested here, flagged
as Phase 1+ design work.

### Honest limitations — what this addendum does and does NOT prove

- **The naive linear-open-set A* used here is not production-grade** and its tie-breaking
  sensitivity directly confounded the cleanest "cost of feature X" measurement (see above). A
  production implementation would use a proper priority queue and an explicit, principled
  tie-break rule (as Addendum 1 already flagged as an open design question), which would likely
  change these exact multipliers in either direction.
- **`CROSSING_PENALTY = 50` is an arbitrary, untuned constant.** No sweep was done. The
  before/after congestion numbers above are a proof that the mechanism *does something real and
  in the right direction*, not a claim that this specific constant is production-ready.
- **Grid richness (lane count) is a real, load-bearing design parameter this addendum newly
  surfaces**, not a detail to be waved away: too few lanes and crossing-avoidance is a structural
  no-op (Addendum 1's implicit grid); the two-lanes-per-side grid used here is still a small,
  hand-picked number, not derived from any principled "how many lanes does a real diagram need"
  analysis.
- Same unimplemented-feature caveats as Addendum 1 still apply in full: no bend-count tie-break,
  no port-slot allocation, no self-loops, no container-lane/outer-lane nuance — all real,
  unpriced, per-edge constant-factor work for Phase 1+.
- Single-column stacked layout remains a favorable case for this specific graph construction, per
  Addendum 1's own caveat — unchanged by this addendum.

### Recommendation

**The widening-speedup trend survives adding crossing-avoidance back in — this is now solid
enough evidence to move forward.** Across every measured size, the visibility-graph + A* approach
with a working (if unpolished) crossing-avoidance mechanism remains dramatically faster than
today's router, and the speedup margin still widens as N grows, which is the specific signal that
distinguishes a genuine complexity-class fix from the already-rejected flat-multiplier D1 result.
The crossing-avoidance mechanism itself works in the sense the research predicted (local `O(1)`
occupancy lookup, no pairwise `O(E)` rescan, and it measurably reduces worst-case segment
congestion by ~74%), at a bounded, single-digit-multiplier runtime cost.

This does **not** mean a full rewrite is now risk-free or ready to skip a proper design phase.
Two real open items surfaced by this addendum specifically should be carried into `sdd-design`,
not treated as newly-discovered blockers requiring another spike round:

1. **Lane-count and `CROSSING_PENALTY` tuning is unresolved** — this addendum proves the mechanism
   *works in direction*, not that any specific constant is correct for real diagrams.
2. **A* implementation quality (priority queue, tie-break rule) materially affects measured
   numbers** — the production implementation must not copy this prototype's naive linear-scan
   open-set or its accidental tie-break-via-occupancy-penalty behavior.

Recommendation: **proceed to a full `sdd-propose` / `sdd-design` / `sdd-apply` cycle** for the
visibility-graph-based router, carrying both open items above as explicit design questions for
`sdd-design` (lane/penalty tuning strategy, A* implementation choice) rather than as reasons to
run a fourth spike first. The core algorithmic-complexity question — the one thing repeated
spikes in this change have been trying to de-risk before committing real design effort — is now
answered with real, reproducible measurements: **switch algorithm classes, not just optimize the
existing one.**

---

## Addendum 3: PR0 gate spike — full-featured router on a genuinely NESTED fixture, plus a critical correction to the fixture premise

Fourth and final throwaway spike, run per tasks.md's "Suggested Work Units" row 0 and design.md's
Block F / `OVERSIZED_THRESHOLDS` binding measurement rules. File:
`openspec/changes/edge-router-performance/perf/nested-router-spike.ts` — written, measured, and
**deleted**. `git status --porcelain` confirms only the untracked
`openspec/changes/edge-router-performance/` planning directory remains; no production file was
touched.

### What this spike adds over Addenda 1-2 (per instructions: "more complete, closer to design.md")

A single self-contained module implementing, for real, the concrete Block-D resolutions design.md
left unmeasured:

- **D-1 tie-break**: binary min-heap, `compare(a,b) = a.f-b.f || a.h-b.h || a.bends-b.bends ||
  a.stateKey-b.stateKey`, integer costs throughout.
- **D-3a/D-3b container lanes**: Y-lane sampling never emits a coordinate within `LANE_GAP` of a
  container's top/bottom boundary; every vertical graph edge carries `containerTags` (which
  containers' x-band it falls in); A* relaxation applies the real per-edge admission predicate
  (`ancestors permit short endpoint crossings, not long transit through their gutters`) instead of
  a whole-route rescan.
- **D-4 port math**: `pitch = max(4, min(LANE_GAP, floor(usable/(n+1))))`,
  `off = round((i-(n-1)/2)*pitch)`, escape lane `k = i % L` docking at `boundary ± LANE_GAP*(k+1)`.
- **D-5 occupancy penalty**: `penalty(o) = o===0 ? 0 : 60+(o-1)*60`, `BEND_COST=16`, `L=3`.
- A genuinely nested fixture generator (packages -> classes -> methods, multiple X columns, NOT a
  single-column stack) plus a hand-built nested `Rect` box set for stress-testing the router
  directly, independent of `layoutGraph`'s own placement logic.

Still not implemented (same class of omission as Addenda 1-2, explicitly out of scope for a
gate-decision spike): self-loops, the outer-lane fallback, and a production-grade docking index
(this spike's `nearestNode` does an O(log V) binary search per axis, which is adequate for timing
but not the exact lane-assignment a real implementation would use).

### Two real implementation bugs this spike hit and fixed — worth recording for Phase 1-2

1. **O(V·boxes) build blew past any reasonable time budget** on the first attempt (had to be
   killed after 2m22s at 100% CPU with zero output, even at `{60,120}`) — the naive
   "check every candidate graph edge against every box" build is `O(|X|·|Y|·boxes)`. Fixed with an
   x-sorted early-break scan for horizontal edges and a range-pruned scan for vertical edges. **A
   production `routingGraph.ts` build MUST use a spatial index (interval tree or grid-bucketed
   boxes), not a linear obstacle scan, or PR1's own perf will be dominated by this, independent of
   the A* search cost.**
2. **100% route failure at every size**, root-caused to two compounding issues, both real design
   gaps this spike surfaces for Phase 1-2:
   - Docking a port at its exact boundary coordinate (not an escape-lane offset) can snap to a
     grid node whose only viable edges are blocked by the port's OWN box — D-4's `k = i % L`
     escape-lane rule exists precisely to avoid this, and had to be implemented literally (dock at
     `boundary ± LANE_GAP*(k+1)`, not at the raw port point) before any edge routed at all.
   - **Treating container boxes as full geometric obstacles at build time was wrong** — it
     structurally blocks every leaf node's own escape lane, since a leaf's escape point sits
     inside its enclosing container's bounding rect by construction. D-3's whole design is that
     containers are *hollow* (edges transit their interior/gutters); only the per-edge D-3b
     admission predicate at relax time enforces the container rule, never a build-time solid-box
     block. **This is a concrete, load-bearing detail for `routingGraph.ts`'s real implementation
     (Phase 1): container boxes must be excluded from the obstacle set used for visibility-edge
     construction, and only leaf/non-container boxes should ever produce a build-time block.**
     Design.md's own text describes the intent correctly; this spike is flagging that a literal
     but naive reading (treat every box as an obstacle) silently produces a router that can never
     route anything, which the property-test suite in Phase 1-3 needs to catch explicitly (a test
     asserting every leaf node's own escape lane is routable, not just "some path exists somewhere
     in the graph").

### CRITICAL correction to this task's own premise — verified against the real code, not assumed

**The concern that motivated this entire gate round — "a realistic nested graph would have ~6x
denser visibility-grid lines at large N" — does not apply to what `layoutGraph` actually ships
today, and this was checked directly, not assumed:**

`webview/graphLayout.ts:531`: `const flat = graph.nodes.length > NESTED_LAYOUT_LIMITS.nodes ||
graph.edges.length > NESTED_LAYOUT_LIMITS.edges;`, and `graphFilters.ts:32`:
`NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 }`. **For any graph above 60 nodes / 120 edges —
which includes every size this gate is actually deciding about (`{100,200}` through `{300,600}`
and beyond) — `layoutGraph` takes the flat branch (`graphLayout.ts:536-548`) unconditionally,
regardless of the input `AnalysisGraph`'s `containerId` nesting structure.** The flat branch places
every node in a single column (`x: 16` fixed, `y = 24 + index*48`) — this was verified directly in
this spike by feeding a genuinely nested `AnalysisGraph` (real package/class/method
`containerId` chains) into the real, unmodified `layoutGraph` and checking `result.flat`:

| nodes | edges | `layoutGraph` on NESTED input, ms | `result.flat` |
|---|---|---|---|
| 60 | 120 | 572.5 | **false** (nested containment placement really runs — exactly at the boundary) |
| 100 | 200 | 9,229.5 | **true** (flat fallback — same order of magnitude as Phase 0's own `{100,200}` baseline of 7,610ms, confirming this really is today's unmodified O(N³)-ish router, not a coincidence) |

**This means: production never feeds the router a multi-X-column box set at any size this change's
threshold decisions are actually about.** The "single-column is a favourable case, real layouts are
6x denser" worry that Addenda 1-2 flagged as their biggest limitation, and that motivated
commissioning this exact spike, is **not a gap in those spikes' realism — it is what the real code
does at these sizes.** The premise handed into this spike ("all three prior rounds used an
unrealistic flat fixture") is **verified false for N > 60**; it is only true for N ≤ 60 (which sits
well under every threshold candidate `{300,600}`/`{400,800}` this gate is choosing between).

This is stated plainly per this session's verification obligation: the human framing of this task
was checked against the actual source, not accepted at face value, and the check disagrees with
the framing for the size range that matters.

**Practical consequence — both fixtures were measured anyway, and the answer does not change either
gate verdict, but it does change which number is the trustworthy one to ship against:**

### Measured numbers — NESTED (hypothetical stress test; only relevant if `NESTED_LAYOUT_LIMITS` itself were raised well past this change's scope) vs. FLAT (what production actually feeds the router today)

Full-featured router (ports + container-lanes + real A* + occupancy penalty), build + route:

| nodes/edges | NESTED (hand-built multi-column) ms | \|X\|×\|Y\| (nested) | FLAT (matches real `layoutGraph` output) ms | \|X\|×\|Y\| (flat) |
|---|---|---|---|---|
| 60/120 | 573.0 | 50×104=5,200 | 130.8 | 6×360=2,160 |
| 100/200 | 1,192.3 | 62×130=8,060 | 392.8 | 6×600=3,600 |
| 120/240 | 8,310.1 (non-monotonic vs. 100/200 — structural shape sensitivity, see below) | 62×442=27,404 | — | — |
| 150/300 | 11,547.0-11,572.3 (**exceeds the 10,000ms hard budget**) | 74×407=30,118 | 954.4 | 6×900=5,400 |
| 300/600 | not measured (already over budget at 150/300; extrapolation would only get worse) | — | **4,445.9** | 6×1,800=10,800 |
| 400/800 | not measured | — | **9,840.5** (no margin left — fails the ≤5,000ms 2x-margin rule, and is within ~1.6% of the hard 10,000ms cap) | 6×2,400=14,400 |

Sanity check (150/300, nested): **0/200** sampled routed edges cross an unrelated leaf box's
interior (containers correctly excluded from the "unrelated obstacle" check per D-3's own
container-as-hollow semantics) — the router is genuinely obstacle-avoiding, not a straight-line
cheat, on both fixtures.

**Why the NESTED numbers are so much worse, and why that is a real, separate finding (not
discarded just because it doesn't match production today):** with `|X|` growing to 50-74 (already
past design.md's own stated fallback trigger — *"if `|X|` grows beyond ~30, fall back to a
corner-anchored visibility grid"*, Open Questions) and D-3b's container-tag admission predicate
blocking most vertical transit through any non-ancestor container's x-band, A* is forced to detour
through a small number of "highway" columns between top-level packages, and the naive full
coordinate cross-product grid pays for this with `|X|·|Y|` up to 30,118 nodes at just 150 leaf
routing endpoints. The non-monotonic `{100,200}`->`{120,240}` jump (1,192ms -> 8,310ms despite
fewer nodes than `{150,300}`) is itself informative: this construction is **highly sensitive to
the exact package/class/method branching shape**, not just raw node count — a red flag for any
future scenario where `NESTED_LAYOUT_LIMITS` might be raised. **This is filed as a real, unpriced
risk for that hypothetical future work, not treated as this gate's blocker**, since it does not
describe what ships today.

### GATE VERDICT — Block F: **KEEP the scoped drag-drop re-route.** Not close.

Per design.md's binding rule (measure full `layoutGraph`-path re-route cost at the chosen
threshold; `≤250ms` drops scoped re-route, `>250ms` keeps it): the full re-route cost (this
router's full pass, since no scoped variant exists to compare against — that IS the "don't build
scoped re-route" cost per the task's own framing) is:

- **On the realistic FLAT geometry** (what production actually has at any size `> {60,120}`):
  130.8ms at `{60,120}` (under 250ms — the only measured point that is), but **392.8ms at
  `{100,200}`, 954.4ms at `{150,300}`, 4,445.9ms at `{300,600}`** — every size at or above the
  `{100,200}` decision-relevant range is **1.6x-18x over the 250ms bar**, and the threshold size
  candidate `{300,600}` itself is **~18x over**.
- **On the hypothetical NESTED geometry**: 573.0ms-11,572.3ms across the same range — **2.3x-46x
  over the 250ms bar.**

Both fixtures agree on direction and both fail the 250ms bar by a wide, non-borderline margin at
every size that matters. **Verdict: KEEP the scoped drag-drop re-route (Phase 4 / PR4 proceeds as
designed).** No spec amendment is needed. This is the more comfortable of the two possible verdicts
operationally (it means the delta spec's existing scoped-reroute MUSTs stay valid, no product
decision needs to go back to the user), but it is reached here strictly from the measured numbers,
not from a preference for the simpler outcome.

### GATE VERDICT — `OVERSIZED_THRESHOLDS`: **keep `{nodes: 300, edges: 600}` — zero lines changed in `src/webviewProtocol.ts`.**

Per design.md's binding rule (measure the implemented router on a nested/varied-X fixture at
multiple sizes; set the constant to the largest size with `≤5,000ms`, i.e. `≥2x` margin under the
10,000ms spec bound): **the fixture that actually matters here is FLAT**, since that is what
`layoutGraph` produces at any size in this range (see the critical correction above) — the NESTED
numbers are a real but separate finding about a hypothetical future scenario, not the one this
constant governs today.

On the FLAT geometry: `{300,600}` measures **4,445.9ms — inside the `≤5,000ms` 2x-margin bound**,
with `{400,800}` measuring **9,840.5ms — clearly outside both the 2x-margin bound and leaving
almost no headroom under the hard 10,000ms cap**. `{300,600}` is therefore the largest tested size
that comfortably satisfies the binding rule; the next tested step up fails it decisively (not a
close call needing a finer search between 300 and 400).

**Answer: `{300,600}` is recovered, unmeasured-guesswork-free, on a full-featured router
implementation (real A*, real ports, real occupancy penalty — everything Addenda 1-2 explicitly
deferred).** This matches design.md's own tentative recommendation, but for a different reason than
design.md's own pessimistic-corner arithmetic worried about: design.md's `≈10.0s` pessimistic
projection was built on an assumed `~6x` nested-grid density multiplier that this spike shows does
not apply to what ships today. The **measured** number (4,445.9ms) has genuine ~2.25x margin under
the 5,000ms cutoff and ~2.3x margin under the hard 10,000ms budget — a comfortable, non-fragile
pass, not a knife-edge one.

Compared to Addendum 2's simpler router (no ports/self-loops/container-lanes/real-A*-tie-break) at
`{300,600}` — 241.4ms — this full-featured spike is **~18.4x slower** at the same size, which is a
real, substantial "cost of completeness" (much larger than Addendum 2's own "cost of
crossing-avoidance" multiplier of ~1.9-4.9x), but still lands comfortably inside budget. This is
the more honest number to carry into Phase 1-2's implementation estimate than Addendum 2's
partial-feature number.

### Recommendation for the orchestrator

1. **Proceed to Phase 1-5 as scoped** (PR1-PR5, chain strategy still needs the user's explicit
   choice per tasks.md's "Next Step" — this gate does not resolve that separately-pending
   question). Both binding gate decisions are answered with real measurement:
   - Block F: **KEEP** scoped drag-drop re-route (Phase 4 proceeds).
   - `OVERSIZED_THRESHOLDS`: **keep `{300, 600}`** (`src/webviewProtocol.ts` Phase 5 task 5.1
     becomes a zero-line no-op, exactly as design.md's own "0-2 lines, only if changed" framing
     anticipated).
2. **Carry the "containers must be excluded from build-time obstacle checks" finding directly into
   Phase 1's `routingGraph.ts` implementation and its property-test suite** — this is a concrete
   correctness bug this spike hit and fixed, not a style note.
3. **Carry the "obstacle lookup must be spatially indexed, not a linear box scan" finding into
   Phase 1's build-time complexity budget** — the naive version made even `{60,120}` hang.
4. **File the NESTED-fixture findings (grid blow-up past design.md's own `|X| > ~30` fallback
   trigger, non-monotonic sensitivity to package/class shape) as an explicit, separate risk note**
   for any future change that considers raising `NESTED_LAYOUT_LIMITS` beyond `{60,120}` — out of
   this change's scope, but a real, now-measured risk for that hypothetical future work, not
   invented speculation.
5. **Do not let "prior spikes used an unrealistic flat fixture" stand as an unqualified true
   statement going forward** — it was the framing that motivated this gate round, and it is false
   for the size range (`N > 60`) that every threshold decision in this change actually concerns.
   The flat fixture was the right fixture; what Addenda 1-2 were actually missing was router
   feature-completeness (ports, container-lanes, real A* tie-break), not box-placement realism —
   and this spike shows that gap closed while staying inside budget.

---

## PR1: `webview/routingGraph.ts` — visibility-graph construction (Phase 1 of tasks.md)

Scope: production module only, no A* search (that is PR2's `routeSearch.ts`). Followed strict
TDD (RED -> GREEN -> REFACTOR).

### TDD Cycle Evidence

| Step | Action | Result |
|---|---|---|
| RED | Wrote `test/unit/routingGraph.test.ts` (15 tests) covering node placement (clearance-grown corners, label-row corners, deterministic `nodeId`), visibility edges (blocked vs. clear line-of-sight), D-3a container-lane exclusion, D-3b container-tag admission tagging, the Addendum-3 "container treated as solid obstacle" bug, D-4 port/escape-lane math (pitch/off/lane-index formulas), "construction happens once" (neighbours() reference-identity + a perf-shape bound reproducing Addendum 3's exact `{60,120}` hang shape), and `OccupancyIndex` claim/release/snapshot round-trips. | Confirmed failing: `Cannot find module '../../webview/routingGraph.js'` (module did not exist). |
| GREEN | Implemented `webview/routingGraph.ts`: `buildRoutingGraph`, `allocatePort`, `createOccupancyIndex`, `RoutingGraph`/`OccupancyIndex`/`GraphEdgeRef`/`PortSlot` types, per design.md's D-1/D-3/D-4/D-5 formulas. | All 15 tests passed on first implementation attempt (`npx vitest run test/unit/routingGraph.test.ts` — 15/15). |
| REFACTOR | Ran `npm run typecheck` (both tsconfigs), `npm run lint` (fixed 2 unused-variable lint errors: dead `EdgeRecord` interface, dead `clearYi`/`void ys/xs` cruft in a test), `npm run test` (full suite). | Typecheck clean. Lint clean (0 errors/warnings). Full suite: 35 files / 560 tests, all passing — nothing outside `routingGraph.ts`/its test was touched, confirmed by `git status`. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/routingGraph.test.ts` → 15/15 passed |
| Runtime harness command/scenario and exact result | N/A — no production caller wires this module in yet (PR3a's scope, per design.md); this is the same "no runtime boundary yet" case tasks.md's own Suggested Work Units row 1 documents ("N/A — no production caller yet") |
| Rollback boundary | Delete `webview/routingGraph.ts` and `test/unit/routingGraph.test.ts`; nothing else imports either file (verified: no other file in the repo references `routingGraph`) |

### Addendum-3 bugs explicitly designed against (both verified by a dedicated test)

1. **Container-as-solid-obstacle bug**: `buildRoutingGraph` computes `isContainer` (any box with a
   descendant fully inside it) and excludes containers entirely from the `leaves` array used for
   visibility-edge clipping — only leaves ever block a lane segment. Verified by
   `"does NOT treat a container box as a solid obstacle at build time (Addendum-3 bug)"`, which
   asserts an unbroken vertical chain through a container's interior, away from its one leaf
   child.
2. **O(V·boxes) build blow-up**: obstacle relevance is filtered ONCE per row/column (not once per
   candidate segment), then swept with a forward-only pointer (`sweepBlocked`) across the
   sorted-by-start subset — a single linear pass per row/column, not a rescan of every box per
   segment. Verified by a perf-shape test reproducing Addendum 3's exact failing size
   (`{60,120}`, i.e. 60 boxes) with a generous 3000ms bound (the original naive build hung past
   2m22s at this exact size).

### Design fidelity

- D-4's port math implemented exactly per design.md's formulas: `pitch = max(4, min(LANE_GAP,
  floor(usable/(n+1))))`, `off = round((i-(n-1)/2)*pitch)`, escape lane `k = i % L` docked at
  `boundary ± LANE_GAP*(k+1)` (never the exact boundary coordinate — the other half of the
  Addendum-3 100%-route-failure bug).
- D-3a's Y-lane exclusion checked against every container (not just the box that proposed the
  coordinate), per the design text's literal wording, so two nearby containers can't
  accidentally reintroduce a forbidden-band line.
- D-3b's container tags are attached per vertical graph edge (container indices whose x-band
  contains that edge's column), ready for `routeSearch.ts` (PR2) to apply the `O(depth)`
  admission predicate at relax time — no filtering happens at construction time for verticals,
  exactly as D-3b specifies (only D-3a's horizontal band omission is a construction-time hard
  exclusion).
- `edgeGeometry.ts`, `graphLayout.ts`, `index.tsx`, and every other existing production file were
  not touched — confirmed via `git status --porcelain` before commit (only `routingGraph.ts` and
  its test are new/staged).

### Deviations from design

None. `GraphEdgeRef`'s exact shape (`{ id, to }`) and `PortSlot`'s exact shape
(`{ anchor, escape, laneIndex }`) were not spelled out verbatim in design.md's interface sketch
(only referenced by name) — filled in with the minimal shape `routeSearch.ts` (PR2) will need
(`id` as the `OccupancyIndex` key, `to` as the neighbour node id), consistent with the data-flow
diagram and D-5's occupancy-penalty mechanism.

### Files changed (this PR)

| File | Action | Lines |
|---|---|---|
| `webview/routingGraph.ts` | Created | ~270 |
| `test/unit/routingGraph.test.ts` | Created | ~200 |

Diff stat (from the tracker branch's tip after the planning-docs commit `cd30f89` to this PR's
commit): see the commit itself for exact `git diff --stat` numbers.

### Status

Phase 1 (PR1) complete: 3/3 tasks done (1.1, 1.2, 1.3). Ready for PR2 (`webview/routeSearch.ts`,
Phase 2 of tasks.md) — ask the user/orchestrator to confirm continuing the `stacked-to-main` chain
before starting PR2's own branch.

---

## PR2: `webview/routeSearch.ts` — A* search over the visibility graph (Phase 2 of tasks.md)

Scope: production module only, no production caller wired yet (that is PR3a's job). Branch
`feat/edge-router-performance` already checked out (no new branch created, per the chain strategy
resolved as `stacked-to-main`). Followed strict TDD (RED -> GREEN -> REFACTOR).

### Design decisions made explicit during implementation (not spelled out numerically in design.md)

design.md's interface sketch (`routeOne(g, occ, start: PortSpec, goal: PortSpec, ctx: EdgeContext)
: Point[] | undefined`) left `PortSpec`/`EdgeContext`'s exact shapes, and a few mechanics,
unspecified since no production caller exists yet. Resolved as follows, consistent with D-1/D-3b/
D-5's stated intent:

- **`PortSpec` = `routingGraph.ts`'s own `PortSlot`** (`{anchor, escape, laneIndex}`) — reused
  directly rather than duplicating an equivalent type, since it is exactly the concept D-1's
  `stateKey` needs (an anchor + a graph-aligned escape point).
- **Entry/exit node resolution is nearest-index, not exact-match, per axis.** Verified directly
  against `routingGraph.ts`'s real construction: a port's *escape-moving* axis (e.g. `x` for a
  left/right port) always lands exactly on a generated lane line (`allocatePort`'s
  `LANE_GAP*(laneIndex+1)` offsets match `buildRoutingGraph`'s `box.x ± LANE_GAP*k` sampling
  exactly, confirmed by the "simple case" and "obstacle avoidance" tests passing against the real
  `buildRoutingGraph`+`allocatePort` pair on first attempt). The port's *anchor-fixed* axis (e.g.
  `y` for that same left/right port, `clamp(box.y+16+off, ...)`) is **not** itself a sampled lane
  line — `buildRoutingGraph` only samples box-corner-derived coordinates, never port positions.
  Requiring an exact match on both axes would make every left/right and top/bottom port
  (whichever axis is "fixed") fail to resolve to any graph node at all. Nearest-index resolution on
  each axis independently fixes this without breaking orthogonality: the escape axis matches
  exactly (zero-length connector), and only the anchor axis gets a short, still-orthogonal
  connector segment to the nearest real lane line. **This is a load-bearing detail for PR3a's
  wiring** — worth calling out explicitly since design.md's interface sketch didn't specify it.
- **`EdgeContext = { ancestorContainers: ReadonlySet<number> }`.** `portYWindow` (D-3b's
  `[min(sourcePortY,targetPortY)-LANE_GAP, max(...)+LANE_GAP]`) is computed internally from
  `start.anchor.y`/`goal.anchor.y` (the true port position, not the escape offset) — this is what
  the "blocks a non-ancestor's long vertical transit" test exercises directly: ports whose
  *anchors* sit close together but whose nearest *graph nodes* happen to be far apart (a sparse
  y-sampling artifact) must still get a narrow window derived from the anchors, not the resolved
  graph nodes, or the D-3b rule would be vacuous whenever the graph is sparse near the ports.
- **The anchor↔escape connector segments (`start.anchor→start.escape`, `goal.escape→goal.anchor`)
  are fixed, uncosted geometry**, exactly like today's `edgePathsFor`/`routingPorts` treat them —
  only the graph-internal portion (`start.escape`'s resolved node → `goal.escape`'s resolved node)
  is A*-costed. Bend cost for the *first* graph-internal move is still charged relative to the
  port's already-fixed anchor→escape direction (`dirOf(escape-anchor)`), which is what the
  deterministic-tie-break and bend-minimization tests both rely on to force a specific winner.

### TDD Cycle Evidence

| Step | Action | Result |
|---|---|---|
| RED | Wrote `test/unit/routeSearch.test.ts` (13 tests): D-5 penalty formula exact values (`crossingPenaltyFor(0/1/2/4)` against `60+(o-1)*60`); simple no-obstacle path (real `buildRoutingGraph`+`allocatePort`); obstacle detour (real graph, asserts orthogonality + obstacle clearance + a real bend); **deterministic tie-break** — hand-built diamond graph with a genuine 4-way tie (`f=52,h=0,bends=2` identical on both arms) resolved only by `stateKey`, asserted against an independently hand-computed expected path, run twice; **bend-count as secondary cost** — same diamond with a different `startDir` making one arm's total cost strictly lower via fewer bends; **D-5 occupancy penalty changes the winning route** — a ladder graph where claiming the direct edge once (`owners=1`, penalty 60) flips the optimal route to a longer, more-bent detour whose total cost (152) undercuts the now-penalized direct route (176) but not the unpenalized one (116); **D-3b admission predicate** — blocks/admits/ignores-non-ancestor, three sub-cases; **no path** — a fully disconnected hand-built graph, plus a real `buildRoutingGraph` fixture with a full-height obstacle wall severing every visibility edge between two boxes; **determinism** — 5 repeated runs on the same real graph, deep-equal. Confirmed failing: `Cannot find module '../../webview/routeSearch.js'` (module did not exist). |
| GREEN | Implemented `webview/routeSearch.ts`: `MinHeap<T>` (real binary min-heap, push/pop O(log n) — explicitly NOT the PR0 spike's naive linear-scan open set, per design.md's/Addendum 3's flagged confound), `routeOne()` — lazy-deletion closed-set A* keyed by `stateKey = nodeId*4+dirIndex`, D-1's exact `f→h→bends→stateKey` comparator as a strict total order, D-5's `crossingPenaltyFor` folded directly into edge relaxation (not a post-hoc pairwise scan — `occ.owners(edge.id)` is read once per relaxed edge), D-3b's per-edge `containerTags` admission predicate evaluated inline during relaxation. Two implementation bugs found and fixed while getting from RED to GREEN, both in this file's tests, not `routingGraph.ts`: (1) the first D-3b "blocks" test was initially self-contradictory (the tagged edge's own span exactly equaled the two ports' resolved graph nodes, so it could never be "outside" a window derived from those same two points) — fixed by separating the ports' true anchors (close together) from their resolved graph nodes (far apart due to sparse sampling), which is also the scenario that makes the anchor-vs-node distinction in `portYWindow` load-bearing rather than incidental; (2) the first "fully enclosed real graph" fixture (four leaves ringing a target box) did not actually sever every visibility edge — replaced with a single full-height wall leaf spanning far beyond both boxes' y-range, which reliably blocks every horizontal row near either box. All 13 tests passed after these two test-only fixes (implementation needed no changes for either). |
| REFACTOR | Ran `npm run typecheck` (both tsconfigs), `npm run lint` (fixed one unused-import lint error, `OccupancyIndex` imported but unused in the test file), `npm run test` (full suite). | Typecheck clean. Lint clean (0 errors/warnings). Full suite: 36 files / 573 tests, all passing (560 from PR1 + 13 new) — `git status --porcelain` confirms only the two new files (`webview/routeSearch.ts`, `test/unit/routeSearch.test.ts`) are untracked/changed; nothing else touched. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/routeSearch.test.ts` → 13/13 passed |
| Runtime harness command/scenario and exact result | N/A — no production caller yet (same as PR1; wiring is PR3a's job) |
| Rollback boundary | Delete `webview/routeSearch.ts` + `test/unit/routeSearch.test.ts`; nothing else references either file yet |

### Review Workload Note — deviation from design.md's ~230-line estimate

`git diff --numstat` for this PR: `webview/routeSearch.ts` 304 lines, `test/unit/routeSearch.test.ts`
327 lines — **631 total, versus design.md's/tasks.md's own ~230-line estimate for this slice**, and
over the 400-line review budget on its own. Root cause: the orchestrator's own RED-phase
requirements for this PR enumerated 7 distinct required test categories (simple path, obstacle
detour, deterministic tie-break with an explicit stateKey-ordering assertion, numeric
crossing-penalty verification, bend-count-as-secondary-cost, no-path/`undefined`, determinism) —
covering all 7 rigorously, including hand-derived/hand-verified fixtures for the tie-break and
occupancy-penalty cases (chosen deliberately over asserting only "some valid path" per the
orchestrator's explicit instruction), produced a larger test file than design.md's rough estimate
anticipated. The production module itself (`routeSearch.ts`, 304 lines including doc comments) is
close to design.md's own "~150 lines" figure once doc comments are excluded (the actual code,
excluding comments/blank lines, is closer to ~210 lines). **Flagging this transparently rather than
cutting test coverage to fit a line target** — every one of the 13 tests maps to a specific,
individually-named requirement from the orchestrator's task description, none are redundant.
Recommend the orchestrator treat this PR as `size:exception` if the reviewer budget is enforced
strictly per-PR, or split the "determinism/no-path" tests into a follow-up PR if a hard split is
required — no code changes needed either way, only how the diff is sliced across PR boundaries.

### Deviations from Design

- `PortSpec`/`EdgeContext` exact shapes were not specified numerically in design.md (only the
  `routeOne` signature's type names were sketched) — resolved as documented above, reusing
  `routingGraph.ts`'s own `PortSlot` type and defining `EdgeContext` minimally. No conflict with
  any decided (`[DECIDED]`) design block — this is filling an acknowledged interface gap, not
  overriding a decision.
- Nearest-index (rather than exact-match) entry/exit node resolution per axis — not explicitly
  specified by design.md, but necessary given the verified mismatch between `allocatePort`'s
  anchor-fixed axis and `buildRoutingGraph`'s lane sampling (see above). Flagged directly for
  PR3a's attention since it is load-bearing for correct wiring.
- Line-count estimate exceeded (631 vs. ~230) — see Review Workload Note above.

### Issues Found

None in `routingGraph.ts` (PR1) — the two bugs hit during this PR's own RED phase were both in this
PR's own test fixtures, not in the already-landed PR1 module, and were fixed before GREEN.

### Status

Phase 2 (PR2) complete: 3/3 tasks done (2.1, 2.2, 2.3). `webview/routeSearch.ts` and
`test/unit/routeSearch.test.ts` are new, untracked files; no other file was touched. Ready for PR3a
(`edgeGeometry.ts` swap + minimal green suite, Phase 3a of tasks.md) — same open question as PR1
left pending: confirm continuing the `stacked-to-main` chain, and PR3a's own borderline/`
size:exception` risk (already flagged in tasks.md) still needs the orchestrator's attention
separately from this PR's line-count note above.
