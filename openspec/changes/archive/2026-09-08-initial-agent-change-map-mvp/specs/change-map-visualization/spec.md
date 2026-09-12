# Specification: Change Map Visualization

## Requirements

### Requirement: Expose affected differences

Changed nodes MUST expose left-vs-right diffs via real per-line classification
(added/removed/unchanged), computed host-side, not an affected-line-number
heuristic. The system MUST render two columns: added=green background,
removed=red, unchanged de-emphasized. Long unchanged runs MUST collapse behind
click-to-expand, keyed by line range, resetting on every new `sourcePair`
message. A side with no counterpart MUST keep two columns via an empty ghost
column. Diff computation MUST be unit-testable without a DOM.

#### Scenario: Inspect a modified node

- GIVEN a node associated with a modified entity
- WHEN the user requests its difference
- THEN every line is classified added/removed/unchanged and colored accordingly

#### Scenario: Inspect a one-sided entity

- GIVEN an entity exists in only one selected state
- WHEN its difference is requested
- THEN it shows as added or removed with a ghost empty column on the other side

#### Scenario: Expand a collapsed unchanged run

- GIVEN a long unchanged run collapsed behind a summary row
- WHEN the user clicks the summary row
- THEN the unchanged lines are revealed in place

#### Scenario: Collapse state resets on new source pair

- GIVEN expand/collapse state for one source pair
- WHEN a new `sourcePair` message arrives for a different node
- THEN the prior state does not carry over

#### Scenario: Diff computed without a DOM

- GIVEN two full text sides of a source pair
- WHEN the host computes per-line diff ops
- THEN classification is verifiable by a unit test with no rendering environment

### Requirement: Render entities nested inside their container

The diagram MUST lay out each entity geometrically inside the box of its owning
`containerId`, at arbitrary depth (package containing module containing class
containing method). A container's box MUST enclose its laid-out children.

#### Scenario: Nested entity inside its container

- GIVEN an entity with a `containerId` referencing another entity in view
- WHEN the diagram is rendered
- THEN the entity's box is drawn within its container's geometric bounds

#### Scenario: Orphaned node with filtered-out container

- GIVEN an entity whose `containerId` refers to a container excluded from view
- WHEN the diagram is rendered
- THEN the entity renders as a loose root-level box with no placeholder

### Requirement: Encode kind via dash pattern and stroke width

Container kinds (package, module) MUST render dashed at the thinnest stroke
weight used. Entity kinds (class, function, method) MUST render solid, thicker
than their container, and MUST be pairwise visually distinct from each other —
class, function, and method boxes MUST each be distinguishable by their own
stroke treatment, not only class distinguished from the other two.

(Previously: only required class boxes to be visually distinct from function
boxes, leaving function and method rendered identically.)

#### Scenario: Container, entity, and kind styling

- GIVEN a container box, a nested class box, and a nested function box
- WHEN their strokes are compared
- THEN the container is dashed and thinnest; class and function are both
  solid, thicker than the container, and visually distinct from each other

#### Scenario: Function and method are visually distinct

- GIVEN a nested function box and a nested method box
- WHEN their strokes are compared
- THEN they use different stroke treatments and are distinguishable from each
  other

### Requirement: Render boxes outline-only with change-status stroke color

Every box MUST be outline-only with no fill. Stroke color MUST reflect change
status: colored when added/removed/modified, gray when unchanged.

#### Scenario: Unchanged node styling

- GIVEN a node with unchanged status
- WHEN it is rendered
- THEN its box has no fill and a gray stroke

#### Scenario: Modified node styling

- GIVEN a node with added, removed, or modified status
- WHEN it is rendered
- THEN its box has no fill and a stroke in the corresponding change color

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
this routing behavior existed. An edge whose source is a transitive
ancestor container of its target, via the `containerId` chain, MUST NOT be
drawn on the canvas; a same-file edge between peers that are not in an
ancestor/descendant relationship MUST still be drawn.

(Previously: edges were a fixed-anchor curve with no obstacle awareness, no
ancestor-containment check, and no same-file peer distinction; any
intervening box was crossed without detour, and every resolved edge —
including a container-to-descendant self-reference — was drawn.)

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

#### Scenario: Direct-parent self-reference edge is hidden

- GIVEN a module-level call edge whose source is a class or function defined
  directly inside that same module (the module is the edge target's direct
  `containerId` parent)
- WHEN the diagram is rendered
- THEN no line is drawn for that edge on the canvas

#### Scenario: Transitive-ancestor self-reference edge is hidden

- GIVEN a call edge whose source is a container that is an ancestor of the
  edge's target through a multi-step `containerId` chain (for example a
  package containing a module containing a class containing the target
  method, where the edge's source is the package), not the target's direct
  parent
- WHEN the diagram is rendered
- THEN no line is drawn for that edge on the canvas

#### Scenario: Same-file peer edge remains visible

- GIVEN a call edge between two sibling functions defined in the same file,
  neither of which is an ancestor or descendant of the other via `containerId`
