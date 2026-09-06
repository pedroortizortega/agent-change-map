# Delta for Change Map Visualization

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Draw directional import and call edges

Resolved `import` and `call` relationships MUST be drawn as curved lines from
the source node (importer/caller) with an arrowhead at the destination node,
using the existing `marker-end` arrowhead setup. `import` and `call` MUST use
mutually distinct colors. `contains` MUST NOT be drawn as an edge; containment
is expressed only via geometric nesting.

(Previously: edges were drawn as sharp right-angle elbow paths instead of
curves.)

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

### Requirement: Preserve node and edge data attribute contract

The diagram MUST preserve `data-node-id`, `data-edge-index`, `data-node-kind`,
`data-change-status`, `data-edge-kind`, and `data-resolution` with their
existing names, values, and placement, so `webview/index.ts` click-to-navigate
needs no changes. This contract MUST hold across a manual or automatic
refresh and MUST NOT be altered by the addition of tracked/untracked
provenance styling.

(Previously: scoped only to the nested/styled layout change; now also covers
refresh and provenance additions.)

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
