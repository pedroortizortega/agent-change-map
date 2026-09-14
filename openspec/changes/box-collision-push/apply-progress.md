# box-collision-push — apply progress

Direct-inline implementation (per project convention: a narrowly-scoped, well-understood feature
does not need a full proposal/spec/design cycle). This document is the design writeup + TDD
evidence for the change, in place of a full SDD artifact set.

## Scope

Node/container boxes must never visually overlap after a drag: when a dragged box would overlap
another box, the overlapped box gets pushed clear instead. Explicitly separate from
`edge-router-performance` (line-crossing, not box-overlap) — the edge router
(`edgeGeometry.ts`/`routingGraph.ts`/`routeSearch.ts`) is untouched; existing edge routing
(including PR4's scoped drag-commit re-route) continues to re-route to wherever boxes end up
after collision resolution.

## Architecture read (bounded, no full SDD cycle)

- `webview/index.tsx`: `onNodesChange` computes a LIVE preview via `computeLiveDragUpdate` on
  every pointer-move during a drag (merged into the `nodes`/`edges` arrays fed to
  `<ReactFlow>`); `onNodeDragStop` commits the final position via `positionOverrides.set` and
  triggers a scoped `layoutGraph` re-route (PR4).
- `webview/graphLayout.ts`: `layoutGraph`/`probeBoxes` compute absolute containment boxes;
  `computeLiveDragUpdate` merges an in-progress drag position into a live copy of `boxes` and
  re-anchors touched edges, without touching committed `positionOverrides`.
- `webview/positionOverrides.ts`: `descendantsOf` walks `AcmNode.data.parentId` chains to find
  every descendant of a dragged container (D14 cascade) — used both for the drag's OWN cascade
  and, now, to carry a PUSHED container's own descendants along with it.
- Checked `@xyflow/react`/`@xyflow/system`'s exports (`node_modules/@xyflow/react/dist/esm/index.d.ts`):
  no exported pure/testable AABB overlap-resolution primitive (`getIntersectingNodes` is a
  store-bound hook API, not usable from a DOM-free pure function) — a small from-scratch AABB
  push-out function is the right call here, not a from-scratch geometry engine (it's ~10 lines of
  arithmetic, testable in isolation, matching this codebase's existing `Rect`-based box model).

## Design decisions

1. **New pure function `resolveCollisions`** in `webview/graphLayout.ts` (co-located with the
   existing `Rect`/`Position`/box-model code it operates on, rather than a new module — it's a
   small, tightly-coupled extension of the existing box-layout vocabulary, not an independent
   concern).

   ```ts
   export function resolveCollisions(input: {
     boxes: ReadonlyMap<string, Rect>;
     movedIds: ReadonlySet<string>;
     descendantsOf: (id: string) => readonly string[];
     maxIterations?: number; // default 5
   }): Map<string, Position>
   ```

   Given the CURRENT absolute `boxes` (with every id in `movedIds` — the dragged box plus its own
   D14-cascaded descendants — already at its live/final dragged position), returns the NEW
   absolute positions for every OTHER box that must be pushed clear of a mover, plus (bounded) any
   box pushed clear of one of THOSE pushed boxes in turn. Never returns an entry for a mover id
   itself.

2. **Push axis = minimum overlap (standard AABB push-out).** For an overlapping pair, whichever
   axis (x or y) has the smaller overlap amount is the separating axis — the shortest distance
   that fully clears the two rectangles. Direction is away from the mover's center; a dead-center
   tie pushes in the positive direction, deterministically (`pushVector`).

3. **A container being pushed carries its descendants with it**, and **a container being dragged
   is treated as its own full bounding rect**, not tested child-by-child. Both reuse the SAME
   `descendantsOf` callback the existing D14 cascade already uses — passed into
   `resolveCollisions` (and into `computeLiveDragUpdate`, as the new optional `descendantsOfId`
   parameter) so a pushed container's own children move as a single rigid group along with it,
   consistent with `onNodeDragStop`'s existing cascade math. A dragged container's own children
   are never individually overlap-tested against other boxes — they're part of `movedIds` (movers
   are only ever checked against non-movers), so only the container's bounding rect (plus any
   sibling boxes) participates in overlap detection for the drag itself.

4. **Bounded chain-reaction resolution, explicitly NOT a physics simulation.** Each iteration:
   collect every (mover, non-mover) overlapping pair, sort by overlap AREA descending, and resolve
   the largest first (this matters — resolving a small overlap first can occasionally leave a
   bigger one unresolved that pass, when a target overlaps two movers or the sort order affects
   axis choice consistency). Every box pushed this iteration becomes a mover for the NEXT
   iteration only (not accumulated) — bounded by `maxIterations` (default `5`). This is a
   deliberate scope decision: an arbitrarily long overlap chain is not guaranteed to fully resolve
   in one drag frame; it will visually settle further as the user continues the gesture (each
   subsequent pointer-move re-runs the same bounded resolution from the new live position) rather
   than attempting an unbounded fixed-point solve or full physics engine. Tested explicitly in
   `test/unit/boxCollision.test.ts`'s "is bounded" case.