- WHEN the diagram is rendered
- THEN the edge is drawn on the canvas as it would be for any other resolved
  call

### Requirement: Distinguish ambiguous and unresolved edges

An ambiguous or unresolved relationship MUST render as a dashed line in the
ambiguity color with no arrowhead, retaining `<title>` and `data-resolution`.

#### Scenario: Ambiguous call rendering

- GIVEN a call relationship whose target could not be resolved
- WHEN the diagram is rendered
- THEN the edge is dashed in the ambiguity color, has no arrowhead, and keeps
  `<title>` and `data-resolution`

### Requirement: Degrade nested layout above a size threshold

The system MUST define a node-count threshold, distinct from the existing
oversized whole-map confirmation gate, above which nested layout degrades to the
flat vertical stack while preserving outline styling, kind encoding, and edges.

#### Scenario: Layout at and above the nesting threshold

- GIVEN a rendered view at or below versus above the nesting threshold
- WHEN the diagram is rendered
- THEN it lays out nested containers at or below the threshold, and a flat
  vertical stack above it

### Requirement: Preserve node and edge data attribute contract

The diagram MUST preserve `data-node-id`, `data-edge-index`, `data-node-kind`,
`data-change-status`, `data-edge-kind`, and `data-resolution` with their
existing names, values, and placement, so `webview/index.ts` click-to-navigate
needs no changes. This contract MUST hold across a manual or automatic
refresh and MUST NOT be altered by the addition of tracked/untracked
provenance styling. The dashed-container/solid-entity stroke convention, the
outline-only/status-color stroke scheme, and the geometric containment layout
mechanism MUST also remain unaffected by edge routing, sibling ordering, node
dragging, or zoom. Neither the ancestor-containment edge suppression nor the
vintage filter MUST alter these attributes' names, values, or placement on
any edge or node that remains displayed.

(Previously: scoped to the nested/styled layout change, refresh, and
provenance additions; then also to edge routing, sibling ordering, dragging,
and zoom; now also to ancestor-containment suppression and vintage
filtering.)

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

#### Scenario: Data attributes unaffected by suppression and vintage filtering

- GIVEN a diagram rendered with ancestor-containment edges suppressed and a
  vintage filter applied
- WHEN a still-displayed node or edge's markup is inspected
- THEN its `data-*` attributes are present with their original names,
  values, and placement

### Requirement: Refresh a panel in place

The system MUST support refreshing an open panel without closing and
reopening it, re-running capture, diff, and analysis for the panel's original
selection and reloading the rendered graph with the result.

#### Scenario: Manual refresh re-runs the pipeline

- GIVEN an open panel showing a comparison for a selection
- WHEN the user triggers the refresh action
- THEN capture, diff, and analysis re-run for that same selection and the
  graph reloads with the updated result

#### Scenario: Manual refresh is always available

- GIVEN an open panel
- WHEN the user looks for a way to update it
- THEN the manual refresh action is available regardless of any auto-refresh
  setting

### Requirement: Opt-in automatic refresh respects pending user decisions

Automatic refresh, driven by file-system changes, MUST be off by default and
MUST require explicit user opt-in. While enabled, it MUST defer or skip a
refresh cycle whenever a write/run confirmation is pending or a Docker run is
active, and MUST NOT discard or invalidate that pending decision.

#### Scenario: Auto-refresh disabled by default

- GIVEN a panel with no explicit auto-refresh opt-in
- WHEN a watched file changes
- THEN no automatic refresh occurs

#### Scenario: Auto-refresh deferred during pending confirmation

- GIVEN auto-refresh is enabled and a write/run confirmation dialog is pending
- WHEN a watched file changes
- THEN the refresh is deferred or skipped and the pending confirmation is
  unaffected

#### Scenario: Auto-refresh deferred during an active Docker run

- GIVEN auto-refresh is enabled and a Docker run is active
- WHEN a watched file changes
- THEN the refresh is deferred or skipped until the run completes

### Requirement: Refresh preserves panel state

Any refresh, manual or automatic, MUST preserve diff-panel collapse state and
unsaved draft-editor content across the reload.

#### Scenario: Collapse state survives refresh

- GIVEN a diff panel with a collapsed unchanged-line run
- WHEN the panel refreshes
- THEN the collapsed state is unchanged after the refresh

#### Scenario: Unsaved draft survives refresh

- GIVEN an unsaved edit in a draft editor
- WHEN the panel refreshes
- THEN the unsaved draft content is unchanged after the refresh

### Requirement: Snapshot store is bounded

The store used to retain captured snapshots across refreshes MUST enforce a
bound so repeated refreshes do not grow it without limit.

#### Scenario: Repeated refreshes do not grow storage unbounded

- GIVEN a panel refreshed many times in succession
- WHEN each refresh stores a new snapshot
- THEN older entries are evicted so the store size stays bounded

### Requirement: SVG text declares an explicit font-family

Every SVG `<text>` element rendered by the graph MUST declare an explicit
`font-family` so labels do not depend on browser/webview default font
resolution.

#### Scenario: Rendered label has an explicit font-family

