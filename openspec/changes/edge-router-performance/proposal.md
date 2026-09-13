# Proposal: Edge Router Performance

## THIRD SCOPE PIVOT (post-exploration-v2, user decision) — CURRENT DIRECTION

Two rounds of real, Bash-measured prototyping (see `exploration-v2.md` and
`apply-progress.md`'s Addenda 1-2) validated a **visibility-graph + per-edge
A\*** router (the approach production tools like libavoid/ELK use for this
exact problem), with crossing-avoidance included via a per-segment occupancy
index (O(1) local cost lookup, not the O(E) pairwise scan that made today's
router cubic). The speedup vs. today's router **widens** as graph size
grows — 47x at `{60,120}` up to >2,444x at `{300,600}` — confirming a real
complexity-class improvement, not another constant-factor patch. This is
now the confirmed direction: **`sdd-propose` formalizes a full rewrite of
the coordinated routing pass** (`webview/edgeGeometry.ts`'s `edgePathsFor`)
around this architecture, superseding the D1-D3 incremental design (which
real measurement falsified) entirely.

## SECOND SCOPE PIVOT (post-Phase-0-gate, superseded by third pivot above)

Phase 0's empirical gate (`sdd-tasks`' mandatory prototype-and-measure step)
built a real spike of the D1 spatial-index fix and measured it against the
actual router. Result: **STOP**. The D1-only spike gives a consistent but
modest 1.3-1.6x speedup — nowhere near enough. Even optimistically combining
the full D1+D2+D3 fix's estimated per-term gains, `{300,600}` remains several
*minutes* away from the ≤10s budget, and even `{200,400}` (today: 68s) would
still be far over budget. The measured curve is also worse than earlier
estimates: `{300,600}` did not complete in 10 minutes; `{200,400}` alone
takes 68s today (previously only measured up to `{150,300}`=27s).

Shown this evidence, **the user chose to investigate a genuinely different,
deeper algorithmic redesign** rather than accept the lower threshold or
raise the time budget. This is now a much larger, higher-risk undertaking
than the incremental spatial-indexing approach that was just falsified by
real data — a fresh `sdd-explore` is required, informed by everything
learned in this cycle (the exact correctness contract, the three cubic
terms found, and now the real measured ceiling of incremental optimization).

## FIRST SCOPE PIVOT (post-design, user decision)

A first design pass measured the real numbers: with the ≤10s time budget, a
pure threshold-lowering stop-gap forces `OVERSIZED_THRESHOLDS` from
`{300,600}` down to roughly `{90,180}` — because the router's real cost is
≈cubic, not linear, so the 10s ceiling only buys ~90-100 nodes today. Shown
this consequence explicitly, **the user chose to prioritize fixing the
router's algorithmic complexity now**, rather than shipping the threshold
cut as a stop-gap first. This proposal is revised accordingly: the
algorithmic fix (previously "Exploration Option A", deferred) is now
**in scope**, alongside the scoped drag-drop re-route (Option C, unchanged)
and a threshold correction (Option D) whose exact numbers are now derived
**after** the algorithmic fix, from ITS measured cost — not used as a
stand-alone stop-gap ahead of it.

## Intent

`edgePathsFor` (`webview/edgeGeometry.ts:633-726`) is ≈O(E·(N+E)²) (≈cubic), confirmed by a fresh measurement: 60 nodes/120 edges runs in 770ms, but 150/300 already takes 27s — extrapolating past `{300,600}` into multiple minutes. This is why `OVERSIZED_THRESHOLDS` (`{nodes:300, edges:600}`) advertises a size the router cannot render in usable time, and why **every** drag-drop commit re-routes the whole edge set, freezing the one interactive editing feature exactly on the graphs where it matters. This change fixes the root algorithmic cost, not just its symptoms.

## Scope

### In Scope

**A. New shared visibility graph — `webview/visibilityGraph.ts` (new module)**
Built **once per `edgePathsFor` call**, not once per edge. Nodes = obstacle-box
corners grown by clearance + label corners + port anchors; edges = horizontal /
vertical visibility segments clipped at obstacles (reusing `edgeGeometry.ts`'s
existing Liang-Barsky `clipSegment` convention, boundary-touch ≠ crossing). This
replaces both the per-candidate obstacle rescan and the per-edge candidate-grid
rebuild that make today's pass cubic. Round-2 spike surfaced a load-bearing
parameter: the grid must expose **multiple lane offsets per obstacle side**, not
just one, or crossing-avoidance is a structural no-op with nothing to nudge into.

**B. Per-edge A\* over the shared graph — replaces candidate enumeration + `routeCost`**
Manhattan/L1 heuristic with bend-count as secondary cost. Per-edge cost becomes a
function of the (fixed) obstacle graph size, never of how many edges are already
routed. Production-grade priority queue — explicitly **not** the spike's naive
linear-scan open set, whose tie-breaking behavior confounded the round-2 cost
measurement.

**C. Crossing-avoidance via per-segment occupancy index**
Validated in round 2: a per-graph-edge owner-count map consulted as an `O(1)`
local cost adjustment during A*'s relaxation step. Explicitly **not** a pairwise
`O(E)` scan over already-routed paths. Measured effect at 150/300: worst-case
segment congestion `144 → 37` owners (**~74% reduction**), total excess-ownership
weight flat-to-slightly-down.

**D. Fresh design decisions — flagged as `sdd-design` work, deliberately NOT resolved here**
Each of these has **no direct analogue** in the current algorithm and must be
newly designed, not ported:
| Decision | Why it is genuinely new |
|---|---|
| A* deterministic tie-break rule | Today's "first-generated-candidate wins" (strict-`<` in `routeCost`) has no A* equivalent; needs an explicit rule (e.g. open-set ordering by node ID) so same input → same output every time |
| Outer-lane "no free room" fallback | "A* finds no path" is the natural signal. **Recommendation: route to today's existing `edgePathFor` single-edge fallback machinery** rather than re-deriving new fallback geometry — same as today's "no candidate clears" path already does |
| Container-lane clearance (`clearsContainerLanes`, `≤32px` short-crossing exception) | Becomes a **graph-construction-time** decision — "which visibility-graph edges may exist at all near container boundaries" — not a post-hoc check on a finished candidate |
| Port-allocation offset math | `routingPorts`' ordinal-based x/y jitter is bespoke to the old algorithm's coordinate space; needs fresh, tested implementation |
| `CROSSING_PENALTY` value + lane count | Round-2 used arbitrary untuned `50` and a hand-picked 2-lanes-per-side; neither is claimed production-ready |

**E. `OVERSIZED_THRESHOLDS` re-derived from the NEW algorithm's real measurement**
(`src/webviewProtocol.ts:16-27`.) Derived from the **implemented** router's
measured ≤10s boundary — **not** the spike's numbers, which excluded bend-count
tie-break, port allocation, self-loops, container-lane and outer-lane handling.
Unlike the falsified D1-D3 approach (which could not get `{300,600}` within
*minutes* of budget), this approach is expected to **recover to or exceed today's
`{300,600}`** — round 2 measured `{300,600}` at 241ms against a baseline that did
not complete in 590s+, and `{1000,2000}` at 2.76s. This must be **measured, not
assumed**.

**F. Scoped drag-drop re-routing — still in scope, with an open design question**
`onNodeDragStop` (`webview/index.tsx` ~479) re-routes only the moved node's edges
plus its cascaded descendants. **Design-phase question, not resolved here: is the
scoped-reroute complexity still warranted?** If the full coordinated pass becomes
fast enough that even a complete re-route fits comfortably inside the 500ms
drag-commit budget, the scoped path may be unnecessary complexity carried for no
gain. `sdd-design` must answer this with the new router's measured numbers.

**G. Rewritten property-based test suite**
Every property from `exploration-v2.md`'s "true properties" list must hold and be
re-verified with **new** tests against the new algorithm: orthogonal-only
segments, no crossings on the tested fixtures, obstacle/label/container clearance
with real margin, port allocation (distinct anchors + distinct lanes),
determinism/reproducibility, self-loops rendering outside their own box,
container-to-child edges above descendants, outer-lane fallback, unresolved-edge
fallback unchanged.

### Out of Scope
- **Byte-identical output preservation vs. today's router** — explicitly abandoned
  by the third pivot. A genuinely different algorithm produces different but
  equally-valid routes. Determinism means *reproducibility* (same input → same
  output), **not** matching any prior algorithm's `d` strings.
- **The D1-D3 incremental spatial-indexing design** — superseded by real
  measurement; `design.md` is retained only as a historical falsification record.
- Degrading routing quality above a cap (exploration option B).
- `call`/`instantiate` edge-kind split; analyzer id-instability
  (`route-container-empty`). Unrelated pre-existing items, still deferred.

## Measured Baseline (real, not extrapolated)

| nodes | edges | `layoutGraph` ms |
|---|---|---|
| 60 | 120 | 770 |
| 80 | 160 | 3,938 |
| 90 | 180 | 5,584 |
| 100 | 200 | 7,729 |
| 120 | 240 | 13,093 |
| 150 | 300 | 27,035 |

Confirms ≈cubic growth (150/300 is 2.5× the node count of 60/120, but ~35× the time). Without the algorithmic fix, the ≤10s budget only reaches ~90-100 nodes — far below today's `{300,600}`. This is the concrete evidence behind the scope pivot above.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `change-map-visualization`: oversized-gate threshold values (Requirement "Preserve filtering, popup, navigation, and gates under React Flow", which names `{300,600}`) and drag-commit re-route scope (Requirement "Drag a node to reposition it", plus the container-descendant requirement).

## Approach

**Switch algorithm classes, do not optimize the existing one.** Replace the
coordinated multi-edge pass (`edgePathsFor` + `routeCost`, `edgeGeometry.ts:601-726`)
with the orthogonal visibility-graph + per-edge A* family used by libavoid
(Wybrow/Marriott/Stuckey, GD 2009) and ELK:

1. **Build one shared visibility graph per pass** — obstacle-box corners grown by
   `ROUTE_CLEARANCE`/`LANE_GAP`, label corners, port anchors; horizontal/vertical
   visibility segments clipped at obstacles; multiple lane offsets per obstacle
   side so adjacent lanes exist to nudge into.
2. **Route each edge independently by A\*** over that one shared graph —
   Manhattan heuristic, bend-count secondary cost, real priority queue, explicit
   deterministic tie-break.
3. **Crossing/lane discipline via the per-segment occupancy index** — `O(1)`
   owner-count lookup folded into A*'s relaxation cost, never an `O(E)` rescan.
4. **Self-loops, unresolved-edge stubs, and outer-lane fallback stay as
   special-cased pre/post steps** around the graph search, matching today's
   structure.

**This rewrite replaces the COORDINATED multi-edge pass only, not the whole
module.** `test/unit/edgeGeometry.test.ts`'s golden tests for the single-edge
fallback (`edgePathFor`, unresolved-edge stub rendering) stay **UNTOUCHED and must
stay green with zero edits** — they are byte-identical goldens over a code path
this change does not replace, and `edgePathFor` remains the recommended fallback
target when A* finds no path.

**Evidence base** (real Bash-measured, see `apply-progress.md` Addenda 1-2):

| nodes/edges | today's router | spike, no crossing-avoid. | spike, WITH crossing-avoid. | speedup |
|---|---|---|---|---|
| 60/120 | 782ms | 8.7ms | 16.7ms | **46.8x** |
| 150/300 | 27,287ms | 15.3ms | 67.9ms | **402x** |
| 200/400 | 68,065ms | 25.5ms | 105.5ms | **645x** |
| 300/600 | did not finish in 590s+ | 50.6ms | 241.4ms | **>2,444x** |

The speedup **widens monotonically** with N (`46.8x → 284x → 402x → 645x →
>2,444x`) — the signature of a complexity-class fix, and the exact opposite of the
rejected D1 spike's flat 1.3-1.6x. Cost of correctness (adding crossing-avoidance
back) is a bounded **~1.9-4.9x**, single-digit multiplier, same order of magnitude.

