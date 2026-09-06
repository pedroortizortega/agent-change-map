# Proposal: Diff View and Graph Styling

## Intent

Make the Agent Change Map webview readable at a glance. Today the two things a user
looks at most — the Left/Right source comparison and the change-map graph — both fail to
communicate the change: the source panel shows two flat `<pre>` blobs plus an "Affected
lines: n, m" note derived from a prefix/suffix trim (it cannot say *what* was added or
removed), and the graph draws every entity as an identical filled rect in one vertical
stack with relationships printed as text lines underneath. Neither conveys structure or
direction. This change replaces both with real visual language: a per-line git-style diff,
and a nested, directional, kind-aware graph.

Success looks like: a user opens a node, immediately sees which lines were added and which
were removed, and reads the graph as "this function lives in this module, and this module
imports that one" without decoding text labels.

## Scope

### In Scope
- Host-side, real per-line diff (added/removed/unchanged ops) computed for the Left/Right
  source pair, replacing the prefix/suffix `affectedLinesForSources` heuristic.
- Extension of the `sourcePair` wire message with per-line diff ops.
- Two-column, per-line, git-diff-styled rendering of the source panel, with de-emphasized
  and collapsible unchanged runs.
- Rewrite of `renderGraphSvg` to a recursive containment layout: entities drawn
  geometrically inside their owning container box (`Entity.containerId`), at arbitrary
  depth (package → module → class → method).
- Kind-driven visual language: dash pattern and relative stroke width by `kind`.
- Outline-only node styling with stroke color driven by change status.
- Real drawn `<path>` edges with `<marker>` arrowheads for `import` and `call`, including a
  distinct treatment for `ambiguous` / `unresolved` edges.
- Rewriting the existing tests whose assertions encode the current flat/prefix-suffix
  contracts, plus new tests for nesting geometry, stroke/dash mapping, edge direction, and
  line-diff correctness.
- Click-to-expand state for collapsed unchanged diff runs, and a ghost empty column for a
  source pair with no counterpart on one side.
- A second, lower node-count threshold at which the nested graph layout degrades to the
  existing flat vertical stack, distinct from the existing large-map opt-in gate.

### Out of Scope
- Word-level (intra-line) diff highlighting inside a changed line — a good follow-up, not
  this pass.
- Any change to the Python analyzer, git state capture, draft/write-guard, or Docker
  execution paths. This change is webview rendering plus host-side diff computation only.
- Graph interaction changes: pan/zoom, collapse-on-click, re-layout controls, edge routing
  around obstacles.
- New filters, new sectioning behavior, or changes to `sectionScope`/`filterGraph` semantics.
- Adding a bundler or an npm-installed diff dependency.

## Capabilities

### Modified Capabilities
- `change-map-visualization`: the diagram gains geometric containment, kind-based visual
  encoding, and drawn directional relationships; the affected-diff surface gains real
  per-line add/remove/unchanged classification instead of an affected-line-number list.

### New Capabilities
None. Both requests refine an existing capability.

## Approach

### Request 1 — Diff-style source panel

Compute the diff where the two sides already meet: host-side in `src/`, in the
`inspectSources` handler of `src/webviewHost.ts`, next to (and replacing) the current
`affectedLinesForSources` prefix/suffix trim. A small Myers/LCS line-diff is **vendored** as
a plain, license-preserved `.ts` module rather than installed from npm — the webview is
built by `tsc -p tsconfig.webview.json` with no bundler and runs under a strict CSP
(`default-src 'none'`, nonce-scoped scripts, no remote resources), so third-party package
resolution is not available on the rendering side and a vendored port keeps the host and
webview honest about the same constraint.

The `sourcePair` message in `src/webviewProtocol.ts` gains per-line op data (each rendered
line tagged added / removed / unchanged, paired with its counterpart line number where one
exists). `affectedLines` remains derivable from the ops; whether it stays on the wire as a
compatibility field or is dropped is a design-phase call.

