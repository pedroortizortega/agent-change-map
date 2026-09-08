# Proposal: Graph Relationship Filtering

## Intent

The graph draws two classes of edges that carry no information but cost readability:

- **Self-reference clutter.** A module-level call into a class/function defined in that same
  module (e.g. `Main(x)` → `class Main`) is drawn as a real edge looping back into the
  container's own children. `sourceExitAnchor` (`webview/edgeGeometry.ts:343`) only re-routes
  it; **no same-file or ancestor check exists anywhere** in the analyzer or the webview.
- **Ghost/stale edges.** `mergeGraphsForDisplay` (`src/webviewHost.ts:21-36`) keys edges by
  `${kind}:${source}:${path}:${startByte}:${endByte}`. Byte-exact keys mean a one-byte shift
  in the containing file yields a different key on `right` than on `left`, so both survive the
  merge and the HEAD-side edge is displayed as if the code still existed. Which side produced
  a merged edge is knowable today but recorded nowhere.

Success: the canvas shows only relationships that exist in the code the user is looking at, and
stale relationships are opt-in rather than silently mixed in.

## Scope

### In Scope
- Hide an edge when its source is an **ancestor container** of its target via the `containerId`
  chain. Same-file **peer** edges (sibling function → sibling function) stay visible.
- A per-edge **vintage** ("current" / "removed") derived in `mergeGraphsForDisplay`.
- A **checkbox-group** toolbar filter for vintage: "Current" (right/worktree edges plus edges
  whose `span.path` is in `untrackedPaths`) checked by default; "Removed" (left-only) unchecked.

### Out of Scope
- Broader "hide any same-file edge" suppression.
- Analyzer-side suppression (`python/analyzer.py` stays unchanged).
- Per-edge change-status filtering finer than current/removed; a third vintage bucket.
- Redesigning the existing Section / Change / Relationship `<select>` controls.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-map-visualization`: edge rendering gains an ancestor-containment suppression rule and
  a vintage filter dimension governing which snapshot's edges are displayed.

## Approach

**Feature 1** — render-time filter (not analyzer, not geometry). Resolve source/target entities
from `graph.nodes` and walk the `containerId` ancestor chain; drop the edge before layout. Apply
in one shared helper consumed by all three edge consumers: `routedPaths`
(`webview/graphView.ts:377`), the relationship-indicator counts, and
`webview/relationshipDetails.ts`.

**Feature 2** — a first-class, index-aligned `edgeOrigins` field computed in
`mergeGraphsForDisplay` by pure key comparison against `left.edges`/`right.edges`, threaded on
the `graph` message *alongside* (never reusing) `buildEdgeSourceIndex`. Consumed by a new
`GraphFilter.vintages` in `filterGraph`, following the `ChangeStatus`/`changeStatusFor`
convention. Toolbar widget modeled on the existing "Run variants" `<fieldset>` pattern
(`webview/index.ts:201-206`); the wire schema is already array-shaped.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `webview/graphView.ts` | Modified | Ancestor-chain helper; `GraphFilter.vintages` in `filterGraph`; indicator counts |
| `webview/relationshipDetails.ts` | Modified | Apply the same suppression to the details list |
| `src/webviewHost.ts` | Modified | Compute `edgeOrigins` in `mergeGraphsForDisplay`; send on `graph` |
| `src/webviewProtocol.ts` | Modified | `edgeOrigins` on `graph`; `vintages` on `requestGraphView` |
| `webview/index.ts` / `src/extension.ts` | Modified | New checkbox-group toolbar control + `requestView()` wiring |
| `webview/styles.css` | Modified | Checkbox-group styling |
| `test/unit/*` | Modified | New fixtures: nested same-file entities; byte-shifted merge scenarios |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Suppression applied to canvas but not to counts/details popup | High | Single exported predicate used by all three consumers; a test per consumer |
| Inheriting `buildEdgeSourceIndex`'s content-resolution gap (silently `undefined` when `store.getFileContent` fails) | Med | `edgeOrigins` is a pure key comparison, independent of content resolution |
| Ancestor walk hides a legitimate peer edge | Med | Strict ancestor-chain test only; explicit peer-edge-stays-visible test |
| Default hides edges a user expected to see | Low | Vintage is a visible, reversible toolbar checkbox |
| `containerId` cycle or missing parent | Low | Depth-bounded / visited-set walk |

## Rollback Plan

Both features are additive and display-only. Revert the commit; or, without a revert, uncheck
nothing — omitting `vintages` from `requestGraphView` restores merged-edge behavior, and the
suppression predicate can be short-circuited to `false` in one place. No analyzer output, stored
data, or persisted state changes, so no migration is involved.

## Dependencies

None. All required data (`Entity.span.path`, `containerId`, `untrackedPaths`, left/right graphs)
already flows to the webview.

## Success Criteria

- [ ] A module-level call into a class defined in that same module draws no edge.
- [ ] A same-file peer call edge is still drawn.
- [ ] A hidden edge is absent from the canvas, relationship-indicator counts, and the details popup.
- [ ] With defaults, a byte-shifted-file ghost duplicate no longer appears.
- [ ] Checking "Removed" restores HEAD-only edges; unchecking "Current" hides worktree edges.
- [ ] Untracked-file edges are treated as "Current".
- [ ] `edgeOrigins` is correct even when `store.getFileContent` fails.

## Proposal question round

Scope was confirmed directly by the user before this proposal; no open questions block spec/design.
Assumptions carried forward, correct if wrong: (a) "ancestor" is the transitive `containerId`
chain, not just the direct parent; (b) an edge present on both sides counts as "Current";
(c) suppression is unconditional, with no user toggle in this slice.
