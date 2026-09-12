# Delta for Change Map Visualization

## ADDED Requirements

### Requirement: Render the diagram via React Flow's node/edge data model

The webview MUST render the change map by mounting `<ReactFlow>` over a
`{id, position, parentId?, data}[]` node array and a typed edge array,
replacing the SVG string builder. Containment MUST stay visually correct via
the existing absolute-position layout; containers MUST be non-interactive
background nodes at absolute coordinates, not native React Flow parents.

#### Scenario: Diagram renders via React Flow

- GIVEN a result with nested containers and edges
- WHEN the webview renders
- THEN `<ReactFlow>` draws one node per entity/container at its computed
  position, with no SVG string assembled to produce markup

### Requirement: Animate a directional particle on every drawn edge

Every drawn edge — a resolved `import` or `call` with both endpoints in view
— MUST render a continuously moving directional particle, not gated on
hover/selection and not encoding traffic/weight. An ambiguous/unresolved
relationship is never drawn as a line (see "Distinguish ambiguous and
unresolved edges" below) and therefore has no particle.

#### Scenario: Particle animates on every drawn edge kind

- GIVEN resolved import and call edges both visible
- WHEN the diagram renders
- THEN each shows a moving directional particle without hover or selection

### Requirement: Source edge visuals from a single style config module

`webview/edgeStyleConfig.ts` MUST be the only module defining per-kind
stroke color reference, dash pattern, and particle parameters (radius, fill,
duration); no rendering component MAY inline these values. Colors MUST
resolve through `--acm-*` custom properties honoring `themeTokens`; exact
values are pending a separate palette decision, not fixed here.

#### Scenario: No inline per-kind visuals in rendering components

- GIVEN the edge rendering component's source
- WHEN inspected for per-kind color, dash, or particle literals
- THEN none exist outside `edgeStyleConfig.ts`

### Requirement: Highlight the connected subgraph on hover

Hovering a node or edge MUST highlight it plus every directly connected
node/edge (incomers, outgoers, connected edges); non-connected elements MUST
be de-emphasized (reduced opacity) while hover is active, and restored when
hover ends.

#### Scenario: Hovering a node highlights its connected subgraph

- GIVEN a node with incoming and outgoing edges
- WHEN the user hovers it
- THEN it, its edges, and their endpoints highlight while others de-emphasize

#### Scenario: Hover ends restore normal styling

- GIVEN a highlighted hover state
- WHEN the pointer leaves the hovered element
- THEN all elements return to normal styling

### Requirement: Preserve filtering, popup, navigation, and gates under React Flow

Scope/relationshipKind/changeStatus/vintage filtering, the relationship
details popup, click-to-navigate, the oversized-graph gate
(`OVERSIZED_THRESHOLDS {nodes:300, edges:600}`), strict CSP, and the
`webviewProtocol.ts` contract MUST behave identically after migration, with
no CSP relaxation and no protocol change.

#### Scenario: Filters, gate, and CSP continue to apply

- GIVEN filters applied and a result exceeding oversized thresholds
- WHEN the diagram renders under React Flow
- THEN filtering matches pre-migration behavior, the oversized gate still
  triggers, and the CSP meta tag stays byte-identical

## MODIFIED Requirements

### Requirement: Draw directional import and call edges

Resolved `import` and `call` relationships MUST be drawn as curved lines from
the source node with an arrowhead at the destination. `import` and `call`
MUST be mutually distinguishable by BOTH stroke color AND dash pattern:
`import` MUST render dashed, `call` MUST render solid. `contains` MUST NOT be
drawn as an edge. When the direct path would cross an intervening node box,
it MUST route around it with a bounded number of detour waypoints; routing
MUST degrade gracefully (fewer crossings, not zero-guaranteed) and a path
with no intervening box MUST render as the direct curve. An edge whose
source is a transitive `containerId` ancestor of its target MUST NOT be
drawn; a same-file peer edge not in an ancestor/descendant relationship MUST
still be drawn.

(Previously: `import`/`call` were distinguished by color alone, no
dash-pattern distinction required.)

#### Scenario: Import and call edges are dash- and color-distinct

- GIVEN a resolved `import` edge and a resolved `call` edge
- WHEN the diagram renders
- THEN `import` is dashed, `call` is solid, colors differ, and both have an
  arrowhead at the target

#### Scenario: Containment draws no edge

- GIVEN an entity nested inside its container
- WHEN the diagram renders
- THEN no line is drawn for the `contains` relationship

#### Scenario: Edge path is curved, not an elbow

- GIVEN two misaligned nodes connected by an edge
- WHEN the path is inspected
- THEN it renders as a smooth curve, not right-angle segments

#### Scenario: Non-crossing edge is unaffected by routing

- GIVEN an edge whose direct path crosses no other node box
- WHEN the diagram renders
- THEN it follows the same direct curve as before routing existed

#### Scenario: Crossing edge detours around an intervening box

- GIVEN an edge whose direct path would cross an unrelated box
- WHEN the diagram renders
- THEN it inserts bounded waypoints routing around that box

#### Scenario: Self-reference edges are hidden

- GIVEN a call edge whose source is the target's direct or transitive
  `containerId` ancestor
- WHEN the diagram renders
- THEN no line is drawn for that edge

#### Scenario: Same-file peer edge remains visible

- GIVEN a call edge between siblings with no ancestor/descendant relation
- WHEN the diagram renders
- THEN the edge is drawn as for any other resolved call

### Requirement: Distinguish ambiguous and unresolved edges

An ambiguous or unresolved relationship MUST NOT be drawn as a line: it has
no resolved target node to connect to, so it cannot be a React Flow edge. It
MUST continue to surface only through the source node's relationship
indicator (see "Preserve filtering, popup, navigation, and gates" above),
retaining `<title>` and `data-resolution` on the indicator's underlying
metadata element. It gets no arrowhead, no dash pattern, and no particle.

(Corrects the pre-existing base spec's "renders as a dashed line with no
arrowhead" language, which does not match `renderEdge`'s actual behavior —
`renderEdge` returns a metadata-only element with no `<path>` whenever the
target box is unavailable, i.e. for every ambiguous/unresolved relationship.
This is a pre-existing spec/code drift predating this change, corrected here
rather than carried forward. No functional behavior changes.)

#### Scenario: Ambiguous or unresolved relationship has no drawn edge

- GIVEN a call or import relationship whose target could not be resolved, or
  resolved outside the current view
- WHEN the diagram renders
- THEN no line, arrowhead, or particle is drawn for it; the relationship
  indicator on the source node discloses it instead, and `<title>` plus
  `data-resolution` remain available on that indicator's metadata

### Requirement: Preserve node and edge data attribute contract

The diagram MUST preserve `data-node-id`, `data-edge-index`,
`data-node-kind`, `data-change-status`, `data-edge-kind`, and
`data-resolution` with existing names, values, and placement on the DOM
React Flow renders, so click-to-navigate needs no changes. This MUST hold
across refresh and MUST NOT be altered by provenance styling, edge routing,
sibling ordering, dragging, zoom, ancestor-containment suppression, vintage
filtering, or the React Flow engine itself.

(Previously: contract defined against hand-rolled SVG markup; now restated
against React Flow's rendered DOM with no change to names/values/placement.)

#### Scenario: Click-to-navigate unaffected

- GIVEN a diagram rendered by React Flow
- WHEN the user clicks a node or edge
- THEN the existing click-to-navigate handler reads the same attributes

#### Scenario: Contract holds after a refresh

- GIVEN a panel refreshed manually or automatically
- WHEN the user clicks a node or edge in the reloaded graph
- THEN the same `data-*` attributes are present and navigation is unchanged

#### Scenario: Attributes present on React-Flow-rendered elements

- GIVEN a node/edge rendered via React Flow's custom components
- WHEN their DOM is inspected
- THEN all required `data-*` attributes are present with original values

### Requirement: Dragged positions persist across a panel refresh

A node's dragged position MUST survive a panel refresh, keyed by node
identity, stored as an absolute `{x, y}` position (not a delta from base
layout). A stale position for a removed node MUST have no effect and MUST
NOT error. A pre-migration legacy delta-based (`{dx, dy}`) override MUST be
treated as unreadable and discarded, not converted, on first load after
upgrade.

(Previously: stored as a `{dx, dy}` delta; no legacy discard behavior
defined.)

#### Scenario: Dragged position survives a refresh

- GIVEN a node dragged to a new position
- WHEN the panel refreshes
- THEN the node reappears at its dragged absolute position

#### Scenario: Stale position for a removed node is ignored

- GIVEN a node dragged to a new position
- WHEN a refresh occurs and that node no longer exists
- THEN the stale position has no effect and no error occurs

#### Scenario: Legacy delta-based override is discarded on upgrade

- GIVEN a persisted override in the pre-migration `{dx, dy}` format
- WHEN the panel loads after upgrading
- THEN the override is discarded; the node renders at its default computed
  position, with no error and no attempted conversion

### Requirement: Dragging a container repositions its descendants (preserved under absolute positions)

The base requirement — dragging a container node visually repositions every
node nested inside it, at any depth, with attached edges re-anchoring
correctly — MUST continue to hold under the absolute-position coordinate
model. Dragging a container MUST compute and persist an absolute override for
every descendant, not only the dragged container node itself, in the same
`positionOverrides` store used for individually-dragged nodes.

(Previously specified against delta-from-base positions inside a nested SVG
`<g>` transform; restated against React Flow's absolute-position model. No
change to the observed behavior.)

#### Scenario: Container drag persists descendant overrides

- GIVEN a container with nested descendants, at least one with an attached
  edge
- WHEN the container is dragged and released
- THEN every descendant's new absolute position is persisted individually,
  survives a refresh, and the descendant edge's path re-anchors correctly
</content>
