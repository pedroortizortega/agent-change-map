# Exploration: graph-layout-and-interaction

## Scope

Three interactive/visual improvements to the change-map graph, requested after the user
compared it to a reference flowchart-style diagram from another tool:

1. Layout ordering / edge routing so lines don't cross through unrelated boxes.
2. Draggable nodes so the user can reorganize the diagram by hand.
3. Mouse-wheel zoom.

## Locked constraints (reconfirmed, none of the three requests touch these)

- The dashed-container/solid-entity stroke convention (`KIND_STYLE` in `webview/graphView.ts`).
- The outline-only / no-fill / change-status-stroke-color scheme (`renderNodeRect`,
  `.node-box.status-*` CSS via `--acm-status-*` custom properties).
- The geometric-containment layout itself (nested `<g>`s expressing `contains`).
- The `data-*` attribute contract.
- The strict CSP — no request needs a CSP change; all three are native DOM/SVG features.

## Current state

The graph is a hand-rolled SVG string builder (~380 lines, no layout/graph library
dependency). `measure()`/`place()` do bottom-up sizing then top-down absolute placement;
siblings within a container are stacked strictly vertically in `graph.nodes` array order —
no ordering heuristic exists. `renderEdge()` draws a fixed-anchor cubic Bezier from source
bottom-center to target top-center with no obstacle awareness at all — already documented in
the archived `diff-view-and-graph-styling` design as "deliberately naive... accepted debt."
No `viewBox` exists on the root `<svg>` today (only `width`/`height`). No drag or wheel
handling exists anywhere in `webview/index.ts`, which owns all DOM/event wiring for the
graph.

## Request 1 — Layout ordering / no line-through-box crossings

**Options considered:**
1. Sibling reordering only (barycenter/topological heuristic) — smallest change, but doesn't
   by itself prevent crossings through unrelated boxes.
2. **Obstacle-avoiding waypoint/elbow routing layered on the existing containment layout
   (recommended)** — `renderEdge` tests the straight anchor-to-anchor path against the
   already-known `boxes: Map<nodeId, Rect>` for intervening boxes (any box that isn't the
   edge's own source/target), and inserts waypoints to dodge around a crossing, falling back
   to the existing Bezier when nothing is in the way (the majority case). Additive to
   `renderEdge` only — `measure()`/`place()`/`KIND_STYLE` untouched.
3. Full Sugiyama-style layered layout, replacing `measure()`/`place()` — the textbook answer,
   but fundamentally incompatible with the existing geometric-containment model: containment
   is expressed by literal nesting (Decision 5 of the archived design — `contains` draws no
   edge, nesting *is* the relationship), and Sugiyama has no native concept of that. Adopting
   it would mean either abandoning nesting (which the dashed/solid convention depends on) or a
   nontrivial hybrid — high risk for a from-scratch ~400-line layout with no protective test
   suite beyond what exists today.

**Recommendation**: Approach 2 (obstacle-avoiding waypoint routing) as the primary fix, plus
Approach 1 (cheap sibling reordering) as a low-cost complement that reduces how often routing
even needs to kick in. Matches the user's own framing (smallest change, don't touch the
locked conventions).

## Request 2 — Draggable boxes

**Confirmed technical fact**: children are rendered as `<g>` elements with a `transform`
*local* to their parent's own `<g>`, so dragging a container moves its nested children "for
free" visually. It is *not* free for edge re-anchoring, though — the absolute `boxes` map is
computed once at initial render and does not auto-update when a `<g>`'s transform changes
client-side; a container drag's delta must be accumulated across ancestors to recompute a
descendant's live absolute position for edge anchoring.

**Options considered:**
1. **Drag-then-recompute-on-drop (recommended MVP)** — `pointerdown`/`pointermove`/`pointerup`
   on each node's `<g>`, with a small movement threshold (~4-5px) to disambiguate from a
   click; the node's `transform` updates live during drag, but affected edges' `d` attributes
   are only recomputed once, at drop. Requires porting a small (~3-line) subset of the
   anchor/Bezier formula into the webview side (not the full `renderEdge`, since kind/dash/
   marker attributes never change on drag).
