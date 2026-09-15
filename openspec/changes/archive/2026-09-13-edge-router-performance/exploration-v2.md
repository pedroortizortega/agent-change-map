# Exploration v2: `edge-router-performance` — genuine algorithmic redesign

**Status**: partial (research complete; real prototype measurement still pending — see orchestrator follow-up below)

## Tooling Note

This exploration session had no Bash access, so the mandatory prototype-and-measure step could not run here. All complexity numbers below are reasoned (op-counting), not measured — exactly the failure mode that caused the second pivot in this change (design.md's op-count estimate for D1+D2+D3 was off from real measurement by 3-4 orders of magnitude). The orchestrator is running a follow-up spike with real Bash access before any proposal commitment (see bottom of this file).

## Current State

`edgePathsFor` (`webview/edgeGeometry.ts:633-726`) is a single monolithic function that, per edge, in span-sorted order: builds a fresh O(N+E) candidate grid, enumerates up to `16 × (2+|xs|+|ys|)` candidate polylines, and scores each via `routeCost` (`edgeGeometry.ts:601-625`), which does a nested loop over every segment of every previously-routed edge (`occupied`). That inner loop is the dominant term the just-falsified D1 spike targeted; `apply-progress.md` proved a spatial index over it alone yields a flat ~1.3-1.6x speedup with no improving trend as N grows — i.e. a constant-factor win, not a complexity-order change, because T2 (obstacle/label scan) and T3 (candidate-grid growth) are structurally the same "rescan everything per candidate" shape and remain untouched.

## True Properties vs. Implementation Details

Reading `test/unit/coordinatedRouting.test.ts` and `test/unit/edgeGeometry.test.ts` end-to-end, the true requirements a replacement algorithm must satisfy:

- **Orthogonal-only segments** — every route is axis-aligned.
- **No crossings between any two routed edges** on the tested fixtures. Note: `edgePathsFor`'s own doc comment already says "This is a deterministic heuristic, not a planarity guarantee" — today's algorithm strongly discourages crossings via a +1000 cost penalty, it does not formally prove zero crossings exist in general. A replacement does not need to out-prove today's algorithm, only keep passing the same fixtures.
- **Full obstacle/label/container clearance with a real margin** (`ROUTE_CLEARANCE`, `LANE_GAP`).
- **Port allocation**: multiple edges touching the same box get visually distinct anchor points and distinct vertical lanes.
- **Determinism**: identical input → byte-identical output on repeated calls — this is about *reproducibility*, not matching any specific prior algorithm's output byte-for-byte. This is the biggest thing the second scope pivot reopens: the D1-D3 design's contract required byte-identical output vs. today's router, which is what made incremental optimization so hard. Non-identical output is now acceptable as long as it's self-consistent and correct.
- **Self-loops** render as a visible loop outside their own box.
- **Unresolved edges** fall back to `edgePathFor`'s dashed-stub/no-render behavior with its own byte-identical golden tests, untouched by any coordinated-routing redesign.
- **Container-to-child edges stay above descendants**; ancestor header/label bands stay protected.
- **Outer-lane fallback**: when local detour room doesn't exist, route via a shared outer vertical lane instead of failing.

Implementation details that are NOT requirements and can legitimately change: exact candidate-grid enumeration shape, exact `routeCost` cost weights and tie-break-by-iteration-order, exact `xs`/`ys` band construction, and — per the second pivot — the exact `d` string produced for any given edge, as long as the properties above hold.

## Research: Production Prior Art

The well-studied production answer to "avoid O(edges²)-pairwise-crossing routing" is the **orthogonal visibility-graph + shortest-path-search** family:

- **libavoid** (Wybrow/Marriott/Stuckey, "Orthogonal Connector Routing" GD 2009; used in Dunnart) builds one shared orthogonal visibility graph per pass from obstacle-box corners (nodes = corner points + port anchors; edges = horizontal/vertical visibility segments, cut wherever an obstacle blocks line-of-sight). Construction is roughly O(n log n) via a sweep-line, done ONCE per pass, not per edge. Each connector is then routed independently by an A*/shortest-path search over that one shared graph, minimizing a bend+length cost — an edge's routing cost is a function of the (fixed) obstacle graph's size, never of how many other edges have already been routed. This directly kills the O(occupied)/O(E) term that dominates today's `routeCost`.
- **Crossing avoidance without pairwise checks**: libavoid doesn't add a crossing-penalty cost term at all. Connectors sharing the same graph segment get their relative order fixed once via a per-segment nudging pass, not an O(E) rescan per candidate. This is analogous to this repo's own `OccupancyIndex` concept (already built for the D1 spike!) — but used as A*'s neighbor-cost function, not an O(E) rescan.
- ELK's and yFiles' orthogonal routers describe the same shape.

This matches Approach A ("grid-based/visibility-graph routing") from the exploration brief's own suggested list — real, published, production-proven prior art, not a novel invention.

## Candidate Approach (recommended, pending real measurement)

**Visibility-graph + per-edge A\*, reusing the already-built D1 index infrastructure as the crossing bookkeeping layer.**

1. Build one shared visibility graph per `edgePathsFor` pass: nodes = box corners (±clearance) + label corners + port anchors; edges = horizontal/vertical visibility segments, clipped at obstacles. Replaces T2's per-candidate obstacle rescan (nodes only connect where clear by construction) and T3's per-edge candidate-grid rebuild (grid built once, not per edge).
2. Per edge, route via A* (Manhattan heuristic, bend-count as tie-break) over that shared graph — roughly O(V log V) on the shared graph, independent of E.
3. Crossing/lane discipline reuses the already-designed `OccupancyIndex`/`RectIndex` from the D1 spike — not as a candidate-cost accumulator, but as the per-segment "who's here already" lookup A* consults to nudge a new route into an adjacent lane. That spike work is not wasted; it was built for the wrong host algorithm and is close to directly reusable here.
4. Self-loops, missing-target stubs, and outer-lane fallback stay as special-cased pre/post steps around the graph search, matching today's structure.

**Complexity, reasoned not measured**: today's shape is O(E·(N+E)²) ≈ O(N³) for E≈2N (confirmed cubic by the real measured curve). The visibility-graph approach's shape is O(N log N) graph build (once per pass) + O(E · V log V) for E A* searches, where V (shared graph size) is bounded by O(N), not E. That gives roughly O(E·N log N) ≈ O(N² log N) for E≈2N — a genuine reduction in complexity CLASS, not a constant-factor speedup like D1. Rough arithmetic at {300,600}: E·N·log₂N ≈ 600×300×8.2 ≈ 1.5M steps vs. today's E·(N+E)² ≈ 600×810,000 ≈ 486M — roughly 300x fewer core operations. Unlike D1's flat 1.3-1.6x speedup (no widening trend with N — the tell of a constant-factor fix), this candidate's speedup ratio should WIDEN as N grows if the reasoning holds. That widening trend is exactly what a real timing run must check.

## Alternatives Considered

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| A. Visibility-graph + A* (recommended) | Real production prior art; genuine asymptotic reduction; reuses D1's index work | Full rewrite of the coordinated pass; output legitimately differs from today's (accepted by 2nd pivot); crossing-avoidance is a different mental model, needs new tests | High |
| B. Sweep-line/channel-based routing | Also avoids pairwise comparison by construction; simpler mental model | Less mature prior art for orthogonal obstacle-avoiding routing specifically; container/label irregularity here needs nearly as much special-casing as today | High |
| C. Two-phase (fast-path + coordinated-only-for-conflicts) | Could ship incrementally; if most edges have zero real conflict, majority pay only O(N) cost | Unverified what fraction of a realistic graph's edges actually conflict; conflict-detection itself needs to be at least as sound as A*'s graph anyway — may not be a genuinely separate approach from A with an early-exit | Medium |
| D. Accept approximate/heuristic quality (rare crossings tolerated) | Simpler/faster heuristics possible | Directly conflicts with the tested no-crossing property on real fixtures; renegotiates the correctness contract, not just speed — bigger ask than "faster algorithm" | Low-Medium, high product risk |

## Maintenance/Risk Survey

A full redesign is materially bigger/riskier than the rejected incremental D1-D3 design:

- **Tie-breaking has no direct A\* analogue**: `routeCost`'s exact strict-`<` first-wins tie-break must be explicitly re-decided (e.g. deterministic tie-break by node ID ordering in A*'s open-set), not carried over — the 2nd pivot accepts non-identical output but still needs its OWN new determinism story (same input → same output, every time).
- **Outer-lane fallback's "is there any free room" check** has no direct A* analogue — "search finds no path" is the natural signal, but the existing fallback's hand-tuned side-anchor/escape-Y logic would need to be re-derived or kept as a post-A*-failure fallback (pragmatic choice: keep `edgePathFor`'s single-edge fallback machinery entirely, route to it when A* fails, same as today's "no candidate clears" fallback already does).
- **Container-lane clearance** (`clearsContainerLanes`, the ≤32px short-crossing exception) is subtle and empirically-tuned with real regression coverage — a visibility-graph implementation needs to encode this as "which graph edges are allowed to exist at all near container boundaries," a new design decision, not a port.
- **Port allocation offset math** (`routingPorts`'s ordinal-based x/y jitter) is bespoke and needs fresh, tested implementation.
- 686 lines with unusually dense doc comments recording hard-won edge-case fixes (real reported visual bugs behind some constants). A ground-up swap risks silently regressing several unless every existing test in both files stays green with zero edits — a harder bar for a structurally different algorithm than for an index-substitution one, since the failure modes it guards against were each fixed by hand-tuned constants in the CURRENT algorithm's coordinate space, not derived from first principles that transfer automatically.

## Change-Name Decision

Keep `edge-router-performance` — this is the third pivot within the same problem (root cause: `edgePathsFor`'s scaling), not a new problem. Continuity preserves the full falsification history (D1 measured and rejected, D1+D2+D3 estimated-and-rejected) any future phase needs to avoid repeating the estimate-vs-measurement mistake a third time.

## Risks

- **Primary**: no real prototype was run in this exploration pass (no Bash) — the orchestrator is closing this gap with a direct follow-up spike (see below) before any proposal commitment.
- A visibility-graph rewrite is a full replacement of `edgePathsFor`'s internals, not an incremental patch — higher blast radius on the 686-line module's hand-tuned edge cases than the already-rejected D1-D3 design.
- Determinism/tie-breaking needs an explicit new specification (A* doesn't naturally reproduce `routeCost`'s "first-generated-candidate wins" rule).
- End-to-end freeze (React Flow reconcile + SMIL particles) remains unmeasured in every round of this change so far.

## Ready for Proposal

Not yet. Orchestrator is running a real Bash-capable spike of the visibility-graph+A* candidate against the same synthetic sizes ({60,120} through {300,600}+), specifically checking whether the speedup ratio WIDENS with N (the signal distinguishing a real complexity-order fix from another D1-shaped disappointment). Only after that real number exists should `sdd-propose` commit to this approach's scope.