**Spec budgets are unchanged and remain valid** — they are algorithm-agnostic
(`<2000ms` at the `NESTED_LAYOUT_LIMITS` boundary, `≤10000ms` at the
`OVERSIZED_THRESHOLDS` boundary, `<500ms` drag-commit scoped reroute). The
difference is what is now *achievable* against them: the D1-D3 approach could not
get `{300,600}` within minutes of the 10s budget and forced a threshold cut toward
`{90,180}`; this approach is expected to **recover to or exceed `{300,600}`** —
the headline upside of the pivot.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `webview/visibilityGraph.ts` | **New** | Shared visibility-graph construction + occupancy index |
| `webview/edgeGeometry.ts` (686 lines) | **Modified (major)** | `edgePathsFor`/`routeCost` coordinated pass replaced by A* over the shared graph; `edgePathFor` single-edge path preserved as fallback |
| `src/webviewProtocol.ts` | Modified | Re-derived `OVERSIZED_THRESHOLDS` values |
| `webview/graphLayout.ts` | Modified | Routing entry point; scoped re-route hook (pending design question F) |
| `webview/index.tsx` | Modified | `onNodeDragStop` routing path (pending design question F) |
| `test/unit/coordinatedRouting.test.ts` (250 lines) | **Rewritten** | Property-based suite for the new algorithm |
| `test/unit/edgeGeometry.test.ts` (615 lines) | **UNTOUCHED** | Single-edge fallback goldens must stay green with zero edits |
| `test/unit/graphLayout.test.ts` (518 lines) | Modified | Refreshed perf probe at the new boundary |
| `openspec/specs/change-map-visualization/spec.md` | Modified | Delta via `sdd-spec` (budgets unchanged; threshold values re-derived) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Estimate under-forecasts again** — every prior estimate in this change was wrong (design.md's D1-D3 op-count was off by 3-4 orders of magnitude; the repo's simpler prior changes also under-forecast) | **High** | `sdd-design` MUST produce a Review Workload Forecast validated against **actual file sizes**, and may need its OWN measurement pass before committing numbers (see below) |
| Hand-tuned edge cases in the 686-line module silently regress | **High** | Those constants live in the OLD algorithm's coordinate space and do NOT transfer automatically; each must be **explicitly re-solved** (Scope D), with the property suite (Scope G) as the gate |
| Spike numbers don't survive the unpriced features (bend-count tie-break, port allocation, self-loops, container-lane, outer-lane) | Med-High | Thresholds derived from the **implemented** router only (Scope E); spike numbers are never shipped as the answer |
| Single-column `flatGraph` fixture is a favorable case (X-axis collapses to 2 coords) | Med | Re-measure against real/varied-X layouts before fixing threshold values |
| `CROSSING_PENALTY`/lane count untuned; occupancy is a nudge, not a hard block | Med | Explicit design-phase tuning strategy; congestion metrics (max-owners, excess-weight) as the acceptance signal, not binary shared-segment counts |
| End-to-end freeze (React Flow reconcile + SMIL particles) still unmeasured in every round of this change | Med | Measure end-to-end, not only `layoutGraph`, before fixing thresholds |
| Scoped re-route complexity may be dead weight | Low | Design question F resolves it one way or the other with measured justification |