2. Fully live edge re-routing during drag — best fidelity, but requires porting the full
   anchor (and, if Request 1 ships, obstacle-avoidance) computation into live webview JS and
   re-running it every `pointermove` tick against every affected edge — meaningfully more
   duplicated logic and a real performance question once obstacle-avoidance is involved.

**Recommendation**: Option 1 as the pragmatic MVP; Option 2 flagged as a natural v2 if visual
fidelity during the drag itself turns out to matter.

**Open product decisions, not assumed**:
- Whether dragged positions persist across a refresh, or reset on every re-render. No
  existing precedent decides this — the refresh state-preservation table from
  `untracked-files-live-refresh-and-styling` covers UI/selection state (diff collapse, draft
  text, selected node), not computed-geometry overrides. Persisting would need a new
  `Map<nodeId, {dx,dy}>` re-applied after each render; resetting needs nothing new.

## Request 3 — Mouse-wheel zoom

**Options considered:**
1. **`viewBox`-based zoom-to-cursor, scoped to `#graph` (recommended)** — add a `viewBox`
   matching the current `width`/`height` (no visual change at first paint); one `wheel`
   listener on `#graph` only (not `window`), `preventDefault()` only when the event targets
   that container so the rest of the panel scrolls normally; standard zoom-toward-cursor
   `viewBox` math on each wheel tick.
2. CSS `transform: scale()` on the `<svg>` — simpler at first glance, but zooming toward the
   cursor needs the same coordinate-space bookkeeping anyway, now mixed with CSS transform
   space instead of the SVG's own coordinate system built for exactly this. Not recommended.

**Recommendation**: Option 1.

**Open product decision, not assumed**: reset zoom on every new graph render (recommended,
matching how `expandedRuns` resets on a plain new selection) vs. persist across a refresh
(zoom is a viewport preference, not user work-product like a draft or diff-collapse state —
no existing precedent covers this category either way).

## Test-coverage impact (Strict TDD)

- Request 1: new `graphView.test.ts` cases — a crossing fixture asserting the edge's `d`
  detours around the intervening box; a non-crossing fixture asserting the existing Bezier
  shape is unchanged (regression proof for the majority case).
- Request 2: new `webviewDom.test.ts` interaction cases following the existing `click()`
  helper pattern — a `drag()` helper dispatching a pointer sequence past the threshold,
  asserting the node's `transform` changed and its edges' `d` updated on drop; a
  below-threshold sequence still firing the existing click/navigate behavior (proving
  disambiguation). `PointerEvent` support in the pinned jsdom version needs a smoke test
  before committing test helpers to it — `MouseEvent` with explicit `clientX`/`clientY` is
  the documented fallback.
- Request 3: new `webviewDom.test.ts` cases dispatching `WheelEvent` against `#graph`,
  asserting `viewBox` changes as expected and that `preventDefault()` only fires for events
  targeting the graph container; a reset-on-render case.
- None of the three requests touch the kind/status encoding, `data-*` contract, or diff
  panel — unlike the two archived changes, no existing test rewrite is anticipated, only
  additions. `test/e2e/scenarios.ts`'s click-navigation scenario must stay green untouched.

## Risks

- Request 1's routing has no guaranteed-zero-crossings bound with a bounded waypoint count —
  should be presented as improved, not perfect, especially near the 60-node degradation
  threshold.
- Request 2's live-recompute option (if chosen later) risks the anchor/routing math silently
  drifting between `graphView.ts` (host-string-build time) and `index.ts` (webview-live time)
  unless deliberately factored into one shared, dual-compiled pure-geometry module.
- Both open product decisions above (drag persistence, zoom persistence) have no existing
  precedent to lean on and must be explicitly confirmed with the user, not assumed.
- jsdom's `PointerEvent` support in this project's pinned version is unverified.

## Ready for proposal

Yes, carrying three open decisions: (1) drag-then-recompute-on-drop vs. fully-live re-routing
during drag, (2) dragged-position persistence across refresh, (3) zoom persistence across
refresh.
