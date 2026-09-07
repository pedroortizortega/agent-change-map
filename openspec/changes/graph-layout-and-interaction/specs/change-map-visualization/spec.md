# Delta for Change Map Visualization

Deviation note: this delta exceeds the 650-word phase budget. The phase
brief required eight coverage items (routing, sibling ordering, drag with
live re-routing, container drag, position persistence, scoped wheel-zoom,
zoom-reset-on-render, preservation of styling/layout/`data-*`) each resolved
with testable scenarios; precedent is the accepted budget deviation in this
same change's `design.md`.

## MODIFIED Requirements

### Requirement: Draw directional import and call edges

Resolved `import` and `call` relationships MUST be drawn as curved lines from
the source node (importer/caller) with an arrowhead at the destination node,
using the existing `marker-end` arrowhead setup. `import` and `call` MUST use
mutually distinct colors. `contains` MUST NOT be drawn as an edge; containment
is expressed only via geometric nesting. When the direct path between an
edge's source and target anchors would cross an intervening node box (any box
that is not the edge's own source or target), the path MUST route around it
with a bounded number of detour waypoints instead of crossing it. Routing
MUST degrade gracefully: it is not required to guarantee zero crossings, only
to route substantially fewer of them than a direct path. A path with no
intervening box MUST render identically to the direct curve rendered before
this routing behavior existed.

(Previously: edges were a fixed-anchor curve with no obstacle awareness; any
intervening box was crossed without detour.)

#### Scenario: Resolved import and call edges

- GIVEN a resolved `import` edge and a resolved `call` edge both in view
- WHEN the diagram is rendered
- THEN each is a curved line from source to target with an arrowhead at the
  target, and the two edge kinds use different colors

#### Scenario: Containment draws no edge

- GIVEN an entity nested inside its container
- WHEN the diagram is rendered
- THEN no line is drawn between them for the `contains` relationship

#### Scenario: Edge path is curved, not an elbow

- GIVEN an edge connecting two nodes that are not vertically or horizontally
  aligned
- WHEN the edge's path is inspected
- THEN it renders as a smooth curve rather than a sequence of right-angle
  segments

#### Scenario: Non-crossing edge is unaffected by routing

- GIVEN an edge whose direct source-to-target path does not cross any other
  node box
- WHEN the diagram is rendered
- THEN the edge follows the same direct curve as before routing existed

#### Scenario: Crossing edge detours around an intervening box

- GIVEN an edge whose direct source-to-target path would cross an unrelated
  node box
- WHEN the diagram is rendered
- THEN the path inserts a bounded number of waypoints that route around that
  box instead of crossing through it

### Requirement: Preserve node and edge data attribute contract

The diagram MUST preserve `data-node-id`, `data-edge-index`, `data-node-kind`,
`data-change-status`, `data-edge-kind`, and `data-resolution` with their
existing names, values, and placement, so `webview/index.ts` click-to-navigate
needs no changes. This contract MUST hold across a manual or automatic
refresh and MUST NOT be altered by the addition of tracked/untracked
provenance styling. The dashed-container/solid-entity stroke convention, the
outline-only/status-color stroke scheme, and the geometric containment layout
mechanism MUST also remain unaffected by edge routing, sibling ordering, node
dragging, or zoom.

(Previously: scoped to the nested/styled layout change, refresh, and
provenance additions; now also covers edge routing, sibling ordering,
dragging, and zoom.)

#### Scenario: Click-to-navigate unaffected

- GIVEN a diagram rendered under the new nested, styled layout
- WHEN the user clicks a node or edge
- THEN the existing click-to-navigate handler reads the same attributes
  unmodified

#### Scenario: Contract holds after a refresh

- GIVEN a panel that has been refreshed, manually or automatically
- WHEN the user clicks a node or edge in the reloaded graph
- THEN the same `data-*` attributes are present and click-to-navigate behaves
  unchanged

#### Scenario: Provenance styling does not alter data attributes

- GIVEN a node rendered with a tracked/untracked provenance indicator
- WHEN its markup is inspected
- THEN the existing `data-*` attributes are present unmodified

#### Scenario: Styling and layout survive routing, dragging, and zoom

- GIVEN a diagram rendered with obstacle-routed edges, ordered siblings, a
  dragged node, and an active zoom level
