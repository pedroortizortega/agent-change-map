# Exploration: `edge-router-performance`

**Status**: complete (static complexity analysis; live timing re-confirmation deferred to the implementing phase — this agent's toolset lacked Bash)

## Current State

`layoutGraph` (`webview/graphLayout.ts:529`) is the single entry point, called from `webview/index.tsx:307-311` inside a `useMemo` keyed on `[state.graph, state.diff, state.untrackedPaths, overrideSeq]`. Three real triggers cause a full re-run:
1. A new `"graph"` message from the host (file save / re-analysis, or a filter-toolbar `requestView()` round-trip).
2. `overrideSeq` bump on `onNodeDragStop` — **every single drag-and-drop commit**, even a one-pixel nudge of one leaf node.
3. Filter changes (`requestView()`, `webview/index.tsx:583-590`) — legitimate, usually shrinks the graph.

Live drag *preview* (mid-gesture) already uses the cheap path: `computeLiveDragUpdate` (`graphLayout.ts:489-526`) calls the single-edge `edgePathFor` (`edgeGeometry.ts:523`) per affected edge — no batch coordination. Note: `design.md` (`2026-09-07-graph-layout-and-interaction`, §4) documents "recomputes over the full edge set... never per-edge" as the drag-preview's own invariant, but the shipped preview code does NOT follow that — it's the drop-*commit* path that does. That design note is stale relative to the (better) shipped behavior, but confirms full-edge-set coordination was a deliberate choice for the authoritative pass.

`NESTED_LAYOUT_LIMITS` (`{nodes:60, edges:120}`, `webview/graphFilters.ts`) gates layout *shape* (containment vs. flat), not routing *cost*. `OVERSIZED_THRESHOLDS` (`{nodes:300, edges:600}`, `src/webviewProtocol.ts:16-27`) gates whether to render at all. Neither currently protects against the other's failure mode, and no documented "diagram must render in ≤Xs" product SLA exists anywhere in `openspec/` or code comments — the only numeric ceiling is the perf-probe test's own `<10s` assertion at `{60,120}`, explicitly labeled a "catastrophic-regression guard, not a tight budget."

## Affected Areas

- `webview/edgeGeometry.ts` — `edgePathsFor` (633-726), `routeCost` (601-625), per-edge candidate-grid construction (689-701). Unchanged since before the React Flow migration.
- `webview/graphLayout.ts` — `routedPaths`/`buildEdges` (238-245, 422-453) invoke `edgePathsFor` once per full `layoutGraph` run.
- `webview/index.tsx` — `useMemo(layoutGraph, [...overrideSeq])` (307-311) and `onNodeDragStop` (~line 479) turn a single-node drag into a full-graph re-route.
- `test/unit/coordinatedRouting.test.ts` — encodes invariants any fix must preserve: no crossings between any two routed edges (44-57), determinism given the full edge array in call order (68-69), and that edge `i`'s port/lane choice depends on `occupied` — lanes already claimed by every **preceding** edge in the same call (explicit comment, 107-109).
- `test/unit/graphLayout.test.ts` (~490-561) — the committed perf probe, capped at `{60,120}` because `{300,600}` hung `npm test` for minutes.
- `openspec/changes/archive/2026-09-12-react-flow-diagram-migration/apply-progress.md:1351-1391` — original measurement + already-sketched follow-up directions.
- `src/webviewProtocol.ts` (`OVERSIZED_THRESHOLDS`), `webview/graphFilters.ts` (`NESTED_LAYOUT_LIMITS`) — both are candidates for adjustment.

## Exact Culprit and Complexity

`edgePathsFor` (`edgeGeometry.ts:633-726`), for each edge `i` (processed in a fixed span-sorted order):

1. **Candidate-grid rebuilt per edge** (689-701): `xs`/`ys` built from every box/label (O(N)) plus one entry per already-routed edge (`for lane <= occupied.length`, O(processed-edges)) → O(N+E) per edge.
2. **Candidate generation**: up to 16 port pairs × `2 + |xs| + |ys|` candidates → O(N+E) candidates per edge.
3. **Per-candidate cost** (`routeCost`, 601-625 + `consider`, 703-708): each candidate checked against obstacles (O(N)), labels (O(N)), container lanes (O(N)), then `routeCost` does a nested loop over **every previously routed edge's segments** (`occupied`, up to size E) — O(E) per candidate. This is the crossing-penalty cost function, and it's the real bottleneck.

Net: candidates (O(N+E)) × cost-per-candidate (O(N) + O(E)) per edge ≈ O((N+E)²); summed over E edges ≈ **O(E·(N+E)²)** — for E≈2N (the flat test fixture's ratio), **≈O(N³)**, cubic. Measured growth is somewhat worse than this floor (cubic predicts ~4.6× at {100,200} vs measured ~9.8×; ~15.6× at {150,300} vs measured ~32×), plausibly because `routeCost`'s early-return optimization helps less as `occupied` grows denser. Qualitative diagnosis (candidate-grid × routeCost's O(occupied) scan) is solid regardless of the exact exponent.

`obstaclesFor`/`routeWaypoints` (the O(N) single-edge fallback) are NOT the bottleneck — those only run in the cheap live-drag-preview path or when no coordinated candidate clears.

## Call-Frequency Finding (orthogonal "call it less" angle)

`layoutGraph` is NOT called on keystrokes or hover (those use separate, cheap className-only `useMemo`s). The real waste: **every drag-drop commit forces a full `edgePathsFor` re-route of the ENTIRE edge set**, at cold-load cost, even when only one leaf node moved. The existing cheap per-edge preview during the drag gesture is thrown away and superseded by the full coordinated pass the instant the drag ends — meaning every drop freezes the UI for multi-second-to-multi-minute cost near the oversized threshold, making the one interactive editing feature (repositioning) unusable exactly where it matters most.

## Approaches

**A. Algorithmic optimization (spatial indexing for `routeCost`)** — Replace the O(occupied) linear scan with spatial buckets/interval trees so a candidate only compares against segments that could plausibly overlap; bound the per-edge candidate grid instead of rebuilding it fully each time.
- Pros: preserves full-graph coordination and tested invariants; fixes root cause once, benefits every call site.
- Cons: highest risk — `routeCost`'s crossing/overlap detection and `clearsContainerLanes`'s exceptions are intricate; must preserve exact tie-breaking/determinism.
- Effort: High.

**B. Cap/degrade routing quality above a new, lower threshold** — Above a new threshold (independent of `NESTED_LAYOUT_LIMITS`), skip the coordinated pass entirely and use the already-tested cheap per-edge `edgePathFor` for the whole graph.
- Pros: reuses proven code, low risk, ships fast.
- Cons: loses crossing-avoidance guarantees above the cap — the reason the coordinated router exists; needs an empirically-chosen new threshold.
- Effort: Low-Medium.

**C. Incrementality for the drag-commit path** — On a single-node/cascade drag-drop, reuse the already-computed `occupied` lane set and only re-route edges touching the moved node(s), instead of the full edge set.
- Pros: directly fixes the highest-frequency trigger in normal interactive use; doesn't touch the coordination algorithm itself.
- Cons: the "full edge set, never per-edge" invariant was a deliberate correctness decision (documented + tested) — a scoped-invalidation rule (e.g. re-route every edge whose bbox overlaps the moved node's old-or-new box) needs new tests proving no crossings are reintroduced.
- Effort: Medium.

**D. Lower `OVERSIZED_THRESHOLDS`/`NESTED_LAYOUT_LIMITS` to numbers the router can handle today** — Simplest fix: shrink the threshold toward the sub-few-second range per measured numbers, defer algorithmic work.
- Pros: trivial, zero algorithmic risk, ships immediately.
- Cons: weakest fix — reduces max usable graph size significantly (real capability regression); doesn't address that even a graph just under the new threshold could take seconds; punts the real question.
- Effort: Low.

## Recommendation

Phased, not single-option: ship **D** immediately as a stop-gap (lower `OVERSIZED_THRESHOLDS` to a value backed by a fresh measurement, not extrapolation), paired with **C** for the drag-drop path specifically (highest-frequency, most avoidable trigger, more scoped than a full rewrite). Treat **A** (real algorithmic fix) as a follow-up round once product has a real time budget — it's the only approach that raises the ceiling rather than making the current one honest or reducing call frequency. **B** is a reasonable fallback if A proves too invasive, but should degrade only above the *new, lower* `OVERSIZED_THRESHOLDS` (not `NESTED_LAYOUT_LIMITS`'s 60/120) so it doesn't regress mid-size graphs that already render fine.

## What "Acceptable" Would Mean (needs a fresh product decision)

No existing documented UX budget exists — propose fresh in `sdd-propose`/`sdd-design`:
- Sub-second (~<1s) at `NESTED_LAYOUT_LIMITS`'s boundary ({60,120}) — already roughly met (~0.9s).
- A firm ceiling (e.g. ≤3-5s) for whatever the *revised* `OVERSIZED_THRESHOLDS` becomes, since crossing it already implies an explicit "render anyway" action.
- Drag-drop commit specifically should have a much tighter budget (sub-200ms ideally), since it's direct manipulation — argues strongly for Option C being non-optional regardless of what happens to the batch/cold-load thresholds.

## Risks

- Any change to `edgePathsFor`'s coordination scope (A or C) risks breaking `coordinatedRouting.test.ts`'s no-crossing/determinism/occupied-ordering invariants — must stay green or be deliberately, explicitly revised.
- No real browser/Extension-Host frame-paint measurement exists yet — all numbers are `layoutGraph`'s synchronous compute cost only; true end-to-end freeze (React Flow reconciliation + up to 600 SMIL particles) could be worse, should be re-validated once a fix lands.
- Choosing a new threshold/cutoff (B/D) without a documented product time budget risks an arbitrary number revisited again later — get that number nailed down in `sdd-propose` before implementation.
- Live timing re-confirmation was NOT performed in this exploration (tool limitation, no Bash) — the complexity analysis is high-confidence static reasoning consistent with the previously measured numbers, but a fresh 2-3-size timing run should be the first step of whichever phase implements the fix.

## Ready for Proposal

Yes. Recommend `sdd-propose` for `edge-router-performance`, scoped to: (1) an immediate `OVERSIZED_THRESHOLDS` correction backed by a fresh measurement, (2) a design decision + implementation for scoped/incremental re-routing on drag-drop commit, and (3) a separately-scoped follow-up (or explicit deferral) for the deeper ≈O(N³) algorithmic fix in `edgePathsFor`/`routeCost`, with a product-owner decision needed on the acceptable time budget before design work starts.
