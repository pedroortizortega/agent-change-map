# Design: Edge Router Performance (visibility-graph + A\*)

> Supersedes the D1-D3 incremental spatial-indexing design entirely (falsified by
> `apply-progress.md` Phase 0). This is a different algorithm, not a refinement.

## Execution constraint — READ FIRST

**This design phase ran WITHOUT Bash access.** Tooling exposed to the `sdd-design`
executor was Read/Edit/Write/Grep/Glob only. The phase brief required a fresh
measurement spike for Block F (scoped-reroute go/no-go) and for the
`OVERSIZED_THRESHOLDS` derivation. **That spike was NOT run, and no new number in
this document is a measurement.**

Everything below is one of three clearly labelled classes:

- **[MEASURED]** — a real number from `apply-progress.md` Addenda 1-2, or a real
  file fact from this repo read directly.
- **[PROJECTED]** — arithmetic on top of measured numbers. Explicitly the failure
  mode that burned this change twice. Treat as a hypothesis with a decision rule.
- **[DECIDED]** — a design choice that needs no measurement.

The five Block-D decisions are **[DECIDED]** and complete. Block F and
`OVERSIZED_THRESHOLDS` are **[PROJECTED] with binding decision rules** that
`sdd-apply` MUST resolve by measurement before landing the constant. Do not let
the projection stand in for the measurement — that is the exact mistake of rounds
1 and 2.

## Technical Approach

Replace only the coordinated pass. One shared orthogonal lane graph per
`edgePathsFor` call; each edge routed independently by A\* over it; crossing
discipline by an `O(1)` per-graph-edge occupancy lookup folded into relaxation.
Everything at or above `edgeGeometry.ts:550` (`edgePathFor`, `routeWaypoints`,
`outerLaneEdgePath`, `roundedPolylinePath`, `obstaclesFor`, anchors, `clipSegment`)
is **untouched** and reused.

## Architecture Decisions

### D-1 — A\* deterministic tie-break  [DECIDED]

**Choice**: integer-only cost arithmetic + a **strict total order** on the
priority-queue comparator, plus a deterministic parent-selection rule.

```ts
// node ids: lanes are sorted ascending and deduped, so id = xi * ys.length + yi
// is a pure function of the geometry. Search state key = nodeId * 4 + dirIndex
// (dirIndex ∈ {N,E,S,W}) — needed anyway for bend counting.
compare(a, b) = a.f - b.f || a.h - b.h || a.bends - b.bends || a.stateKey - b.stateKey
// relax: accept iff  ng < g[s]  ||  (ng === g[s] && (nBends, parentStateKey) <lex current)
```

- All lane coordinates are `Math.round`ed integers; `BEND_COST`, penalties and
  Manhattan length are integers ⇒ costs are **exact integers**, no float
  associativity drift, `===` comparisons are safe.
- `stateKey` is unique, so the comparator is a total order ⇒ pop order is a pure
  function of the inserted set, independent of heap array layout or sift
  implementation. The `h` tiebreak (prefer larger `h`… i.e. smaller remaining
  first via `a.h - b.h` ascending → prefer *closer to goal*) is a performance
  choice; correctness of determinism rests on `stateKey` alone.
- Parent pointers are also totally ordered, so path reconstruction is unique.

**Alternatives rejected**: FIFO insertion-order tiebreak (depends on neighbour
enumeration order — silently breaks under refactor); no tiebreak (nondeterministic
under any heap); reproducing `routeCost`'s strict-`<` first-candidate-wins (no A\*
analogue — there is no candidate enumeration to be "first" in).

**Guarantee**: same `boxes` + same `edges` ⇒ same lane set ⇒ same node ids ⇒ same
pop order ⇒ same paths, every run, on any engine.

### D-2 — Outer-lane / no-path fallback  [DECIDED]

**Choice**: confirmed as proposed. `routeOne()` returns `undefined` when the open
set empties (or when `simplifyRoute` rejects the polyline as a reversal); the
caller then executes **today's existing line**:

```ts
if (!route) { paths[index] = edgePathFor(boxes, edge.source, edge.target); continue; }
```

That is `edgeGeometry.ts:718` unchanged. `edgePathFor` already contains
`needsOuterLaneFallback` → `outerLaneEdgePath` → `escapeSafeY`. **Zero new
fallback geometry is authored.** Fallback paths are NOT inserted into the
occupancy index — matching today, where the `continue` skips `occupied.push`.

