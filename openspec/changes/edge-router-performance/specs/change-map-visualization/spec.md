# Delta for Change Map Visualization

## ADDED Requirements

### Requirement: Oversized-graph gate threshold reflects a measured render budget

The `OVERSIZED_THRESHOLDS` node/edge boundary MUST be set only to a value at
which a synthetic graph sized exactly at that boundary completes
`layoutGraph` (including edge routing) within 10000ms. `OVERSIZED_THRESHOLDS`
and `NESTED_LAYOUT_LIMITS` remain independent constants; this requirement
does not change `NESTED_LAYOUT_LIMITS`'s values.

#### Scenario: Graph at the oversized threshold completes within budget

- GIVEN a synthetic graph sized exactly at the `OVERSIZED_THRESHOLDS`
  node/edge boundary
- WHEN `layoutGraph` runs for that graph
- THEN it completes in under 10000ms

### Requirement: Nested layout threshold reflects a measured render budget

The existing `NESTED_LAYOUT_LIMITS` node/edge boundary MUST render within
2000ms for a synthetic graph sized exactly at that boundary. This is a
performance bound on the existing threshold; `NESTED_LAYOUT_LIMITS`'s values
are unchanged.

#### Scenario: Graph at the nested-layout threshold completes within budget

- GIVEN a synthetic graph sized exactly at the `NESTED_LAYOUT_LIMITS`
  node/edge boundary
- WHEN the diagram lays it out
- THEN rendering completes in under 2000ms

## MODIFIED Requirements

### Requirement: Preserve filtering, popup, navigation, and gates under React Flow

Scope/relationshipKind/changeStatus/vintage filtering, the relationship
details popup, click-to-navigate, the oversized-graph gate
(`OVERSIZED_THRESHOLDS`, values bound by the measured render budget — see
"Oversized-graph gate threshold reflects a measured render budget"), strict
CSP, and the `webviewProtocol.ts` contract MUST behave identically after
migration, with no CSP relaxation and no protocol change. The oversized gate
MUST remain a confirmation the user may accept to proceed and wait, not a
hard refusal.

(Previously: named fixed `OVERSIZED_THRESHOLDS {nodes:300, edges:600}` values
directly, with no stated performance basis for the numbers and no explicit
statement that the gate stays a confirmation rather than a refusal.)

#### Scenario: Filters, gate, and CSP continue to apply

- GIVEN filters applied and a result exceeding oversized thresholds
- WHEN the diagram renders under React Flow
- THEN filtering matches pre-migration behavior, the oversized gate still
  triggers, and the CSP meta tag stays byte-identical

#### Scenario: Oversized gate remains a confirmation, not a refusal

- GIVEN a result exceeding `OVERSIZED_THRESHOLDS`
- WHEN the oversized gate triggers
- THEN the user MAY confirm to proceed and render anyway; the graph is never
  hard-refused

### Requirement: Drag a node to reposition it

Every node MUST be draggable via a pointer sequence on its box. A pointer
sequence whose total movement stays below a small movement threshold MUST
still trigger the existing click-to-navigate behavior, unaffected. A pointer
sequence whose movement exceeds the threshold MUST update the node's
rendered position and MUST recompute and update the paths of its attached
edges live, on every pointer-move tick during the drag, not only when the
drag ends.

Committing the drag (pointer-up) MUST re-route only the edges attached to
the moved node, against the lane-occupancy state already computed by the
last full coordinated routing pass, rather than re-running full coordinated
routing over the entire edge set. This scoped re-route MUST complete within
500ms for a graph at or below the `OVERSIZED_THRESHOLDS` boundary, and MUST
NOT alter the paths of edges not attached to the moved node — an untouched
edge keeps whatever path the last full pass computed for it, regardless of
which routing algorithm produced that pass, since it is not being re-solved.
This is an internal-consistency property (this pass vs. its own prior
output), not a comparison against any specific historical routing
algorithm. If the scoped re-route cannot find a non-crossing path for one of
the moved node's edges, the system MUST fall back to a full coordinated
re-route of the entire edge set instead of accepting a crossing. The full
coordinated pass remains the sole routing path for host `"graph"` messages
and filter-change refreshes; only the drag-drop commit path is scoped.

**Conditional on `sdd-design` (Scope F, `edge-router-performance` proposal)**:
this requirement's scoped-reroute mechanism assumes scoped re-routing is
still adopted. `sdd-design` must confirm this against the new router's
measured numbers; if a full coordinated re-route of the entire edge set
already fits comfortably inside the 500ms drag-commit budget, `sdd-design`
may determine the scoped path is unnecessary complexity. That determination
is out of scope for this spec and would require a follow-up spec amendment
replacing this requirement's scoped-reroute language — it is not
preemptively resolved here.

(Previously: drop-commit behavior was unspecified beyond live path updates
during the drag itself; every commit implicitly re-ran full coordinated
routing over the entire edge set.)

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

#### Scenario: Drop commit re-routes only the moved node's edges within budget

- GIVEN a rendered graph following a full coordinated pass, with a node
  whose attached edges have already-computed paths
- WHEN the user drags that node above the movement threshold and releases it
- THEN only that node's attached edges are re-routed, within 500ms, and
  every other edge keeps the exact path computed by the last full pass

#### Scenario: Scoped re-route falls back to a full re-route when no valid path exists