### Review Workload Forecast — provisional, NOT the final number

Honest, non-lowballed framing: this is a **genuinely large rewrite of a 686-line
module's core algorithm**, plus one new module, plus a rewritten 250-line test
suite. It will **very likely exceed the 400-line review budget by a wide margin**
and require chained/stacked PR slices.

`400-line budget risk: High` (provisional — `sdd-tasks` owns the binding forecast).

Two hard requirements before `sdd-tasks`:
1. **`sdd-design` MUST produce a real Review Workload Forecast validated against
   actual file sizes**, not an intuition.
2. **`sdd-design` may itself need a measurement/validation pass** — a more
   complete prototype covering the currently-unpriced features (bend-count
   tie-break, port allocation, self-loops, container-lane, outer-lane fallback)
   before committing to final numbers. This change has already needed **two rounds
   of real measurement** to avoid over-trusting a design's own estimate; the scope
   is now larger, not smaller, so there is no reason to expect that pattern to stop.

## Rollback Plan

The new router lands behind a clean seam: `edgePathsFor`'s signature is preserved,
so reverting is deleting `webview/visibilityGraph.ts` and restoring the previous
`edgePathsFor`/`routeCost` bodies plus the `{300,600}` constant in
`src/webviewProtocol.ts`. `edgePathFor` and its goldens are never removed, only
reused, so the single-edge fallback path survives any revert. No persisted data
and no protocol shape changes, so no migration.