**Alternatives rejected**: re-deriving outer-lane geometry over the lane graph
(re-solves a solved, golden-tested problem); adding outer lanes as extra graph
columns (Addendum 2 showed lane-count is the dominant grid-size cost — spending it
on a rare fallback is backwards).

### D-3 — Container-lane clearance as a graph-construction rule  [DECIDED]

Today's `clearsContainerLanes` is a post-hoc, **per-edge** check (the `containers`
set is the ancestors of *this* edge's endpoints), with two asymmetric rules. It is
split into two mechanisms:

**(a) Horizontal band omission — global, hard, free.** When sampling Y lane
coordinates, **never emit a `y` with `0 ≤ dist(y, containerTop|containerBottom) <
LANE_GAP`**. Lane lines are emitted only at `boundary ± LANE_GAP·k`, `k ∈ 1..L`.
Consequence: a horizontal run can never sit inside a container's forbidden band at
all, so today's `overlap ≤ 32 || dist ≥ LANE_GAP` clause is satisfied
*structurally* for horizontals. The only way to enter the band is a **vertical
crossing**, whose in-band length is `< LANE_GAP = 12 < 32` — i.e. the `≤32px`
short-crossing exception becomes a geometric consequence of the lane pitch, not a
runtime check. This is the whole point of moving the rule to construction time.

**(b) Vertical long-transit — per-graph-edge tag + `O(1)` admission predicate.**
Today's vertical rule is stronger (no long vertical run anywhere within
`[box.x - LANE_GAP, box.x + box.w + LANE_GAP]`), and it is edge-dependent, so it
cannot be a deletion — children inside the container need those columns. Encode:

```ts
// build time, once per pass
vEdge.containerTags: Uint32Array /* container indices whose x-band contains this column */
// relax time, O(#tags) with #tags ≤ nesting depth (≤ 4 in this repo's layouts)
admissible(vEdge) = vEdge.containerTags.every(c =>
  !edgeAncestors.has(c) || withinEndpointWindow(vEdge, portYWindow));
```
`portYWindow = [min(sourcePortY, targetPortY) - LANE_GAP, max(...) + LANE_GAP]`.
This is literally the code comment's stated intent — *"Ancestors permit short
endpoint crossings, not long transit through their gutters"* — expressed as an
admission predicate instead of a whole-route rescan. Cost: `O(depth)` per
relaxation, no extra A\* state, no resource-constrained-shortest-path machinery.

**Alternatives rejected**: carrying an accumulated in-band run length as a second
resource in the search state (correct but turns A\* into a 2-resource RCSP with
dominance checks — large complexity for a rule the lane pitch can enforce);
building a separate graph per edge (defeats the entire "one shared graph" premise).

### D-4 — Port allocation offset math  [DECIDED]

Fresh scheme; today's `routingPorts` ordinal jitter is deleted.

```ts
const L = LANE_COUNT;                       // see D-5
const pitch = Math.max(4, Math.min(LANE_GAP, Math.floor(usable / (n + 1))));
const off   = Math.round((i - (n - 1) / 2) * pitch);   // i = slot, n = degree
// top/bottom: x = clamp(cx + off, b.x + 8, b.x + b.w - 8)
// left/right: y = clamp(b.y + 16 + off, b.y + 8, b.y + b.h - 8)
// escape lane index k = i % L  ⇒ escape sits on lane line (boundary ± LANE_GAP·(k+1))
```
All four sides are still offered as A\* start/goal candidates (as today), so the
search still picks the cheapest side; only the *offsets* are new.
Inward variant (one endpoint contains the other) keeps today's `box.y + 26`
below-title anchors, with `+ i·LANE_GAP` clamped inside the box.