- GIVEN a rendered graph containing text labels
- WHEN a `<text>` element is inspected
- THEN it declares an explicit `font-family` value

### Requirement: Distinguish tracked and untracked node provenance

A node originating from an untracked file MUST be visually distinguishable
from a node originating from a tracked file, using a visual channel additive
to, and not replacing or obscuring, the existing change-status stroke color.

#### Scenario: Untracked node is visually distinct

- GIVEN a node from an untracked file and a node from a tracked file with the
  same change status
- WHEN both are rendered
- THEN they are visually distinguishable by provenance while both still show
  their shared change-status color

#### Scenario: Provenance indicator does not obscure change status

- GIVEN a node from an untracked file with a non-unchanged status
- WHEN it is rendered
- THEN its change-status stroke color remains identifiable alongside the
  provenance indicator

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

### Requirement: Relationship indicator counts and the details popup agree with the canvas on suppressed edges

The relationship-indicator counts rendered per node and the relationship
details popup MUST both exclude an edge suppressed by the ancestor-containment
rule, using the same shared predicate the canvas uses to decide whether an
edge is drawn. A same-file peer edge that is not suppressed MUST be counted
and listed by both.

#### Scenario: Suppressed edge absent from indicator counts

- GIVEN a call edge whose source is a transitive `containerId` ancestor of
  its target
- WHEN the relationship-indicator count for the target node is computed
- THEN that edge is not included in the count

#### Scenario: Suppressed edge absent from the details popup

- GIVEN a call edge whose source is a transitive `containerId` ancestor of
  its target
- WHEN the relationship details popup for either endpoint is opened
- THEN that edge does not appear in the popup's relationship list

#### Scenario: Same-file peer edge counted and listed

- GIVEN a same-file peer edge that is not an ancestor/descendant relationship
- WHEN the relationship-indicator count and the details popup are computed
  for either endpoint
- THEN the edge is included in the count and appears in the popup's list

### Requirement: Per-edge vintage reflects presence on each comparison side

Each displayed edge MUST carry a vintage of `"current"` or `"removed"`,
computed by comparing the edge's identity key against the left (original) and
right (worktree) comparison sides independently of whether the edge's source
content can be resolved (for example when `store.getFileContent` fails for
that edge's file). An edge present on the right side, or present on both
sides, MUST be `"current"`. An edge present only on the left side MUST be
`"removed"`. An edge whose `span.path` is in the comparison's untracked-paths
list MUST be `"current"` regardless of which side(s) produced it.

#### Scenario: Edge present only on the worktree side is current

- GIVEN an edge that exists in the right (worktree) graph but has no matching
  key in the left (original) graph
- WHEN its vintage is computed
- THEN it is `"current"`

#### Scenario: Edge present on both sides is current

- GIVEN an edge whose identity key matches an edge present in both the left
  and right graphs
- WHEN its vintage is computed
- THEN it is `"current"`

#### Scenario: Edge present only on the original side is removed

- GIVEN an edge that exists in the left (original) graph but has no matching
  key in the right (worktree) graph
- WHEN its vintage is computed
- THEN it is `"removed"`

#### Scenario: Untracked-file edge is current regardless of originating side

- GIVEN an edge whose `span.path` is in the comparison's untracked-paths list
  and whose identity key matches an edge present only on the left side
- WHEN its vintage is computed
- THEN it is `"current"`

#### Scenario: Vintage is correct when source content cannot be resolved

- GIVEN an edge whose file content cannot be resolved by the snapshot store
  for either comparison side
- WHEN its vintage is computed
- THEN the vintage is still correctly `"current"` or `"removed"` per the
  left/right/untracked comparison rules above, unaffected by the content
  resolution failure

### Requirement: Vintage toolbar filter defaults to current-only

The toolbar MUST expose a checkbox-group filter with two independent
checkboxes, "Current" and "Removed", governing which edge vintages are
displayed. "Current" MUST be checked and "Removed" MUST be unchecked by
default. Unchecking a vintage's checkbox MUST hide edges of that vintage from
the canvas, the relationship-indicator counts, and the details popup;
checking it MUST restore them. Node rendering and the change-status/section
filters MUST be unaffected by the vintage filter.

#### Scenario: Default filter state shows current, hides removed

- GIVEN a panel opened with both current and removed edges present
- WHEN the diagram first renders
- THEN "Current" is checked, "Removed" is unchecked, and only current edges
  are drawn

#### Scenario: Checking "Removed" restores original-only edges

- GIVEN the default filter state with a removed edge present but hidden
- WHEN the user checks "Removed"
- THEN that edge appears on the canvas, in indicator counts, and in the
  details popup

#### Scenario: Unchecking "Current" hides worktree edges

- GIVEN the default filter state with a current edge displayed
- WHEN the user unchecks "Current"
- THEN that edge is hidden from the canvas, indicator counts, and the
  details popup

#### Scenario: Both vintages unchecked hides all edges

- GIVEN a diagram with both current and removed edges present
- WHEN the user unchecks both "Current" and "Removed"
- THEN no edges are drawn on the canvas
