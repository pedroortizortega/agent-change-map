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

## Follow-up fix: real-world convergence bug (post-PR #51 live testing)

Live-testing this branch's `resolveCollisions` in the VS Code Extension Development Host
surfaced a genuine bug: dragging a box that pushed multiple sibling boxes at once (e.g. a
container "app" with several adjacent boxes like "route"/"route2"/"route3") could leave one of
those siblings still visually overlapping/nested inside another box after resolution — the
9-test suite in `test/unit/boxCollision.test.ts` did not catch this because none of the original
fixtures had TWO boxes pushed by the SAME mover in the SAME pass whose new positions overlapped
each other.

### Root cause

`resolveCollisions` iterated in per-iteration BATCHES: each iteration computed candidates as
"every current `mover` vs every box NOT in the current `movers` set", resolved them, then set
`movers = newMovers` (the set of boxes just pushed THIS iteration) for the next iteration.

Two independent defects compounded:

1. **Same-iteration siblings never checked against each other.** If a single mover overlapped
   two different targets in the same pass, both got pushed away from the mover independently, but
   never against EACH OTHER within that pass (each was only checked as a target of the mover, not
   as a mover/target of the other sibling).
2. **The very next iteration made this permanent, not just delayed.** In iteration N+1,
   `movers = {sibling A, sibling B}` (both pushed in iteration N). The candidate-generation loop
   had `if (movers.has(targetId)) continue;` — so sibling A (as a mover) skipped sibling B (as a
   target) purely because B was ALSO a mover that iteration, and vice versa. That pair was then
   never re-checked on any LATER iteration either, since after iteration N+1 neither became a
   "new mover" (their candidate was skipped, not deferred) — a permanent blind spot, not a
   convergence-speed problem. Raising `maxIterations` alone would not have fixed this; the
   algorithm needed to stop batching by iteration and stop excluding same-batch siblings from each
   other.

Proven with a new RED test before any fix (`"fully resolves a same-iteration double-push..."` in
`test/unit/boxCollision.test.ts`): a dragged "app" box overlapping two siblings "route2"/"route3"
that, once independently pushed clear of "app", land on top of EACH OTHER. Against the pre-fix
implementation this failed with `expected true to be false` on the
`rectsOverlap(finalRoute2, finalRoute3)` assertion — i.e. route3 was left genuinely overlapping
route2, matching the reported "route2 ending up inside app" symptom class exactly (a
sibling-vs-sibling overlap surviving resolution).

### Fix

Replaced the per-iteration batch model with a greedy fixed-point loop: at each step, resolve the
SINGLE globally-worst remaining overlap (by area) between any "active" box (any box ever pushed,
plus the original movers — cumulative, never reset per iteration) and any pushable target
(anything not an original mover). The pushed box joins the active set for future steps. This
means two siblings pushed from the same original mover in different steps are still checked
against each other on a later step, closing the exact blind spot above. Default `maxIterations`
raised from 5 to 50 (still a documented, capped safety limit — not "loop forever" — with a
stop-and-return-partial fallback for pathological non-converging clusters, same philosophy as
before, just numerically generous enough for realistic clusters).

A second regression surfaced once the greedy loop was running: a pushed container's own
descendants (which are SUPPOSED to nest inside the container's bounding rect — rigid group
movement) started getting re-pushed away from their own container, because the greedy scan now
sees ANY active-box-vs-target AABB overlap as a candidate, including a container legitimately
containing its child. Fixed by excluding container/descendant pairs from candidate generation
in both directions (`descendantsOf(moverId).includes(targetId) || descendantsOf(targetId).includes(moverId)`)
— this is the same containment information `resolveCollisions` already receives via the
caller-supplied `descendantsOf`, just now also used to define "not a collision" rather than only
"what to carry along when pushing."

### Convergence guarantee, honestly stated