5. **Responsive during the LIVE drag, not just on drop.** `computeLiveDragUpdate` (already the
   mechanism behind the existing live-drag-preview / live-edge-re-route feature) gained an
   optional `descendantsOfId` parameter; when provided, it runs `resolveCollisions` against the
   in-progress live box positions on every `onNodesChange` pointer-move, merges pushed positions
   into the same `positions`/`edgeOverrides` maps the caller already consumes, so pushed boxes
   (and their edges) visually move in real time during the gesture — reusing the existing pattern
   rather than inventing a parallel one. `webview/index.tsx`'s `onNodesChange` now passes
   `descendantsOfId: (id) => descendantsOf(id, layout)`.

6. **Persisted on drop.** `onNodeDragStop` builds a local working copy of the pre-drag `boxes`
   with the dragged node (and its D14-cascaded descendants) already moved to their committed
   position, runs `resolveCollisions` against it, and calls `positionOverrides.set` for every
   pushed id — exactly like the dragged node's own position — and folds every pushed id into
   `movedIds` so PR4's scoped drag-commit re-route (`DragCommitScope`) genuinely re-solves their
   edges too, rather than carrying forward stale pre-push routes.

## TDD evidence

RED: `test/unit/boxCollision.test.ts` written first against `resolveCollisions` (not yet
exported) — confirmed all 8 initial tests failed with `TypeError: resolveCollisions is not a
function` before any implementation existed.

GREEN: implemented `overlapAmount`, `pushVector`, `resolveCollisions` in `webview/graphLayout.ts`;
all 8 tests passed (one test needed a fixture fix — an accidental overlapX/overlapY tie that made
the "container's full bounding rect" case ambiguous about which axis a valid resolution should
use; fixed the fixture to have an unambiguous minimum-overlap axis, not the implementation).

Covered scenarios: no push when boxes don't overlap; push along the minimum-overlap axis
(horizontal and vertical cases, independently verified via `rectsOverlap` that the pushed result
genuinely no longer overlaps); a pushed container carries its descendants along with it (rigid
group, tested via exact same dx/dy on child and parent); a dragged container's own bounding rect
(not its individual children) is what other boxes get pushed clear of; a bounded chain reaction
(pushing B into C also pushes C clear); the bounded-iteration cap (documents non-guarantee of full
resolution for an arbitrarily long chain, and that the function terminates promptly regardless);
never returns an entry for a mover id itself.

REFACTOR / verification (all run for real, not assumed):

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm test` — 599 tests passed (37 files), including the pre-existing D14 cascade, live-drag,
  and PR4 scoped-reroute regression suites, unchanged.
- `npm run test:e2e` — all scenarios pass against a real VS Code Extension Development Host
  instance.

## Performance (measured, not assumed)

Per this project's own established discipline (see `graphLayout.test.ts`'s router perf probes),
added a real timing test rather than assuming the naive O(movers × boxes) per-iteration scan
(bounded to 5 iterations) is fine at `OVERSIZED_THRESHOLDS` scale:

`test/unit/boxCollision.test.ts`'s perf probe — 300 densely-packed boxes (worst case: every box
overlaps its neighbor, maximizing chain-reaction work), single drag from one end:

```
[perf-probe] resolveCollisions chain-reaction across 300 boxes took 0.28ms
```

Comfortably inside a single frame's ~16ms budget (asserted `< 50ms`, with the real number logged)
— confirms the naive approach is genuinely fine at this scale, not merely assumed to be.

## Constraints honored

- Edge router (`edgeGeometry.ts`/`routingGraph.ts`/`routeSearch.ts`) untouched — only
  `webview/graphLayout.ts` (new pure function + `computeLiveDragUpdate` extension) and
  `webview/index.tsx` (wiring) changed.
- Boxes remain fully permeable to edges — collision resolution is box-vs-box only; nothing in
  `resolveCollisions` or its call sites touches edge routing/anchoring logic beyond re-solving the
  edges of boxes whose POSITION changed (same mechanism PR4 already uses for the dragged node
  itself).
- Existing drag behavior (D14 cascade, position persistence, click-vs-drag threshold) preserved
  for the non-colliding case: `resolveCollisions` returns an empty map when nothing overlaps, so
  `positions`/`positionOverrides`/`movedIds` are identical to before this change whenever no
  collision occurs.