- WHEN its markup is inspected
- THEN the stroke convention, outline-only/status-color scheme, and
  containment layout remain unchanged, and every `data-*` attribute is
  present with its original name, value, and placement

## ADDED Requirements

### Requirement: Order siblings within a container by relationship

Siblings inside a container MUST be ordered by a deterministic heuristic that
reflects the relationships (non-`contains` edges) between them, rather than
by raw `graph.nodes` insertion order. When siblings within a bucket have no
such relationships to each other, the resulting order MUST be identical to
their original array order.

#### Scenario: Related siblings are ordered by their relationship

- GIVEN siblings inside a container connected by a non-`contains` edge
- WHEN the diagram is rendered
- THEN their placement order reflects that relationship rather than raw
  array order

#### Scenario: Unrelated siblings keep array order

- GIVEN siblings inside a container with no non-`contains` edges among them
- WHEN the diagram is rendered
- THEN their placement order is identical to today's array order

### Requirement: Drag a node to reposition it

Every node MUST be draggable via a pointer sequence on its box. A pointer
sequence whose total movement stays below a small movement threshold MUST
still trigger the existing click-to-navigate behavior, unaffected. A pointer
sequence whose movement exceeds the threshold MUST update the node's
rendered position and MUST recompute and update the paths of its attached
edges live, on every pointer-move tick during the drag, not only when the
drag ends.

#### Scenario: Below-threshold pointer sequence still navigates

- GIVEN a pointer-down and pointer-up on a node with movement below the
  threshold
- WHEN the sequence completes
- THEN the existing click-to-navigate behavior fires, exactly as before this
  capability existed

#### Scenario: Above-threshold drag repositions the node and edges live

- GIVEN a pointer-down on a node followed by movement above the threshold
- WHEN the pointer continues moving before release
- THEN the node's position updates and the `d` path of each attached edge is
  recomputed and updated during the movement, not only at release

### Requirement: Dragging a container repositions its descendants

Dragging a container node MUST visually reposition every node nested inside
it, at any depth, and the edges attached to those descendants MUST re-anchor
to their new positions correctly.

#### Scenario: Container drag moves nested descendants and their edges

- GIVEN a container with nested descendant nodes, at least one of which has
  an attached edge
- WHEN the container is dragged
- THEN every descendant visually moves with the container and the descendant
  edge's path re-anchors to the descendant's new position

### Requirement: Dragged positions persist across a panel refresh

A node's dragged position MUST survive a panel refresh, whether manual or
automatic, keyed by the node's identity. If a node that had a dragged
position no longer exists after a refresh, that stale position MUST have no
effect and MUST NOT cause an error.

#### Scenario: Dragged position survives a refresh

- GIVEN a node dragged to a new position
- WHEN the panel refreshes, manually or automatically
- THEN the node reappears at its dragged position

#### Scenario: Stale position for a removed node is ignored

- GIVEN a node dragged to a new position
- WHEN a refresh occurs and that node no longer exists in the result
- THEN the stale position has no effect and no error occurs

### Requirement: Wheel-zoom scoped to the graph area

The graph MUST support zooming via mouse wheel input scoped to the graph
area only, zooming toward the cursor position. Wheel input outside the graph
area MUST be unaffected by this capability and MUST preserve normal scroll
behavior elsewhere in the panel.

#### Scenario: Wheel over the graph zooms toward the cursor

- GIVEN the graph area is visible
- WHEN the user scrolls the wheel while the cursor is over the graph
- THEN the view zooms in or out centered on the cursor's position

#### Scenario: Wheel outside the graph area scrolls normally

- GIVEN the graph area is visible alongside other panel content
- WHEN the user scrolls the wheel over content outside the graph area
- THEN normal scroll behavior occurs and the graph's zoom is unaffected

### Requirement: Zoom resets on every new graph render

The zoom level MUST reset to the default view whenever a new graph is
rendered, whether from an initial load or a refresh.

#### Scenario: Zoom resets after a refresh

- GIVEN the user has zoomed the graph in or out
- WHEN the panel refreshes and the graph re-renders
- THEN the view returns to the default zoom level

#### Scenario: Zoom resets on initial load

- GIVEN a panel opening a new comparison
- WHEN the graph renders for the first time
- THEN the view starts at the default zoom level
