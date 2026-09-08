# Design: Graph Relationship Filtering

## Technical Approach

Both features become **host-side transformations applied inside `ChangeMapSession.sendGraph`**, using
pure helpers that live where their data model already lives: the ancestor-containment predicate in
`webview/graphView.ts` (next to `sectionScope`'s existing `containerId` walk), the vintage derivation
in `src/webviewHost.ts` (next to `buildEdgeSourceIndex`). The webview keeps rendering exactly what it
is sent; no consumer in `graphView.ts`/`relationshipDetails.ts` needs a new suppression call.

## Architecture Decisions

### Decision 1: One host-side choke point, not three webview call sites

| Option | Tradeoff |
|---|---|
| Patch `routedPaths`, `renderRelationshipIndicators`, `relationshipDetails.ts` (proposal's wording) | Three call sites to keep in sync forever; `graphSummary.edgeCount` still counts suppressed edges; the proposal's own top risk stays live |
| **Chosen**: strip suppressed edges from the display graph in `sendGraph`/`loadComparison` | One call site; all three consumers, `edgeSources` index alignment, and `graphSummary.edgeCount` become correct for free |

**Rationale**: the proposal already fixes suppression as *unconditional with no user toggle in this
slice*, so nothing requires the edge to survive into the webview. Removing it upstream eliminates the
"invisible on canvas but present in the popup/counts" class of bug by construction. If a toggle is
ever wanted, the helper is already exported and pure — it moves to a `GraphFilter` field then, not now.

### Decision 2: Suppression is NOT a `GraphFilter` field

**Choice**: unconditional pre-filter, applied before `filterGraph` ever runs.
**Rejected**: `GraphFilter.selfReferences?: boolean`.
**Rationale**: proposal assumption (c). A `GraphFilter` field would need wire-schema, toolbar, and
`requestView()` surface for a control the user did not ask for.

### Decision 3: `edgeOrigins` is an index-aligned array, computed outside `mergeGraphsForDisplay`

**Choice**: `buildEdgeVintages(...)` returning `EdgeVintage[]` index-aligned with `graph.edges`,
mirroring `buildEdgeSourceIndex`'s exact convention.
**Rejected**: returning it from `mergeGraphsForDisplay` (its return type is the protocol
`AnalysisGraph`, which cannot carry the field); keying by edge identity (no stable edge id exists).
**Rationale**: matches the file's one existing per-edge metadata convention exactly; pure key
comparison, so it is correct even when `store.getFileContent` fails (success criterion 7).

### Decision 4: `filterGraph` gains an optional 4th parameter, not a hidden dependency

**Choice**: `filterGraph(graph, diff, filter, vintages?)` where `vintages` is index-aligned with the
**input** `graph.edges`.
**Rejected**: filtering vintage host-side before `filterGraph` (splits the single filter surface).
**Rationale**: keeps `filterGraph` the sole filter surface and pure/testable; index alignment is only
required against its own input, so it never has to re-derive anything.

### Decision 5: Default vintage is applied by the host, not by `filterGraph`

`sendGraph` uses `filter?.vintages ?? DEFAULT_VINTAGES` with `const DEFAULT_VINTAGES: EdgeVintage[] =
["current"]`. `??` only substitutes on a genuinely absent field (the very first, filter-less render);
an explicitly empty array is a real user selection (both toolbar checkboxes unchecked) and is passed
through unchanged. **Amendment (post-`sdd-verify`)**: unlike `scopeIds`/`relationshipKinds`/
`changeStatuses`, `filterGraph` does NOT treat an empty `vintages` as "no restriction" — a checkbox
pair's "nothing checked" means "show nothing," per the spec's "Both vintages unchecked hides all
edges" scenario. `filterGraph` checks `filter.vintages !== undefined`, not `.length > 0`, so an empty
array filters every edge out (fixed in the graph-relationship-filtering-empty-vintages-fix follow-up).
**Rationale**: success criterion 4 requires the ghost gone on first render, before the user touches
the toolbar — but `filterGraph` defaulting a filter on would be surprising and untestable in isolation.

### Decision 6: No new dual-compilation note

`tsconfig.build.json` already includes `webview/graphView.ts` and `webview/edgeGeometry.ts`;
`tsconfig.webview.json` includes all of `webview/**`. The predicate lives in `graphView.ts`, which is
already dual-compiled, so no new boundary is created. It must **not** move to
`relationshipDetails.ts` (webview-only) or `edgeGeometry.ts` (no `Entity` access).

## Data Flow

    left/right AnalysisGraph
        │
        ▼  mergeGraphsForDisplay
    merged ──► suppressAncestorSelfReferences ──► suppressed
                                                    │
                          buildEdgeVintages ────────┤ (index-aligned to suppressed.edges)
                                                    ▼
                                    filterGraph(suppressed, diff, filter, vintages)
                                                    │  display
                                    ┌───────────────┴────────────────┐
                       buildEdgeVintages(display)         buildEdgeSourceIndex(display)
                                    └───────────────┬────────────────┘
                                                    ▼
                       post { type: "graph", edgeOrigins, edgeSources, … }
                                                    │
                                                    ▼
                       renderGraphSvg / renderRelationshipIndicators / bindRelationshipDetails

`buildEdgeVintages` is re-run against `display` (cheap, pure) rather than index-mapped through the
filter, so the posted `edgeOrigins` cannot drift out of alignment.

## Interfaces / Contracts

```ts
// webview/graphView.ts — next to ChangeStatus/changeStatusFor
export type EdgeVintage = "current" | "removed";

/** True when `edge`'s source entity is a transitive `containerId` ancestor of its resolved
 *  target (the `Main(x)` -> `class Main` shape). Peer edges between siblings are false.
 *  Unresolved/ambiguous/`contains` edges and unknown ids are false. Visited-set guarded,
 *  mirroring `sectionScope`'s walk, so a `containerId` cycle terminates and returns false. */
export function isAncestorSelfReference(edge: Edge, nodes: readonly Entity[]): boolean;

/** Unconditional pre-filter: drops every `isAncestorSelfReference` edge. Nodes untouched. */
export function suppressAncestorSelfReferences(graph: AnalysisGraph): AnalysisGraph;

export interface GraphFilter {
  scopeIds?: string[];
  relationshipKinds?: Edge["kind"][];
  changeStatuses?: ChangeStatus[];
  vintages?: EdgeVintage[];           // NEW
}

export function filterGraph(
  graph: AnalysisGraph, diff: CorrelatedDiffEntry[], filter: GraphFilter,
  vintages?: readonly EdgeVintage[],  // NEW, index-aligned with graph.edges
): AnalysisGraph;
```

Walk direction: start at `byId.get(edge.resolution.target)`, ascend `containerId` looking for
`edge.source`; `seen: Set<string>` guards cycles; a missing `containerId` entry ends the walk. Equal
source/target (`edge.source === target`) counts as a self-reference and is suppressed.

```ts
// src/webviewHost.ts — beside buildEdgeSourceIndex, reusing the module-level edgeKey
export function buildEdgeVintages(
  left: AnalysisGraph | undefined, right: AnalysisGraph | undefined,
  graph: AnalysisGraph, untrackedPaths: readonly string[],
): EdgeVintage[];
// "current" when right?.edges has the key OR untrackedPaths.includes(edge.span.path);
// otherwise "removed". Present-on-both-sides therefore collapses to "current" (assumption b).
```

Also fold `mergeGraphsForDisplay`'s inline `edgeKey` local into the existing module-level `edgeKey`
so one definition governs merge, source index, and vintage.

```ts
// src/webviewProtocol.ts
// inbound — required, matching the sibling arrays' style (no .optional()/.default())
z.object({ type: z.literal("requestGraphView"), scopeIds: …, relationshipKinds: …,
           changeStatuses: …, vintages: z.array(z.enum(["current", "removed"])).max(2) })

// outbound `graph` message — inline union, no src -> webview import
/** `edgeOrigins` is index-aligned with `graph.edges`. */
edgeOrigins: ("current" | "removed")[];
```

Making `vintages` required breaks exactly one existing call — `test/unit/webviewHost.test.ts:356` —
which is updated in the same slice. Consistency with the file's three sibling required arrays wins
over a `.default([])` that the file has no precedent for.

## Toolbar UI

`webview/index.ts` `initialize()`, after `selectControl("filter-status", …)`, adds a fieldset modeled
exactly on the "Run variants" fieldset (lines 201-206) but appended to `#toolbar`:

```ts
const vintage = document.createElement("fieldset"); vintage.id = "filter-vintage";
const vintageLegend = document.createElement("legend"); vintageLegend.textContent = "Vintage";
vintage.append(vintageLegend);
for (const value of ["current", "removed"] as const) {
  const label = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox"; check.id = `vintage-${value}`; check.checked = value === "current";
  check.addEventListener("change", requestView);
  label.append(check, document.createTextNode(value)); vintage.append(label);
}
byId("toolbar").append(vintage);
```

`requestView()` gains:
`const vintages = (["current","removed"] as const).filter(v => byId<HTMLInputElement>(\`vintage-${v}\`).checked);`
and posts it on the `requestGraphView` message.

**`src/extension.ts` is unchanged.** Building the control in `index.ts` (like "Run variants") rather
than as static HTML (like `#filter-kind`) means the JSDOM fixture in `test/unit/webviewDom.test.ts:29`
needs no edit and the change-listener wiring stays in one place.

`webview/styles.css`: add `#toolbar fieldset { display: flex; align-items: center; gap: 6px; border:
1px solid var(--vscode-panel-border, #333); padding: 2px 8px; margin: 0; }` and
`#toolbar fieldset legend { padding: 0 4px; font-size: 0.85em; }` — `#toolbar` is already
`display: flex; gap: 8px; flex-wrap: wrap`, so the fieldset only needs its own internal layout.

## File Changes

| File | Action | Description |
|---|---|---|
| `webview/graphView.ts` | Modify | `EdgeVintage`; `isAncestorSelfReference`; `suppressAncestorSelfReferences`; `GraphFilter.vintages`; `filterGraph` 4th param |
| `src/webviewHost.ts` | Modify | `buildEdgeVintages`; dedupe `edgeKey`; `sendGraph`/`loadComparison` pipeline + `DEFAULT_VINTAGES`; post `edgeOrigins` |
| `src/webviewProtocol.ts` | Modify | `vintages` on `requestGraphView`; `edgeOrigins` on `graph` |
| `webview/index.ts` | Modify | Vintage fieldset; `requestView()` sends `vintages` |
| `webview/styles.css` | Modify | `#toolbar fieldset` / `legend` rules |
| `src/extension.ts` | — | Unchanged (deliberate) |
| `webview/relationshipDetails.ts` | — | Unchanged (Decision 1) |

## Testing Strategy

| File | New cases |
|---|---|
| `test/unit/graphView.test.ts` | New `selfRefGraph()` fixture (module → class → method, plus two peer functions in one file). `isAncestorSelfReference`: true for module→own class and module→own nested method (transitive, not just direct parent); **false** for peer function→sibling function in the same file; false for `contains`, unresolved, ambiguous, unknown-id edges; false and terminating on a `containerId` cycle (a↔b) and on a dangling `containerId`; true for `source === target`. `suppressAncestorSelfReferences`: drops only those edges, leaves `nodes` identical. Rendering: `renderGraphSvg(suppressAncestorSelfReferences(g), [])` emits no `<g class="edge">` for the suppressed edge, and its `data-relationship-source` indicator count excludes it. `filterGraph`: `vintages: ["current"]` keeps only `"current"`-indexed edges; `vintages: []` and `undefined` filter nothing; vintage composes with `relationshipKinds` |
| `test/unit/webviewHost.test.ts` | `buildEdgeVintages`: byte-shifted left/right pair yields `["current","removed"]` for the two surviving merged edges; both-sides edge is `"current"`; left-only edge is `"removed"`; an edge whose `span.path` is in `untrackedPaths` is `"current"` even with no right match; vintages are correct with a `SnapshotStore` that has no stored content (criterion 7). `ChangeMapSession`: the `graph` message's `edgeOrigins.length === graph.edges.length`; default `sendGraph()` (no filter) already omits the left-only ghost; `requestGraphView` with `vintages: ["current","removed"]` restores it; `vintages: ["removed"]` hides worktree edges; `graphSummary.edgeCount` excludes ancestor self-references; update the existing `requestGraphView` intent at line 356 to include `vintages: []` |
| `test/unit/webviewProtocol.test.ts` | `requestGraphView` without `vintages` is rejected; with `["current"]` accepted; with `["stale"]` rejected; with 3 entries rejected (`.max(2)`) |
| `test/unit/webviewDom.test.ts` | `#filter-vintage` exists with `#vintage-current` checked and `#vintage-removed` unchecked; toggling `#vintage-removed` posts a `requestGraphView` whose `vintages` is `["current","removed"]`; unchecking both posts `vintages: []` |
| `test/unit/relationshipDetails.test.ts` | Regression: a graph passed through `suppressAncestorSelfReferences` produces a popup with no `<li>` for the suppressed edge, and `edgeIndex` values still address the correct edges |

No new integration or E2E coverage: both features are display-only and fully reachable from the unit
layer already used for this surface.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Both features are display-only transformations of already-trusted,
already-validated in-memory graph data; the one new inbound wire field is a bounded Zod enum array.

## Migration / Rollout

No migration required. No analyzer output, stored snapshot, or persisted state changes.

## PR Slicing Recommendation

Feature-branch chain of **3 PRs**, each targeting the previous branch, all well inside the 400-line
budget:

1. **Ancestor self-reference suppression** (~180 lines): `graphView.ts` helpers +
   `webviewHost.ts` pipeline insertion + `graphView.test.ts`/`relationshipDetails.test.ts` cases.
   Self-contained and independently shippable — no protocol change at all.
2. **Edge vintage: host + protocol** (~200 lines): `edgeKey` dedupe, `buildEdgeVintages`,
   `GraphFilter.vintages`, `filterGraph` param, both protocol fields, `DEFAULT_VINTAGES` wiring,
   `webviewHost.test.ts` + `webviewProtocol.test.ts`. Ships a working default (ghost gone) with no UI.
3. **Vintage toolbar control** (~90 lines): `index.ts` fieldset, `requestView()`, `styles.css`,
   `webviewDom.test.ts`. Makes the already-working filter user-reversible.

PR 1 is independent of 2-3 and could be landed alone if the vintage work stalls.

## Open Questions

None. Proposal assumptions (a) transitive ancestor chain, (b) both-sides → `"current"`, and
(c) unconditional suppression are all carried into the design as stated.
