# Delta for Change Map Visualization

## MODIFIED Requirements

### Requirement: Expose affected differences

Changed nodes MUST expose left-vs-right diffs via real per-line classification
(added/removed/unchanged), computed host-side, not an affected-line-number
heuristic. The system MUST render two columns: added=green background,
removed=red, unchanged de-emphasized. Long unchanged runs MUST collapse behind
click-to-expand, keyed by line range, resetting on every new `sourcePair`
message. A side with no counterpart MUST keep two columns via an empty ghost
column. Diff computation MUST be unit-testable without a DOM.
(Previously: affected lines came from a prefix/suffix trim yielding only an
"affected lines: n, m" summary, with no classification or two-column view.)

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

## ADDED Requirements

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

Container kinds (package, module) MUST render dashed at the thinnest stroke weight
used. Entity kinds (class, function, method) MUST render solid, thicker than their
container, and class boxes MUST be visually distinct from function boxes.

#### Scenario: Container, entity, and kind styling

- GIVEN a container box, a nested class box, and a nested function box
- WHEN their strokes are compared
- THEN the container is dashed and thinnest; class and function are both solid,
  thicker than the container, and visually distinct from each other

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

Resolved `import` and `call` relationships MUST be drawn as lines from the source
node (importer/caller) with an arrowhead at the destination node. `import` and
`call` MUST use mutually distinct colors. `contains` MUST NOT be drawn as an edge;
containment is expressed only via geometric nesting.

#### Scenario: Resolved import and call edges

- GIVEN a resolved `import` edge and a resolved `call` edge both in view
- WHEN the diagram is rendered
- THEN each is a line from source to target with an arrowhead at the target, and
  the two edge kinds use different colors

#### Scenario: Containment draws no edge

- GIVEN an entity nested inside its container
- WHEN the diagram is rendered
- THEN no line is drawn between them for the `contains` relationship

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
`data-change-status`, `data-edge-kind`, and `data-resolution` with their existing
names, values, and placement, so `webview/index.ts` click-to-navigate needs no
changes.

#### Scenario: Click-to-navigate unaffected

- GIVEN a diagram rendered under the new nested, styled layout
- WHEN the user clicks a node or edge
- THEN the existing click-to-navigate handler reads the same attributes unmodified