Not an unconditional full-physics guarantee. The greedy loop is capped at `maxIterations` (default
50) as a safety valve against pathological/never-converging clusters; if a real cluster needs more
than 50 individual pushes to fully separate (very unlikely for realistic node counts in this
extension's diagrams — the bug-report cluster needed 2), the function returns whatever partial
resolution it reached rather than hanging. Each individual push is provably progress (the pushed
pair is made non-overlapping by construction via `pushVector`), so any residual overlap after the
cap is strictly bounded to the remaining unresolved pairs, not silent data corruption or worse
overlap than before. Existing test `"is bounded: stops after a small fixed number of iterations..."`
still explicitly documents (with `maxIterations: 2`) that partial, non-fully-resolved output is an
accepted, intentional outcome of hitting the cap — this is unchanged by the fix, only the DEFAULT
cap and the per-step resolution logic changed.

### TDD evidence (this follow-up)

RED: added the same-iteration double-push test first; confirmed it failed against the
pre-fix implementation (`rectsOverlap(finalRoute2, finalRoute3)` was `true`, expected `false`).

GREEN: rewrote `resolveCollisions`'s iteration model as described above; RED test passed. Running
the full pre-existing 9-test suite alongside it then surfaced the container/descendant regression
(`"pushes a container's descendants along with it"` failed: child moved independently of its
container, `-20` vs expected `10`) — fixed via the descendant-exclusion rule; full suite green
again.

`test/unit/boxCollision.test.ts` — 10/10 tests passing (9 pre-existing + 1 new RED-then-GREEN):

```
✓ does not push anything when no boxes overlap
✓ pushes an overlapped stationary box along the axis of minimum overlap (horizontal case)
✓ pushes an overlapped stationary box along the axis of minimum overlap (vertical case)
✓ pushes a container's descendants along with it, using descendantsOf
✓ treats a dragged container as its full bounding rect, not its individual children
✓ handles a bounded chain reaction: pushing B into C also pushes C clear
✓ is bounded: stops after a small fixed number of iterations rather than chasing an unbounded chain
✓ fully resolves a same-iteration double-push: two siblings pushed by the same dragged box must not end up overlapping EACH OTHER
✓ never returns an entry for a mover id itself
✓ resolves a worst-case single-drag chain-reaction across 300 densely-packed boxes well under a 16ms frame budget
```

### Performance re-verification (measured, not assumed)

The fix moves from "resolve a batch of pushes per iteration" to "resolve one push per step,
recomputing the globally-worst overlap over the full active×working set each step" — strictly
more per-step work, so the 300-box perf probe was re-measured for real rather than assumed still
fine:

```
Before this fix (batch model, maxIterations=5):  0.28ms  (from the original apply-progress entry)
After this fix  (greedy model, maxIterations=50): 0.81ms  (real re-measurement, same 300-box fixture)
```

Still comfortably inside the `< 50ms` assertion and the real ~16ms single-frame budget the
comment references (0.81ms is ~20x under budget). The increase is expected (10x more default
iterations, each doing a full active×working scan instead of a movers-batch scan) but the absolute
cost remains negligible at this project's `OVERSIZED_THRESHOLDS` scale (300 nodes).

### Full gate (all run for real)

- `npm run typecheck` — clean.
- `npm run lint` — clean (`eslint src test webview --max-warnings=0`).
- `npm test` — 600/600 tests passed across 37 files (the +1 new test plus all pre-existing
  suites, including D14 cascade, live-drag, PR4 scoped-reroute, and edge-router regression suites
  — none touched, none regressed).
- `npm run test:e2e` — all scenarios pass against a real VS Code Extension Development Host
  instance (selection, navigation, draft-save, refresh, run/stream, cancel — unaffected by this
  change, run for full-gate confidence per this task's instructions).
- `npm run build:webview` — rebuilt `out/webview/webview/index.js`/`styles.css` so the fix is
  live-testable by reloading the Extension Development Host.

### Constraints honored (this follow-up)

- Edge router untouched (`edgeGeometry.ts`/`routingGraph.ts`/`routeSearch.ts`/`webview/index.tsx`
  edge-related code) — only `resolveCollisions`'s internal iteration/candidate logic in
  `webview/graphLayout.ts` changed, plus its doc comment.
- "Container carries descendants" and "dragged container uses its full bounding rect" behaviors
  both explicitly re-verified passing (pre-existing tests, unchanged assertions) after the fix —
  the descendant-exclusion rule was added specifically to PRESERVE the former, not to change it.
- Same branch (`feat/box-collision-push`), additional commit on top of `210c5b8`, no new branch —
  PR #51 stays the review target.

## Follow-up: configurable minimum gap between pushed boxes (post-19c3676)

The collision fix above only prevents OVERLAP (0px gap) — a pushed box lands exactly touching
the box it was pushed clear of. User wants a real, configurable minimum visual gap instead of
0px, to experiment with (5px first, then 10px) and see which reads better.

### Design decision: constant, not a threaded parameter

Considered threading a `minGap` parameter through `resolveCollisions`'s signature vs. a simple
module-level constant. Chose a constant, matching this file's own existing convention
(`ROOT_GAP`, `MARGIN`, `NODE_MIN_W`, etc. are all plain top-of-file `const`s) and
`edgeGeometry.ts`'s (`LANE_GAP`, `ROUTE_CLEARANCE`). The user's explicit ask — "let it be a
variable I can configure and try 5 then 10" — is fully satisfied by a single well-commented
constant; threading it as a runtime parameter or exposing a setting/UI control would be
over-engineering for a request that is really "give me one number to flip and re-test."

**`BOX_MIN_GAP`** — `webview/graphLayout.ts`, declared right after `MARGIN` (~line 26), exported
so the test suite asserts against it directly instead of duplicating the number:

```ts
export const BOX_MIN_GAP = 5;
```

To try 10px next: change that single line to `export const BOX_MIN_GAP = 10;`, then
`npm run build:webview` to make it live-testable. No other file needs to change — this is by
design (see the constant's own doc comment).

### Scope discipline: pads an existing push, does not add a new global constraint

`overlapAmount`/`pushVector` are only ever invoked when two boxes ALREADY overlap (`overlapAmount`
returns `undefined` for non-overlapping pairs, and `resolveCollisions`'s greedy loop only ever
picks up defined overlaps as candidates). Adding `BOX_MIN_GAP` to `pushVector`'s computed
displacement therefore only affects boxes that were already going to be pushed — it does NOT turn
this into a "maintain N px between all boxes everywhere" layout constraint. A new RED test
explicitly locks this in: two boxes separated by more than `BOX_MIN_GAP` (never overlapping) are
untouched (`result.size` stays `0`).

### TDD evidence

RED: added 3 tests to `test/unit/boxCollision.test.ts` importing `BOX_MIN_GAP` from
`graphLayout.ts` (not yet exported) — confirmed 2 of the 3 failed against the current 0px-gap
implementation (`expected 100 to be greater than or equal to NaN` / same for the vertical case,
since `BOX_MIN_GAP` was `undefined`); the "already well-separated, not pushed" test passed
trivially even pre-fix, confirming it captures existing (unchanged) behavior rather than the new
feature.

GREEN: added `export const BOX_MIN_GAP = 5;` near `MARGIN`; changed `pushVector` to add
`BOX_MIN_GAP` to the computed X/Y displacement on whichever axis is chosen. All 3 new tests pass;
full pre-existing 10-test suite (including the greedy fixed-point convergence fix from 19c3676)
still passes unchanged — 13/13 in `boxCollision.test.ts`.

```
✓ maintains at least BOX_MIN_GAP px of separation after a push (horizontal case), not just 0px
✓ maintains at least BOX_MIN_GAP px of separation after a push (vertical case), not just 0px
✓ does NOT push boxes that are already separated by more than BOX_MIN_GAP — this pads an existing
  push, it does not enforce a minimum gap globally
```

### Performance re-verification (measured, not assumed)

The change is pure arithmetic (one extra addition per axis choice in `pushVector`), but measured
the 300-box perf probe again anyway per this project's standing discipline of never assuming:

```
Before (19c3676, 0px gap, greedy model): 0.81ms
After  (this change, BOX_MIN_GAP=5):     0.63ms  (within normal run-to-run noise; no regression)
```

Comfortably inside the `< 50ms` assertion and the real ~16ms frame budget.

### Full gate (all run for real)

- `npm run typecheck` — clean.
- `npm run lint` — clean (`eslint src test webview --max-warnings=0`).
- `npm test` — 603/603 tests passed across 37 files (+3 new tests; all pre-existing suites
  unchanged, including D14 cascade, live-drag, PR4 scoped-reroute, edge-router regression suites,
  and the 19c3676 same-iteration convergence-fix suite).
- `npm run test:e2e` — all scenarios pass against a real VS Code Extension Development Host
  instance (also rebuilds the webview as part of its own pipeline).
- `npm run build:webview` — explicit standalone rebuild confirmed `BOX_MIN_GAP` is baked into
  `out/webview/webview/index.js` (grep count: 3 occurrences), live-testable by reloading the
  Extension Development Host.

### Constraints honored (this follow-up)

- Edge router untouched (`edgeGeometry.ts`/`routingGraph.ts`/`routeSearch.ts`) — only
  `webview/graphLayout.ts` (`BOX_MIN_GAP` constant + `pushVector` displacement) and
  `test/unit/boxCollision.test.ts` changed.
- All previously-verified push behaviors preserved and re-confirmed passing unchanged: chain-
  reaction convergence fix (19c3676), container/descendant rigid-group cascade, dragged-container-
  as-bounding-rect.
- Same branch (`feat/box-collision-push`), additional commit on top of `19c3676`, no new branch —
  PR #51 stays the review target.
- Did not build anything toward the user's secondary "might help edge crossings" hope — no edge-
  router files touched. Brief observation (not implemented, not verified): a larger gap gives the
  router's obstacle-clearance/anchor-hop logic more free space to route through, so a bigger
  `BOX_MIN_GAP` MIGHT incidentally reduce some edge crossings in densely-packed layouts — but this
  is speculative and out of scope for this pass; it should be evaluated separately, visually, once
  5px vs 10px is compared.

### Next step for the user's 5-vs-10 comparison

To switch to 10px: edit `webview/graphLayout.ts`, change `export const BOX_MIN_GAP = 5;` to
`export const BOX_MIN_GAP = 10;`, then run `npm run build:webview` and reload the Extension
Development Host. That is the entire diff — no test changes needed (tests already assert against
the imported constant, not a hardcoded number).

## Follow-up fix: multi-drag stale-box overlap ("route" container cutting through "route3"/"route4")

### Bug description (live-testing report, post-93abc35)

Dragging/pushing multiple stacked CONTAINER boxes from bottom to top (a real diagram with root
containers "route", "route3", "route4", each with several leaf children, stacked vertically) left
"route"'s own box visually overlapping/cutting through "route3"'s content after the drag sequence
— route's dashed border rendered through the middle of route3, even though `resolveCollisions`
itself (10/10 tests passing) had already been fixed twice for chain-reaction/sibling bugs.

### Root cause (confirmed, not theorized)

`webview/graphLayout.ts`'s `layoutGraph` computes `LayoutResult.boxes` from `probeBoxes`/`measure`
— **always the box's ORIGINAL, un-dragged position**. This is intentional and documented on
`boxesForRouting`'s own doc comment: `result.boxes` never gets merged with `positionOverrides`;
only the boxes fed into edge ROUTING are merged, at the routing call site.

`webview/index.tsx`'s `onNodeDragStop` (the DROP/persist path, as opposed to the live mid-drag
preview) built its `resolveCollisions` working set as `new Map(layout.boxes)` — the RAW,
un-overridden layout — with only the CURRENTLY-dragged node (and its own D14 descendants)
overwritten to their commit position. Every OTHER box, including any container ALREADY moved by an
EARLIER drag in the same session (its real position tracked only in `positionOverrides`, never
back-written into `layout.boxes`), was checked for overlap at its STALE, pre-override position —
not where it actually renders.

Concretely, in a multi-drag sequence (drag route4, drop — pushes/moves route3 close under route,
persisted via `positionOverrides`; THEN drag route5 later), the SECOND drag's collision resolution
compared the new drag against route3's ORIGINAL layout position (e.g. `y=200`), not its real
current position (e.g. `y=45`, close under "route"). A real on-screen overlap between the new drag
and route3's ACTUAL position was therefore silently missed (or, when a chain reaction WAS
triggered by coincidence, computed a push amount from the wrong starting point) — leaving route3
either unresolved-overlapping the new drag, or pushed by the wrong delta straight into "route"
above it, matching the exact reported symptom (a container's box cutting through a DIFFERENT,
already-positioned container's content).

`webview/positionOverrides.ts`'s `descendantsOf` (id-based `parentId` walk) and
`computeChildrenOf`'s containerId-based nesting were both re-read and ruled out — "route" and
"route3" are genuine SIBLING root containers (`containerId === undefined` for both), not
accidentally nested; `resolveCollisions`'s own iteration/candidate logic (the greedy fixed-point
loop, the same-batch-sibling fix, the container/descendant exclusion rule) was also re-read and is
correct in isolation — it resolves whatever `boxes` it's given correctly. The bug was entirely in
what `onNodeDragStop` fed it: a stale, non-current snapshot for every already-moved box.

By contrast, `computeLiveDragUpdate` (the LIVE mid-drag preview path) was already correct — it
builds its working set via `boxesForRouting(layout.boxes, overrides)`, which DOES merge in
committed overrides. This asymmetry (live preview correct, drop/persist path buggy) is why the
overlap could look momentarily resolved during the gesture but reappear/differ after drop, and why
a genuinely bad result could persist across multiple further drags (each new drag's collision
check kept comparing against the same stale positions).

Proven with a RED test first, against the pre-fix behavior (temporarily reproduced by constructing
`resolveDragCommit`'s working set from raw `boxes` only, ignoring `overrides` — the exact shape of
the original `onNodeDragStop` bug): `test/unit/boxCollision.test.ts`'s new `resolveDragCommit`
suite, "resolves a drop's collisions against a box's CURRENT (override-merged) position..." failed
with `expected undefined to be defined` (route3 was never even recognized as needing a push,
because its stale position never overlapped the new drag at all) and the dx/dy cascade test failed
with `expected { x: 530, y: 540 } to deeply equal { x: 30, y: 40 }` (a dragged node's OWN D14
cascade was also computed from its stale pre-override position, a second instance of the same root
cause for the dragged node itself, not just other boxes).

### Fix

Extracted a new pure, exported function `resolveDragCommit` in `webview/graphLayout.ts` — the
"drop" counterpart to the existing `computeLiveDragUpdate` ("live preview" counterpart), following
the same established pattern. It builds its working set via
`boxesForRouting(new Map(boxes), overrides)` (the SAME merge `computeLiveDragUpdate` and edge
routing already use) before computing the dragged node's dx/dy, cascading its D14 descendants, and
running `resolveCollisions` — so both the dragged node's own delta AND every other box's current
position are correct. `webview/index.tsx`'s `onNodeDragStop` now calls this function instead of
duplicating the (buggy) logic inline; the local `committedBoxes`/`dx`/`dy`/manual descendant loop
that previously lived in `index.tsx` is gone, along with the direct `resolveCollisions` import
there (now only used internally by `resolveDragCommit`).

### TDD evidence

RED: `test/unit/boxCollision.test.ts`'s `resolveDragCommit` describe block, written first —
confirmed both new bug-reproducing tests failed against a raw-`boxes`-only (pre-fix-shaped)
implementation (see exact failures above); the third ("no prior overrides") test passed
pre-fix too, confirming it captures unchanged, correct existing behavior rather than the new fix.

GREEN: implemented `resolveDragCommit` using `boxesForRouting` for the merge; all 3 new tests
pass. Full `boxCollision.test.ts` suite (13 pre-existing + 3 new) — 16/16 passing. Rewired
`index.tsx`'s `onNodeDragStop` to call it; full project suite re-run to confirm no regression.

```
✓ resolveDragCommit > resolves a drop's collisions against a box's CURRENT (override-merged)
  position, not the stale pre-override layout position
✓ resolveDragCommit > computes the dragged node's own dx/dy cascade from its CURRENT override
  position, not the stale layout position
✓ resolveDragCommit > still resolves correctly with no prior overrides at all (non-regression)
```

### Performance re-verification (measured, not assumed)

`resolveDragCommit` wraps a single `boxesForRouting` merge (already O(overrides), cheap — existing
edge-routing call sites already pay this cost every render) plus one `resolveCollisions` call per
drop (unchanged cost model, re-measured):

```
[perf-probe] resolveCollisions chain-reaction across 300 boxes took 0.75ms
```

Comfortably inside the `< 50ms` assertion and the real ~16ms single-frame budget — no regression
(run-to-run noise vs. the 93abc35 baseline of 0.63ms, same order of magnitude).

### Full gate (all run for real)

- `npm run typecheck` — clean.
- `npm run lint` — clean (`eslint src test webview --max-warnings=0`).
- `npm test` — 606/606 tests passed across 37 files (+3 new `resolveDragCommit` tests; all
  pre-existing suites unchanged, including the two prior box-collision-push follow-up fixes,
  D14 cascade, live-drag, PR4 scoped-reroute, and edge-router regression suites).
- `npm run test:e2e` — all scenarios pass against a real VS Code Extension Development Host
  instance (also rebuilds the webview as part of its own pipeline).
- `npm run build:webview` — explicit standalone rebuild; confirmed `BOX_MIN_GAP` is still `15`
  (unchanged, user-set value preserved) and baked into `out/webview/webview/index.js` (grep count:
  3 occurrences).

### Constraints honored (this follow-up)

- Edge router untouched (`edgeGeometry.ts`/`routingGraph.ts`/`routeSearch.ts`) — only
  `webview/graphLayout.ts` (new `resolveDragCommit` export) and `webview/index.tsx`
  (`onNodeDragStop` rewired to call it) changed, plus `test/unit/boxCollision.test.ts`.
- `BOX_MIN_GAP` left at its current user-set value of `15` — not reverted.
- Same branch (`feat/box-collision-push`), additional commit on top of `93abc35`, no new branch —
  PR #51 stays the review target.

### Bug class closure — honest assessment

This closes the specific class of bug where the DROP/persist collision-resolution path used a
stale (non-current) box for anything not directly part of the CURRENT drag. `resolveDragCommit`
now sources its entire working set from `boxesForRouting(boxes, overrides)`, the same single
source of truth `computeLiveDragUpdate` and edge routing already rely on — there is no longer a
second, independently-constructed "boxes" snapshot anywhere in the drag/push pipeline that could
drift from the committed `positionOverrides`. I'm confident this specific "container box desyncing
from its children/from a prior drag's committed position" class is closed for the DROP path (it
was already correct for the LIVE mid-drag preview path).

One remaining, explicitly out-of-scope edge case worth flagging: `positionOverrides` is an LRU-
bounded map (`MAX_POSITION_OVERRIDES = 200`, see `positionOverrides.ts`). If a diagram ever has
more than 200 actively-overridden nodes and an old override gets evicted, `boxesForRouting` (and
now `resolveDragCommit`) would silently fall back to that node's stale `layout.boxes` position for
THAT specific node — not a bug introduced by this fix (the same LRU eviction already affects
rendering/routing today), but the same "stale box" symptom class could theoretically resurface
there. Not reproducible in practice at this project's real diagram sizes (`NESTED_LAYOUT_LIMITS`
tops out at 60 nodes, LRU cap is 200), so left as a documented, low-priority follow-up rather than
in-scope for this pass.