- GIVEN a drop commit whose scoped re-route cannot find a non-crossing path
  for one of the moved node's edges
- WHEN the commit is processed
- THEN the system performs a full coordinated re-route of the entire edge
  set instead of accepting a crossing

### Requirement: Dragging a container repositions its descendants (preserved under absolute positions)

The base requirement — dragging a container node visually repositions every
node nested inside it, at any depth, with attached edges re-anchoring
correctly — MUST continue to hold under the absolute-position coordinate
model. Dragging a container MUST compute and persist an absolute override
for every descendant, not only the dragged container node itself, in the
same `positionOverrides` store used for individually-dragged nodes.

Committing the drag MUST re-route only the edges attached to the container
and its cascaded descendants, against the lane-occupancy state already
computed by the last full coordinated pass, rather than re-running full
coordinated routing over the entire edge set. This scoped re-route MUST
complete within 500ms for a graph at or below the `OVERSIZED_THRESHOLDS`
boundary. Edges outside the cascade MUST keep the exact path (byte-identical
`d` attribute) computed by the last full pass, since they are not
re-solved — this is a statement about internal consistency with that pass's
own prior output, not a comparison against any specific historical routing
algorithm; it holds regardless of which algorithm produced the last full
pass.

**Conditional on `sdd-design` (Scope F, `edge-router-performance` proposal)**:
as with "Drag a node to reposition it", this requirement's scoped-reroute
mechanism assumes scoped re-routing is still adopted for the cascade case.
If `sdd-design` determines a full coordinated re-route already fits the
500ms budget, this requirement's scoped-reroute language would need a
follow-up spec amendment rather than being preemptively resolved here.

(Previously specified against delta-from-base positions inside a nested SVG
`<g>` transform, with no re-route scope statement; restated against React
Flow's absolute-position model, and drop-commit re-routing is now scoped to
the cascade rather than the entire edge set.)

#### Scenario: Container drag persists descendant overrides

- GIVEN a container with nested descendants, at least one with an attached
  edge
- WHEN the container is dragged and released
- THEN every descendant's new absolute position is persisted individually,
  survives a refresh, and the descendant edge's path re-anchors correctly

#### Scenario: Container drop commit re-routes only the cascade's edges within budget

- GIVEN a container with nested descendants, at least one with an attached
  edge, following a full coordinated pass
- WHEN the container is dragged and released
- THEN only edges attached to the container and its descendants are
  re-routed, within 500ms, and edges outside the cascade keep the exact
  path computed by the last full pass

### Requirement: Draw directional import and call edges

The base requirement (see `openspec/specs/change-map-visualization/spec.md`)
— dash/color distinction between `import` and `call`, no edge for
`contains`, obstacle-avoiding detour routing with graceful degradation
(substantially fewer crossings than a direct path, not a guarantee of zero
in general), and ancestor/self-reference suppression — MUST continue to
hold after `edgePathsFor`'s coordinated multi-edge pass is rewritten around
the visibility-graph + A* architecture (see this change's proposal). The
base requirement's correctness contract is unchanged by *which* routing
algorithm produces it; only the implementation is replaced.

In addition, the coordinated routing pass MUST satisfy the following
properties, regardless of which algorithm computes it (these are the
properties `test/unit/coordinatedRouting.test.ts` is rewritten to verify per
this change's Scope G, and were previously only enforced as implementation
details of the old algorithm, not stated as spec-level properties):

- Routed (detoured) segments MUST be orthogonal (axis-aligned); a
  non-crossing edge's direct curve is unaffected by this, consistent with
  the existing "Non-crossing edge is unaffected by routing" scenario.
- A routed edge MUST maintain real clearance margins from obstacle boxes,
  labels, and container boundaries — not merely avoid exact overlap.
- Multiple edges touching the same node box MUST receive visually distinct
  port anchors and distinct lanes where they run parallel, so they remain
  individually distinguishable.
- Self-loop edges MUST render as a visible loop outside their own node box.
- Determinism means same-input-same-output reproducibility on repeated
  runs — it does NOT mean byte-identical output to any specific prior or
  alternative routing algorithm's `d` strings. A routing algorithm change is
  explicitly permitted to change edge paths, provided each individual
  algorithm is internally reproducible.
- When no local detour room exists for a routed edge, the system MUST fall
  back to a shared outer-lane route rather than failing to render the edge.

(Previously: the base requirement's detour/crossing-avoidance behavior was
implicitly tied to today's specific coordinated multi-edge algorithm, with
no explicit statement that determinism means reproducibility rather than
byte-identical-to-a-specific-algorithm output, and no explicit spec-level
statement of the orthogonal-segment, clearance-margin, port-lane,
self-loop, and outer-lane-fallback properties a replacement algorithm must
preserve.)

#### Scenario: Routing algorithm change preserves reproducibility, not byte-identical output

- GIVEN the same graph input routed twice by the coordinated pass
- WHEN the two resulting sets of edge paths are compared
- THEN they are identical to each other (same input, same output), but
  paths are NOT required to match any other routing algorithm's output for
  the same input

#### Scenario: Routed edge maintains clearance and orthogonal segments

- GIVEN an edge whose direct path would cross an obstacle and is therefore
  detoured
- WHEN the detoured path is inspected
- THEN every detour segment is axis-aligned and maintains the required
  clearance margin from the obstacles, labels, and container boundaries it
  routes around
</content>