The webview renders a two-column view: added lines on a green background, removed lines on
a red background, unchanged lines de-emphasized. Long unchanged runs are collapsed behind a
click-to-expand affordance (a "⋯ N unchanged lines ⋯" row the user can click to reveal them
in place) — this requires the webview to hold expand/collapse state per collapsed run, keyed
by its line range, reset on every new `sourcePair` message. When one side has no counterpart
at all (a wholly added or removed entity), the panel keeps the two-column layout and renders
an empty "ghost" column on the side with nothing to show, preserving the left/right reading
rhythm instead of collapsing to a single full-width column. Rendering stays DOM-built (no
`innerHTML` of untrusted content) so the CSP posture is unchanged.

Rationale for host-side: the diff needs both sides' full content, which the host already
holds; computing there keeps the webview a pure renderer and makes the diff unit-testable
without a DOM.

### Request 2 — Hierarchical graph restyle

`renderGraphSvg` is rewritten around a recursive layout keyed on `Entity.containerId`. A
container's box is sized to enclose its laid-out children plus padding; children recurse the
same way. Nodes whose container is absent from the current filtered/sectioned view are laid
out as roots (loose top-level boxes), without a placeholder signaling a hidden parent.

**Size-based layout degradation (decided).** The existing "large map" opt-in gate
(`oversized`/`confirmOversized`) governs whether the graph renders at all above a node-count
threshold, but does not address a graph that renders yet whose *nested* layout becomes
unreadable (deep containment, many siblings per container). A second, lower threshold is
added: once the node count in the currently rendered view exceeds it, the nested layout
degrades to the current flat vertical stack (still outline-only, dash/stroke-width and
drawn edges preserved) rather than attempting deep geometric nesting. The exact threshold
value is an `sdd-design`/`sdd-tasks` call, informed by the existing `DTO_LIMITS`/oversized
constants already in `src/protocol.ts` and `webview/index.ts`.

**Visual encoding:**

| Aspect | Rule |
|---|---|
| Container kinds (package, module) | Dashed outline, thinnest stroke |
| Entity kinds (class, function, method) | Solid outline, thicker than their container; class and function mutually distinct |
| Fill | None. Outline-only for every box (**Decision B**) |
| Stroke color | Change color when added/removed/modified; gray when unchanged (**Decision B**) |
| Containment | Geometric nesting only — never a drawn edge (**Decision A**) |

**Decision A — edge directionality convention (decided).** Edges are drawn starting at the
source node (the importer/caller) and terminate in an arrowhead at the resolved target node
(the imported/called entity). `import` and `call` edges are given visually distinct colors
from each other. `contains` relationships are no longer drawn as edges at all: containment is
expressed purely by geometric nesting, so a `contains` relation contributes layout, not a line.

**Decision B — fill vs. outline (decided).** All boxes — containers and entities alike — are
outline-only with no fill. Stroke color carries change status: colored when the node is
added/removed/modified, gray when unchanged. This preserves the existing and correct
"changed gets color, unchanged stays neutral" scheme while removing the filled-rect look.

**Ambiguous and unresolved edges.** Today these are surfaced as orange italic text labels, and
that visibility must not be lost — an unresolved dynamic call must never render as if it were
a confirmed one. The proposed equivalent is a dashed line in the ambiguity color with **no**
arrowhead (no confirmed destination to point at), retaining the existing `<title>` tooltip and
`data-resolution` attribute. The exact visual (dashed vs. dotted, terminator shape, whether
ambiguous candidates fan out) is flagged as a `sdd-design` detail.