## Dependencies

- `sdd-design` must resolve the five open design decisions in Scope D and the
  scoped-reroute question in Scope F before `sdd-tasks`.
- Threshold values depend on measuring the **implemented** router, so they are an
  apply-time outcome, not a design-time choice.

## Success Criteria

- [ ] New router passes a **rewritten** `test/unit/coordinatedRouting.test.ts`
      covering the same **PROPERTIES** (orthogonality, no crossings on tested
      fixtures, clearance, port allocation, determinism, self-loops, container
      layering, outer-lane fallback) — **not** byte-identical paths.
- [ ] `test/unit/edgeGeometry.test.ts` green with **zero edits**.
- [ ] A **real measured** `OVERSIZED_THRESHOLDS` boundary that satisfies the
      ≤10000ms spec budget, recorded in the change folder and **explicitly
      compared against today's `{300,600}`**.
- [ ] `NESTED_LAYOUT_LIMITS` `{60,120}` boundary measured `<2000ms`.
- [ ] The drag-commit scoped-reroute question (Scope F) is **resolved one way or
      the other with measured justification** — either implemented within the
      500ms budget, or explicitly dropped because the full pass already fits.
- [ ] Each of Scope D's five design decisions has an explicit, documented
      resolution and test coverage.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e` all green.

## Proposal question round — RESOLVED

Decisions taken with the user, binding for `sdd-spec`/`sdd-design`:

1. **Time budget**: `NESTED_LAYOUT_LIMITS` `{60,120}` boundary MUST render in **&lt;2s**. The revised `OVERSIZED_THRESHOLDS` boundary MUST render in **≤10s**. A drag-drop commit's scoped re-route MUST complete in **&lt;500ms**. All three deliberately more lax than the exploration's own suggestion (sub-second / ≤3-5s / sub-200ms) — the user's explicit choice, not a compromise to revisit later.
2. **Threshold independence**: `OVERSIZED_THRESHOLDS` and `NESTED_LAYOUT_LIMITS` stay **independent**. `NESTED_LAYOUT_LIMITS` (`{60,120}`) is NOT touched by this change — it governs layout *shape* (nested vs. flat), not render *cost*, and is out of scope here.
3. **Gate type**: the oversized gate stays a **confirmation** ("render anyway"), not a hard refusal — unchanged from today. This licenses a less conservative new threshold, since the user always retains the option to proceed and wait up to the 10s ceiling.
4. **Scoped-reroute fallback**: if the drag-commit scoped re-route cannot find a clear candidate for an edge, it MUST fall back to the full coordinated pass (correct, occasionally slower) rather than tolerate a temporary crossing. Consistent with never silently degrading correctness — the &lt;500ms budget is the target, not an absolute guarantee, on the rare fallback path.

## Proposal question round (third pivot) — no new product decision found

Deliberately **not** opening a new round. The four decisions above (time budgets,
threshold independence, gate-as-confirmation, fallback-to-full-reroute) remain
binding and do not need re-litigating, and the third pivot's own product decision
— abandoning byte-identical output in exchange for a real complexity-class fix —
was already taken by the user when this direction was confirmed.

Everything still open (A* tie-break rule, container-lane graph-construction
encoding, port-offset math, `CROSSING_PENALTY`/lane-count tuning, whether the
scoped drag-reroute is still needed) is **engineering design work for
`sdd-design`**, not a product tradeoff requiring user input. Inventing a question
round here would be ceremony, not clarification.

## Proposal assumptions (current)

- The coordinated multi-edge pass is fully rewritten; the single-edge `edgePathFor`
  path and its byte-identical goldens are preserved untouched and reused as the
  A*-failure fallback.
- Routes will legitimately **differ** from today's output. Determinism means
  reproducibility, not output-matching.
- `OVERSIZED_THRESHOLDS` numbers come from measuring the implemented router, and
  are expected — but not assumed — to recover to or exceed `{300,600}`.
- The full coordinated pass stays the authority for host graph messages and filter
  changes; only the drag-drop commit path may be scoped (pending Scope F).
