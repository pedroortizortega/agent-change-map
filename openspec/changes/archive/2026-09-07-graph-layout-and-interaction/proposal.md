# Proposal: Graph Layout and Interaction

## Intent

The change-map graph renders correct structure but reads worse than the flowchart tools users
compare it to. Three concrete gaps, all found in hands-on use:

First, edges are drawn as a fixed-anchor cubic Bezier from source bottom-center to target
top-center with **no obstacle awareness at all** (accepted debt, explicitly recorded in the
archived `diff-view-and-graph-styling` design), and siblings inside a container are stacked
strictly in `graph.nodes` array order with no ordering heuristic — so lines routinely cut
straight through unrelated boxes and the reader cannot tell which line connects what.

Second, the diagram is entirely static. When the automatic layout puts two related nodes far
apart or stacks them awkwardly, the user has no recourse: there is no way to nudge a box aside
and no way to reorganize the picture by hand.

Third, there is no zoom. The root `<svg>` carries only `width`/`height` and no `viewBox`, so a
map that outgrows the panel can only be read by scrolling, never by zooming out to see the
shape of the change or in to read a dense cluster.

Success looks like: a user opens a comparison, sees edges that route around boxes instead of
through them, drags any box to a position that makes sense to them and watches its edges follow
live, wheel-zooms in and out over the graph, and finds their hand-placed layout still intact
after a refresh.

## Scope

### In Scope

**1 — Obstacle-avoiding edge routing and sibling ordering (`webview/graphView.ts`, new shared module)**
- Edge paths computed against the already-known absolute node-box map, testing the
  anchor-to-anchor path for intervening boxes (any box that is not the edge's own source or
  target) and inserting waypoints / elbow segments to route around a crossing.
- The existing Bezier remains the path for the non-crossing majority case — routing is a
  detour applied only when the straight path is actually obstructed.
- A cheap sibling-ordering heuristic (barycentric / topological) applied to sibling placement
  inside the existing containment layout, to reduce how often routing has to kick in at all.
- A **new pure, dependency-free geometry module** owning anchor selection, obstacle testing,
  and path construction — see Decision 1 below; this is a firm architectural requirement.

**2 — Draggable nodes with live edge re-routing (`webview/index.ts`)**
- `pointerdown` / `pointermove` / `pointerup` drag on each node's `<g>`, with a small movement
  threshold (~4–5px) disambiguating a drag from the existing click-to-navigate behavior. Below
  the threshold, current click-to-navigate fires unchanged.
- During the drag, the dragged node's own `transform` updates live **and** attached edge paths
  are recomputed live on every `pointermove` tick through the shared geometry module
  (Decision 1).
- Dragging a container moves its nested children for free via the existing local-transform
  nesting, but edge re-anchoring for descendants requires accumulating the container's drag
  delta on top of each descendant's original absolute position. This is a confirmed technical
  requirement from exploration, not an option.
- Dragged positions persist across refresh via a per-node position-override map (Decision 2).

**3 — Mouse-wheel zoom (`webview/graphView.ts` root `<svg>`, `webview/index.ts`)**
- A `viewBox` on the root `<svg>` matching the current `width`/`height` — no visual change at
  first paint.
- One `wheel` listener scoped to the `#graph` container (not `window`, not the panel), calling
  `preventDefault()` only for events targeting that container, so normal page/panel scrolling
  elsewhere is unaffected.
- Standard zoom-toward-cursor `viewBox` math per wheel tick. Zoom resets on every render
  (Decision 3).

### Out of Scope
- Any change to `KIND_STYLE` or the dashed-container / solid-entity stroke convention.
- Any change to the outline-only, no-fill, change-status-stroke-color scheme.
- Any change to the geometric-containment layout mechanism itself (`measure()`/`place()`,
  nested `<g>`s expressing `contains`) — it is preserved, not replaced.
- A full Sugiyama-style layered layout rewrite. Rejected in exploration as fundamentally
  incompatible with containment-by-nesting and far too risky for a ~400-line hand-rolled
  layout.
- Any change to the `data-*` attribute contract, beyond additive **transient** drag-state
  attributes if a design genuinely needs them. `data-node-id`, `data-edge-index`,
  `data-node-kind`, `data-change-status`, `data-edge-kind`, and `data-resolution` keep their
  exact current names, values, and placement.
- Click-drag panning, zoom controls/buttons, fit-to-view, or a re-layout command — only
  wheel-zoom was requested.
- Any CSP change. None of the three requests need one; all are native DOM/SVG features.
- Any change to the Python analyzer, git capture, diff panel, drafts, or Docker execution.

## Capabilities

### New Capabilities
None. All three requests refine an existing capability.