**The important structural change**: lane index is assigned explicitly as `i % L`,
so "edges from the same box get distinct vertical lanes" becomes a **construction
guarantee** for `n ≤ L`, not an emergent property of cost competition (which is
how today's `coordinatedRouting.test.ts:64-65` gets it, fragilely). Anchor
distinctness holds while `n ≤ usable/1`; above that the clamp collides and only
lane distinctness survives — documented, and the property test asserts
distinctness for `n ≤ 8`.

### D-5 — `CROSSING_PENALTY` and lane count  [DECIDED value, MUST be swept]

**Penalty — calibrated against lane geometry, not picked.** With occupancy `o` on
the graph edge being relaxed:

```ts
penalty(o) = o === 0 ? 0 : CROSSING_BASE + (o - 1) * CROSSING_STEP;
CROSSING_BASE = 60;  CROSSING_STEP = 60;  BEND_COST = 16;  // BEND_COST kept from routeCost
```
Rationale: detouring to an adjacent empty lane and back costs `2 · LANE_GAP = 24`
px of length plus 2 bends = `32` ⇒ ≈`56` cost units. `CROSSING_BASE = 60` makes
"use the empty adjacent lane" strictly cheaper than "share", while capping the
justified detour at ≈1 lane for a first share and ≈5 lanes for a 4-owner segment.
It is expressed in the same px-based cost space as `BEND_COST` and Manhattan
length, so unlike the geometry constants it *does* transfer. That it lands near
the spike's arbitrary `50` is a sanity check, not the derivation.
Today's `1000` is deliberately **not** reused: at 1000 the penalty is a hard block
in all but pathological cases, which contradicts the measured Addendum-2 finding
that the mechanism's value is *redistribution* (max-owners 144→37) rather than
exclusivity.

**Lane count `L = 3`** at offsets `LANE_GAP·{1,2,3}` = 12/24/36px per obstacle
side. Addendum 2 proved `L = 1` is a structural no-op; `L = 2` worked but was
hand-picked. `L = 3` is chosen so that `i % L` gives the 3 distinct lanes the
existing port-distinctness test needs, by construction.
**`L` is the dominant performance knob** — grid area is `O(|X|·|Y|)` and both
scale linearly in `L`. Addendum 2's 1→2 lane widening is part of why its numbers
are 1.9-4.9x Addendum 1's. `L = 2` is the designated fallback if measurement shows
the budget threatened.

**Binding tuning protocol for apply** (acceptance signal = max-owners +
total-excess-weight, NOT the misleading binary shared-segment count):
sweep `CROSSING_BASE ∈ {0, 30, 60, 120, 240, 1000}` × `L ∈ {2, 3}` over (i) the
real-analyzer fixture already embedded at `coordinatedRouting.test.ts:115-153`
and (ii) `flatGraph` at `{60,120}` and the candidate threshold; record max-owners,
excess weight, total length, bend count, ms; pick the knee. Record the table in
`apply-progress.md`.

## Block F — is the scoped drag-drop re-route still needed?

**Recommendation: KEEP it. [PROJECTED — must be confirmed by measurement in apply]**

Three independent reasons, one of which is not a measurement question at all:

1. **The delta spec already mandates it.** `specs/change-map-visualization/spec.md`
   states *"Committing the drag (pointer-up) MUST re-route only the edges attached
   to the moved node … within 500ms"*, with four scenarios, across two
   requirements. Dropping it is a **spec amendment and a product decision**, not a
   design call I can make unilaterally. If measurement later says the full pass
   fits, the orchestrator must take the amendment to the user.

2. **The 500ms budget is against the whole commit path, not just routing.**
   `webview/index.tsx:465-482` shows `onNodeDragStop` today does
   `setOverrideSeq(+1)` → full `layoutGraph` → `buildEdges` → `routedPaths` →
   `edgePathsFor`. So the budget must cover placement too.
   **[MEASURED]** non-routing `layoutGraph` overhead at `{60,120}` =
   `782 − 744 = 38ms` (Phase 0 table). Placement is ~`O(N)`, so
   **[PROJECTED]** ≈`190ms` at `N = 300`, leaving ≈`310ms` for all routing.
   **[MEASURED]** Addendum 2's routing-only cost at `{300,600}` = `241ms` — at
   `L = 2`, with a near-degenerate 2-coordinate X axis, and with bend cost, port
   allocation, self-loops, container tags and the outer-lane fallback all
   unpriced. **[PROJECTED]** `L = 2 → 3` plus a real nested X axis plus the
   unpriced features puts a full re-route in the **~1-3s** band. That is
   comfortably inside 10s and comfortably **outside** 500ms.

3. **It is nearly free to build now.** The scoped path is the *same* `routeOne()`
   over the *same* shared graph; only the occupancy index differs: start from the
   last full pass's index, decrement the cascade's own entries, re-route just those
   edges. That is the Option-C bookkeeping the occupancy index already provides.
   Fallback-to-full-pass on `undefined` is one `if`.

**Binding decision rule for `sdd-apply`** (resolve with real Bash, do not inherit
the projection): measure full `layoutGraph` at the chosen threshold on a
**nested, non-single-column** fixture.
- `≤ 250ms` → drop the scoped path, report to the orchestrator, request the spec
  amendment. Simpler code wins when the data supports it.
- `> 250ms` → implement the scoped path as designed above.
The 250ms bar (not 500) is the margin this change has twice failed to leave.

## `OVERSIZED_THRESHOLDS` derivation  [PROJECTED — apply must measure]

**Recommendation: keep `{nodes: 300, edges: 600}` — i.e. change
`src/webviewProtocol.ts:16-19` by zero lines** — conditional on measurement.

| size | today [MEASURED] | Add.1 spike, no avoidance [MEASURED] | Add.2 spike, with avoidance [MEASURED] | full router [PROJECTED] |
|---|---|---|---|---|
| 60/120 | 782ms | 8.7 | 16.7 | ~60-200ms |
| 150/300 | 27,035ms | 15.3 | 67.9 | ~0.3-0.8s |
| 300/600 | >590,000ms (DNF) | 50.6 | 241.4 | **~1-3s** |
| 500/1000 | not measured | 150.6 | 671.7 | ~3-8s |
| 1000/2000 | not measured | 568.3 | 2,759.5 | ~12-35s (over budget) |

Projection basis, stated so it can be attacked: (a) `L = 2 → 3` widens both lane
axes ⇒ ~1.5-2.25x grid area; (b) a real nested layout has `|X| ≈ depth·2·L ≈ 24`
instead of the flat fixture's 2-4 ⇒ up to ~6x more grid nodes — **this is the
single largest projection risk, and it is exactly the "single-column is a
favourable case" caveat both Addenda flagged and neither retired**; (c) the
unpriced per-edge features (bend cost, 4-side port candidates, container tags,
self-loops) are constant factors, call it 1.5-3x; (d) `+~190ms` placement.
Compounded worst case `≈ 241ms × 2.25 × 6 × 3 + 190ms ≈ 10.0s` — i.e. the
**pessimistic corner of the projection lands exactly ON the budget with zero
margin**. That is why this is not a number to ship unmeasured.

**Answer to "does this recover `{300,600}`?"** Central estimate: yes, with ~3-10x
margin. Pessimistic corner: no margin at all. Compared to the falsified D1-D3
path (which could not reach `{300,600}` within *minutes*), this is a different
universe — but "recovers to `{300,600}`" is a **[PROJECTED]** claim, not the
measured one the proposal's Success Criteria demand.

**Binding derivation rule for `sdd-apply`**: measure the implemented router (not a
spike) on a **nested, varied-X** fixture at `{300,600}`, `{400,800}`, `{500,1000}`.
Set `OVERSIZED_THRESHOLDS` to the largest measured size with **≥2x margin**
(`≤5000ms`), never merely `≤10000ms`. If `{300,600}` measures `>5000ms`, lower the
constant and say so plainly — a measured lower threshold beats a projected higher
one.

## Data Flow

```
layoutGraph → buildEdges → routedPaths ─┐
                                        ├→ edgePathsFor(boxes, edges)
onNodeDragStop (scoped) ────────────────┘        │
                                                 ├ 1. labels + degree counts + port allocation (D-4)
                                                 ├ 2. buildRoutingGraph(boxes)  ← ONCE per pass
                                                 │      lane sampling (D-3a) · clipSegment visibility
                                                 │      · container tags (D-3b)
                                                 ├ 3. for each edge (span-sorted, index tiebreak):
                                                 │      routeOne() = A* (D-1) + occupancy penalty (D-5)
                                                 │        ├ found    → simplifyRoute → occupancy.claim
                                                 │        │            → roundedPolylinePath
                                                 │        └ no path  → edgePathFor  (D-2, UNTOUCHED)
                                                 └ 4. return paths in caller order
```

## File Changes  [line counts below are REAL, read from this repo]

| File | Now | Action | Detail |
|---|---|---|---|
| `webview/routingGraph.ts` | — | **Create ~230** | Lane sampling, node/edge build, container tags, `OccupancyIndex` |
| `webview/routeSearch.ts` | — | **Create ~150** | Binary min-heap, `routeOne()` A\*, cost model |
| `webview/edgeGeometry.ts` | **726** | Modify | Delete `routeCost` (601-625) and `edgePathsFor`'s body (633-726); rewrite `routingPorts` (581-599); **keep `simplifyRoute` and everything ≤ line 579 byte-identical** |
| `webview/graphLayout.ts` | **561** | Modify ~+35 | `routedPaths` takes optional `{ movedIds, previousOccupancy }`; `buildEdges` threads it |
| `webview/index.tsx` | **875** | Modify ~+15 | `onNodeDragStop` passes the D14 cascade ids |
| `src/webviewProtocol.ts` | **85** | Modify 0-2 | Threshold constant — **only if measurement demands it** |
| `test/unit/coordinatedRouting.test.ts` | **263** | **Rewrite ~300** | Property-based (below) |
| `test/unit/routingGraph.test.ts` | — | **Create ~150** | Graph-construction + occupancy units |
| `test/unit/graphLayout.test.ts` | **564** | Modify ~+40/−20 | Perf probe at the new boundary |
| `test/unit/edgeGeometry.test.ts` | **664** | **ZERO EDITS** | Verified below |

> The proposal's own table cites 686 / 250 / 615 / 518 lines for four of these.
> **Every one of those is stale.** Real: 726 / 263 / 664 / 564. Corrected here.

## Interfaces / Contracts

```ts
// webview/routingGraph.ts
export interface RoutingGraph {
  xs: Int32Array; ys: Int32Array;            // sorted, deduped, integer lane lines
  nodeId(xi: number, yi: number): number;    // xi * ys.length + yi  (deterministic)
  neighbours(nodeId: number): readonly GraphEdgeRef[];   // clipped by clipSegment at build time
  containerTagsOf(edgeRef: number): readonly number[];   // D-3b
}
export interface OccupancyIndex {
  owners(edgeRef: number): number;           // O(1)
  claim(path: readonly number[]): void;
  release(path: readonly number[]): void;    // scoped re-route (Block F)
  snapshot(): OccupancyIndex;
}
// webview/routeSearch.ts
export function routeOne(g: RoutingGraph, occ: OccupancyIndex, start: PortSpec,
                         goal: PortSpec, ctx: EdgeContext): Point[] | undefined;
// webview/edgeGeometry.ts — signature UNCHANGED, this is the rollback seam
export function edgePathsFor(boxes: ReadonlyMap<string, Rect>,
                             edges: readonly RoutingEdge[]): (string | undefined)[];
```

## Testing Strategy

`test/unit/edgeGeometry.test.ts` needs **zero edits — verified, not assumed**: its
import list (lines 2-22) is `CORNER_RADIUS, CURVE_MIN_DROP, DETOUR_CLEARANCE,
MAX_DETOURS, ROUTE_CLEARANCE, SIDE_ANCHOR_INSET, STUB_LEN, edgePathFor,
obstaclesFor, pathEndpoints, roundedPolylinePath, routeWaypoints,
segmentIntersectsRect, sourceAnchor, sourceSideAnchor, targetAnchor,
targetSideAnchor`. **`edgePathsFor` does not appear anywhere in that file.** Every
imported symbol lives at or above line 579 and is untouched. The byte-identical
goldens are therefore structurally safe, not merely intended to be.

`coordinatedRouting.test.ts` — rewritten as properties, all byte-identical
assertions removed except the unresolved-stub one (which is `edgePathFor` output
and legitimately stays exact):

| Property | Approach |
|---|---|
| Orthogonal-only | every consecutive pair shares `x` or `y`; no `C` command |
| No crossings | pairwise transversal check over the planar fan fixture (today's lines 44-57, kept) |
| Clearance w/ margin | `segmentIntersectsRect` vs. `ROUTE_CLEARANCE`-inflated unrelated boxes, on the real-analyzer fixture (lines 115-153, kept verbatim — highest-value regression in the file) |
| Port distinctness | `n` duplicate edges ⇒ `n` distinct start anchors, `n` distinct end anchors, `≥min(n,L)` distinct long-vertical lane `x` (now guaranteed by D-4, not emergent) |
| Determinism = reproducibility | `edgePathsFor(b,e)` deep-equals itself; **plus** invariance under shuffling the lane-insertion order and under a heap-implementation swap — the real D-1 guarantee |
| Self-loops | `source === target` ⇒ ≥4 points, none entering own box interior |
| Container lane | today's `ancestor transit clearance` block (lines 200-242) kept **as-is** — it is already a pure property test and is the direct gate on D-3 |
| Label/header bands | today's block (lines 244-263) kept as-is |
| Outer-lane fallback | force `routeOne` failure (degenerate fixture / injected empty graph) ⇒ output equals `edgePathFor(...)` exactly |
| Unresolved stub | `[undefined, "M128,78 L128,106"]` kept exact |
| Randomised sweep | 200 seeded random box/edge sets ⇒ orthogonality + clearance + determinism hold (property testing proper, cheap, catches what fixtures miss) |

New `routingGraph.test.ts`: no lane line lands in a container's forbidden band
(D-3a); container tags match a brute-force reference; `OccupancyIndex`
claim/release round-trips; heap pop order matches a reference sorted list (D-1).

`graphLayout.test.ts`: perf probe kept at `{60,120}` (`<2000ms`) and a second
probe at the measured threshold, on a **nested/varied-X** fixture — the
single-column blind spot is the projection's biggest risk and the test suite
should stop inheriting it.

## Threat Matrix

**N/A** — "routing" here is 2D edge geometry inside a webview, not request
routing. No shell, subprocess, VCS/PR automation, executable-file classification,
or process-integration boundary is touched. No new I/O, no protocol change, no CSP
change. Inputs are numbers already inside the webview's own layout state.

## Migration / Rollout

No migration. No persisted data, no protocol shape change. Rollback = delete the
two new modules and restore `edgePathsFor`/`routeCost`/`routingPorts` bodies;
`edgePathFor` and its goldens are never removed, so the single-edge path survives
any revert. `edgePathsFor`'s signature is the rollback seam and must not change.

## Review Workload Forecast  [validated against REAL file sizes]

Authored `additions + deletions`, from the real counts above:

| Slice | Lines |
|---|---|
| `routingGraph.ts` + `routingGraph.test.ts` | ~380 |
| `routeSearch.ts` + its tests | ~230 |
| `edgeGeometry.ts` rewrite (≈119 deleted + ≈90 added) | ~210 |
| `coordinatedRouting.test.ts` (263 deleted + ~300 added) | ~563 |
| `graphLayout.ts` + `index.tsx` scoped re-route | ~50 |
| `graphLayout.test.ts` perf probe + `webviewProtocol.ts` | ~60 |
| **Total** | **≈1,500-1,900** |

`Decision needed before apply: Yes`
`Chained PRs recommended: Yes`
`400-line budget risk: High`

Blunt assessment, since this change has under-forecast three times: **no single PR
here fits 400 lines, and even the smallest natural slice (`routingGraph.ts` plus
its own tests, ~380) sits at the budget ceiling before review comments.** Five
chained slices, each independently green:

1. `routingGraph.ts` + tests (no production caller yet) — ~380
2. `routeSearch.ts` + tests (no production caller yet) — ~230
3. `edgeGeometry.ts` swap + `coordinatedRouting.test.ts` rewrite — ~770 **← still
   2x over budget and NOT splittable without a red main**, because the algorithm
   swap and its property suite must land together. This slice needs an explicit
   `size:exception` or a further split into "swap + minimal green suite" then
   "full property suite".
4. Scoped drag re-route (`graphLayout.ts`, `index.tsx`, spec-mandated) — ~50
5. Measurement + threshold + perf probe — ~60

Slice 3 is the honest problem. Do not let a tasks phase pretend otherwise.

## Open Questions

- [ ] **BLOCKING for apply**: run the measurement spike this design could not
      (no Bash). Resolve Block F by the 250ms rule and `OVERSIZED_THRESHOLDS` by
      the ≥2x-margin rule.
- [ ] Nested/varied-X grid size is unmeasured in **all three** spike rounds. If
      `|X|` grows beyond ~30, fall back from the full coordinate cross-product
      grid to corner-anchored visibility nodes (libavoid's actual construction).
- [ ] End-to-end cost (React Flow reconcile + SMIL particles) is still unmeasured
      in every round of this change. The 10s budget is spec'd against
      `layoutGraph`, but the user experiences the whole frame.
- [ ] If measurement says the full pass fits in 250ms, the delta spec's scoped
      re-route MUSTs need a user-approved amendment before dropping them.