**Contract preservation.** `data-node-id` and `data-edge-index` attributes keep their exact
current names, values, and placement, because `webview/index.ts`'s click-to-navigate wiring
reads them. That wiring must require zero changes under this rewrite; any need to change it
is a signal the contract was broken. `data-node-kind`, `data-change-status`, `data-edge-kind`,
and `data-resolution` are likewise preserved.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/webviewHost.ts` | Modified | Real line diff replaces prefix/suffix affected-line trim |
| `src/` (new vendored module) | New | Myers/LCS line-diff port, license preserved |
| `src/webviewProtocol.ts` | Modified | `sourcePair` carries per-line diff ops |
| `webview/graphView.ts` | Rewritten | Nested layout, kind encoding, drawn directional edges |
| `webview/index.ts` + styles | Modified | Per-line diff DOM; graph click wiring unchanged |
| Analyzer / git / drafts / Docker | None | Explicitly untouched |

## Test Impact (Strict TDD)

The following churn is expected and intentional — these tests assert contracts this change
deliberately replaces. `sdd-tasks` must budget for rewriting them (RED on the new contract
before GREEN), not treat them as regressions to avoid:

- `test/unit/graphView.test.ts` (~L81-85) encodes the flat-stack "edges rendered as text
  below all nodes" assumption. Rewritten for nested geometry and drawn edges.
- `test/unit/webviewHost.test.ts` (~L109-122) asserts the prefix/suffix `affectedLines`
  contract. Rewritten for real diff ops.
- `test/unit/webviewDom.test.ts` (~L112-115) asserts the flat `<pre>` source rendering.
  Rewritten for per-line diff DOM.

New coverage required: child box geometrically contained within its parent's bounds;
dash-pattern and stroke-width per `kind`; outline-only (no fill) and stroke color per change
status; arrowhead present at the destination for resolved `import`/`call` and absent for
ambiguous/unresolved; `contains` contributing no drawn edge; orphaned node whose container is
filtered out (rendered as a loose root, no placeholder); layout degrading to the flat stack
above the new node-count threshold; `data-node-id`/`data-edge-index` stability; click-to-expand
toggling a collapsed unchanged run open/closed and resetting on a new `sourcePair` message;
ghost empty column when one side has no counterpart; and line-diff classification correctness
including empty side, identical sides, pure insertion, pure deletion, and one-side-missing.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Vendored diff surface larger than expected without a bundler | Medium | Spike-trim `vscode-diff`'s line computer; fall back to the smaller jsdiff `diffLines` port |
| Nested layout produces overlapping or oversized boxes on real graphs | Medium | Size containers from laid-out children; cover deep nesting and orphans in tests |
| Edge routing crosses node boxes and hurts readability | Medium | Simple elbow paths for the first pass; obstacle-aware routing stays out of scope |
| Silent break of `data-*` click-to-navigate contract | Low | Explicit attribute-stability tests; `webview/index.ts` must need zero changes |
| Ambiguity signal weakened by dropping text labels | Low | Keep `<title>` and `data-resolution`; distinct no-arrowhead dashed treatment |

## Rollback Plan

Both halves are presentation-layer and independently revertible. Reverting the graph half
restores the flat-stack renderer with no data-model impact. Reverting the diff half restores
the prefix/suffix affected-line computation; only the `sourcePair` message shape changes, and
host and webview ship together, so no version skew is possible. No stored state, no
migration.

## Dependencies

- A vendorable, license-compatible Myers/LCS line-diff implementation.
- No new runtime dependencies, no bundler, no relaxation of the existing CSP.

## Success Criteria

- [ ] The source panel classifies every line as added, removed, or unchanged and colors it
      accordingly; long unchanged runs are collapsed or de-emphasized.
- [ ] Diff ops are computed host-side and unit-tested without a DOM.
- [ ] Every entity is drawn geometrically inside its `containerId` owner, at any depth.
- [ ] Containers render dashed and thinnest; classes and functions render solid, thicker,
      and mutually distinct.
- [ ] Every box is outline-only; stroke is colored when changed and gray when unchanged.
- [ ] Resolved `import` and `call` edges are drawn lines with an arrowhead at the destination
      and mutually distinct colors; `contains` draws no edge.
- [ ] Ambiguous/unresolved edges remain visually distinguishable from resolved ones.
- [ ] `webview/index.ts` click-to-navigate works unchanged against the same `data-*` contract.