### Modified Capabilities
- `change-map-visualization`: edges route around intervening node boxes instead of crossing
  them and siblings are ordered by a placement heuristic; nodes are draggable with live edge
  re-routing and positions that survive a refresh; the graph supports wheel zoom-to-cursor
  scoped to the graph container.

## Approach

### Decision 1 — one shared geometry module, dual-compiled (decided, architectural requirement)

**Edge re-routing is fully live during the drag, not recomputed on drop.** This is the
higher-effort option from exploration, chosen over the recommended MVP for visual fidelity: an
edge that stays stale until the user releases the pointer defeats the purpose of dragging to
improve readability.

Live re-routing means the anchor/edge-path computation — **including Request 1's
obstacle-avoidance waypoint routing**, since routing must also hold during a drag and not only
at initial render — must be callable from webview-side JS on every `pointermove` tick, not only
at `renderGraphSvg`'s host-string-build time.

Exploration explicitly flagged the drift risk this creates. The mitigation is a requirement,
not a suggestion: **the anchor, routing, and obstacle-avoidance geometry is factored into one
pure, dependency-free module** that both `webview/graphView.ts` (initial SVG string build) and
`webview/index.ts` (live drag recomputation) import. It is compiled by **both**
`tsconfig.build.json` and `tsconfig.webview.json`, exactly the way `webview/graphView.ts`
itself already is today (see the archived design's "Build constraint" section). No bundler, no
new dependency. **Two implementations of this math must not exist.** Any design or task that
duplicates the anchor or routing formula into `index.ts` violates this proposal.

How far the live recomputation pass reaches — only the dragged node's own edges, or a full
re-route pass over every edge whose obstacle avoidance is affected by the moved box — is a
deliberate `sdd-design` call, weighed against per-tick cost. The shared-module requirement
holds either way.

### Decision 2 — dragged positions persist across refresh (decided)

Dragged positions survive a re-render, manual-refresh- or auto-refresh-triggered. This needs
new webview state: a per-node position-override map re-applied after every render.

- The map is **keyed by `node.id`** — the same identifier space as `data-node-id` — so an
  override reapplies correctly to a node that still exists after a refresh, whether it came
  back unchanged or modified.
- A node that no longer exists after a refresh (removed, filtered out, sectioned away) simply
  has its stale override **silently dropped/ignored**, never an error.
- Initial load and refresh load use the *same* map and the same re-apply step; there is no
  separate "first render" path. In this single-panel-per-comparison architecture there is
  exactly one graph per open panel, so in practice **every** re-render of the same comparison
  reapplies the same override map. Only a full navigation to a genuinely different node/graph,
  if that is ever reachable, would have no carried-over overrides to apply.

Whether the map is bounded/evicted and where it lives in webview state is an `sdd-design` call.

### Decision 3 — zoom resets on every render (decided)

Zoom/`viewBox` resets on every new render, initial and refresh alike. No persistence, no new
state. This matches the `expandedRuns`-resets-on-plain-render precedent from the archived
`untracked-files-live-refresh-and-styling` design: viewport is a transient view preference, not
user work-product like a draft or a hand-placed box.

### Request 1 — routing is improved, not proven optimal

The waypoint approach has no guaranteed-zero-crossings bound at a bounded waypoint count. It
must be specified and communicated as *substantially fewer crossings*, not *no crossings*,
especially approaching the existing node-count degradation threshold. Sibling ordering is the
cheap complement that lowers the routing burden rather than a second routing mechanism.

### Request 2 — drag must not steal the click

Click-to-navigate is existing, tested, e2e-covered behavior. The movement threshold exists to
protect it: a pointer sequence that never exceeds it must still navigate exactly as today.
`test/e2e/scenarios.ts`'s click-navigation scenario must stay green untouched.

### Request 3 — zoom stays inside the graph

`preventDefault()` is gated to events targeting `#graph`. A wheel event anywhere else in the
panel keeps scrolling normally. This is a behavioral guarantee, not an implementation detail.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `webview/` (new module) | New | Pure shared geometry: anchors, obstacle test, routed paths |
| `tsconfig.build.json`, `tsconfig.webview.json` | Modified | Dual-compile the new shared module |
| `webview/graphView.ts` | Modified | Calls shared geometry for edges; sibling ordering; `viewBox` on root `<svg>` |
| `webview/index.ts` | Modified | Pointer drag wiring, position-override map, wheel-zoom handler |
| `webview/styles.css` | Modified | Drag affordance (cursor/state) only, if needed |
| `measure()` / `place()` containment layout | Preserved | Ordering heuristic only; mechanism untouched |
| `KIND_STYLE`, status colors, `data-*` contract | None | Explicitly untouched |
| `src/`, analyzer, git, drafts, Docker, diff panel | None | Explicitly untouched |

## Test Impact (Strict TDD)

Unlike the two archived changes, this is **new interactive behavior, not a rewrite of an
existing tested contract** — no existing test rewrite is anticipated, only additions.

- New `graphView.test.ts` / shared-geometry-module cases: an edge whose straight path crosses
  an intervening box detours around it; a non-crossing fixture keeps the existing Bezier shape
  (regression proof for the majority case); sibling ordering produces the expected placement
  order; the shared module is unit-testable with no DOM.
- New `webviewDom.test.ts` drag cases, following the existing `click()` helper pattern with a
  new `drag()` helper: node `transform` updates during drag; attached edge `d` recomputes
  **live mid-drag**, not only at drop; a below-threshold sequence still fires click-to-navigate
  (disambiguation); a container drag re-anchors descendant edges via accumulated delta; a
  dragged position survives a simulated refresh; a stale override for a node absent after
  refresh is dropped without error.
- New `webviewDom.test.ts` wheel-zoom cases: `viewBox` changes as expected on a wheel tick;
  zoom-toward-cursor math targets the cursor position; `preventDefault()` fires only for events
  targeting `#graph`; `viewBox` resets on a new render.
- **Smoke-check first**: `jsdom`'s `PointerEvent` construction support in this project's pinned
  version is unverified. Verify it before committing test helpers to `PointerEvent`; the
  documented fallback is `MouseEvent` with explicit `clientX`/`clientY`.
- `test/e2e/scenarios.ts` click-navigation scenario must stay green untouched.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anchor/routing math drifts between `graphView.ts` and `index.ts` | High if unmanaged | One shared dual-compiled pure module, stated as a firm requirement (Decision 1); duplication is a design/task violation |
| Live per-tick re-routing with obstacle avoidance is too slow on large graphs | Medium | Design bounds the live pass scope (own-edges vs. full re-route) and the waypoint count; degrade near the existing node-count threshold |
| Waypoint routing still leaves some crossings | Medium | Specify as improved, not perfect; sibling ordering lowers the routing burden |
| Drag swallows click-to-navigate | Medium | Movement threshold + explicit disambiguation tests + untouched e2e scenario |
| Container drag leaves descendant edges mis-anchored | Medium | Accumulated-delta absolute recomputation, covered by an explicit nested-drag test |
| Wheel handler blocks panel scrolling | Medium | Listener and `preventDefault()` scoped to `#graph`; scoping test |
| `jsdom` cannot construct `PointerEvent` in the pinned version | Medium | Smoke-check before writing helpers; `MouseEvent` + `clientX`/`clientY` fallback |
| Stale position overrides accumulate across many refreshes | Low | Keyed by `node.id`, dropped silently when absent; bounding is a design call |

## Rollback Plan

Three independently revertible, presentation-layer-only slices. Reverting zoom removes the
`viewBox` and the wheel listener, restoring today's scroll-only behavior. Reverting drag removes
the pointer wiring and the override map — no persisted state exists anywhere outside the live
webview, so nothing to migrate or clean up. Reverting routing restores the straight fixed-anchor
Bezier and array-order sibling placement. No host-side change, no wire-protocol change, no
`data-*` contract change, no stored state, no migration. Host and webview ship together, so no
version skew is possible.

## Dependencies

- No new runtime dependencies, no bundler, no relaxation of the existing CSP.
- Requires the new shared geometry module to be compiled by both `tsconfig.build.json` and
  `tsconfig.webview.json`, matching the existing `webview/graphView.ts` arrangement.

## Success Criteria

- [ ] An edge whose straight path would cross an unrelated box routes around it; a
      non-crossing edge keeps its existing Bezier shape.
- [ ] Siblings inside a container are placed by an ordering heuristic, not raw array order.
- [ ] Anchor / routing / obstacle-avoidance geometry exists in exactly one module, imported by
      both `webview/graphView.ts` and `webview/index.ts`, dual-compiled.
- [ ] Any node can be dragged; its attached edges re-route live during the drag, not on drop.
- [ ] Dragging a container moves its nested children and correctly re-anchors their edges.
- [ ] A pointer sequence below the movement threshold still navigates, exactly as today.
- [ ] Dragged positions survive a manual or automatic refresh, keyed by `node.id`; a stale
      override for a node that no longer exists is dropped silently.
- [ ] Wheel over `#graph` zooms toward the cursor via `viewBox`; wheel elsewhere in the panel
      scrolls normally.
- [ ] Zoom resets on every render, initial and refresh alike.
- [ ] `KIND_STYLE`, the outline-only/status-color scheme, the containment layout mechanism, and
      the `data-*` contract are unchanged; `webview/index.ts` click-to-navigate and the e2e
      click scenario pass untouched.
