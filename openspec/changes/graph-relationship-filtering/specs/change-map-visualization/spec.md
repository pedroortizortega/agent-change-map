# Delta for Change Map Visualization

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
provenance additions, and to edge routing, sibling ordering, dragging, and
zoom; now also covers ancestor-containment suppression and vintage
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

## ADDED Requirements

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
