# Exploration: graph-relationship-filtering

## Current State

**Feature 1 — same-file self-reference edges**

- `Entity` (`src/protocol.ts:37-43`) carries `span: SourceSpan` and `SourceSpan.path` (`src/protocol.ts:24-35`). Every node already has its defining file path available at render time.
- `Edge` (`src/protocol.ts:51-57`) also carries its own `span.path` — the file where the call/import *site* is, not necessarily the same as the source entity's own defining file, and not necessarily the target's file either.
- `python/analyzer.py` builds ALL `nodes` (with full spans) before resolving `call`/`import` edges (`analyzer.py:144-186`): files are parsed into per-file `FileVisitor`s first, node list is complete, then a second pass (`by_qualified_name` lookup) resolves `call`/`import` targets. The analyzer already has full entity data available at edge-resolution time and could look up the target entity's `span.path` cheaply by building a `by_id` map (not currently built — only `by_qualified_name` exists at analyzer.py:170-172). There is currently **no "same file" check anywhere** in the analyzer or the webview.
- `webview/edgeGeometry.ts`'s `sourceExitAnchor` (line 343-363) and `hasDescendant` (line 333-341) are a **routing/geometry fix**, not a suppression: when a container (module) has descendants and its own edge target sits above the container's bottom edge (the exact `Main(x)` → `class Main` shape), the edge exits from the container's top instead of its bottom, avoiding a visually-backtracking path through the container's own children. It does **not** hide the edge — it is still drawn. This is a geometry bug fix, distinct from the new ask ("don't draw it at all").
- `webview/graphView.ts`'s `renderEdge` (line 352-374) and `routedPaths`/`edgePathsFor` (`graphView.ts:377-384`, `edgeGeometry.ts:501-582`) render every resolved edge whose target box exists, with no same-file check.
- `filterGraph`/`GraphFilter` (`graphView.ts:516-548`) is the existing display-only filter surface — it filters by `scopeIds`, `relationshipKinds`, `changeStatuses`, but has no "hide same-file" option today.

**Feature 2 — relationship "vintage" filter**

- `mergeGraphsForDisplay` (`src/webviewHost.ts:21-36`) merges `left`/`right` graphs by `qualifiedName` (nodes) and by `${kind}:${source}:${path}:${startByte}:${endByte}` (edges). Because the key is byte-exact, an edge whose containing file changed shape (even a single-byte shift) produces a *different* key on `right` than the one that existed on `left` for the "same" logical relationship, so **both survive** in the merged `Map` — the old, stale edge included, exactly the bug the user described.
- The order `[...(left?.edges ?? []), ...(right?.edges ?? [])]` into a `Map` means: if a key exists on both sides, `right` wins (overwrites); if a key exists on only one side, that side's edge passes through untouched. So **which side (or both) produced a given merged edge is fully knowable today** — it's just not currently recorded anywhere on the merged output.
- `buildEdgeSourceIndex` (`src/webviewHost.ts:68-85`) **already computes almost exactly this "vintage" per edge**: for every edge in the display graph, it independently re-derives `rightEdge`/`leftEdge` via the same `edgeKey`, and picks `side: "right"` if the edge exists on the right, else `"left"`, else `undefined`. This result (`edgeSources`, index-aligned with `graph.edges`) is already threaded to the webview via the `graph` host→webview message and consumed today only by `webview/relationshipDetails.ts` (to know whether "View in code" is available). It silently drops to `undefined` when `store.getFileContent` can't resolve the snapshot content — a caveat for reuse.
- `provenance: "tracked" | "untracked"` is tracked **per node** only (`untrackedPaths.includes(node.span.path)`, `graphView.ts:315`), threaded through `ChangeMapSession` and rendered as a `data-provenance` attribute + badge. There is no per-edge untracked flag today, but `edge.span.path` is available on every edge, so `untrackedPaths.includes(edge.span.path)` is a one-line derivation, mirroring the existing node logic exactly.
- `webview/index.ts`'s toolbar UI: **only single-select `<select>` dropdowns exist today**, not checkboxes. `selectControl` (`webview/index.ts:177-184`) builds `Section` (`filter-scope`) and `Change` (`filter-status`) as native `<select>`s; `Relationship` (`filter-kind`) is static HTML in `src/extension.ts:60-67`, also a single-select `<select>`. `requestView()` reads `.value` from each select and posts a `requestGraphView` message with `scopeIds`/`relationshipKinds`/`changeStatuses` arrays (each currently populated with **at most one value**, despite `GraphFilter`/the wire schema already supporting arrays/multi-select). The filter plumbing is multi-select-ready; only the UI widgets are single-select.
- `ChangeStatus`/`changeStatusFor` (`graphView.ts:22-30`) is a good structural template to imitate for a new `EdgeVintage`/`vintageFor`-style helper: a small closed union type plus a pure function computing it from existing data, consumed by `filterGraph`.

**Does the new `edgePathsFor`/coordinated routing affect either feature?**

No. `edgePathsFor`/`RoutingEdge` (`edgeGeometry.ts:424-582`) is purely geometric — `{ source: string; target?: string }` — no `kind`, no side/vintage, nothing about same-file-ness. It **is** the code path that draws same-file self-reference edges today (they go through the normal `edgePathsFor` → `routingPorts` → `renderEdge` pipeline like any other resolved edge), so Feature 1's suppression must happen *before* an edge reaches `routedPaths`/`edgePathsFor` — not by touching `edgePathsFor`'s geometry, which has no hook for "don't route this."

## Affected Areas

- `python/analyzer.py` — a "never emit same-file edges" approach would need a `by_id` map and a filter in the edge-append loops (`analyzer.py:167,186`).
- `src/protocol.ts` — `Edge`/`Entity` schemas; a new wire field for vintage would need schema changes here.
- `webview/graphView.ts` — `filterGraph`/`GraphFilter` (516-548), `renderEdge`/`routedPaths` (352-384) — natural home for a render-time "hide same-file" filter and a `ChangeStatus`-style vintage helper.
- `webview/edgeGeometry.ts` — `hasDescendant`/`sourceExitAnchor` — context only; not a good place for suppression logic (pure geometry, no `Entity`/file-path access).
- `src/webviewHost.ts` — `mergeGraphsForDisplay` (21-36) and `buildEdgeSourceIndex` (68-85) — where Feature 2's vintage/origin metadata already partially exists or would need to be exposed as a first-class per-edge field.
- `src/webviewProtocol.ts` — `requestGraphView` schema and the `graph` message shape (`edgeSources`) — would need a new filter field/array for vintage.
- `webview/index.ts` / `src/extension.ts` — toolbar HTML/JS: needs a new checkbox-group widget pattern (none exists yet; `selectControl` only builds single-select `<select>`s).
- `webview/styles.css` — provenance badge styling is a template for any new visual marker.
- `test/unit/edgeGeometry.test.ts`, `test/unit/graphView.test.ts`, `test/unit/webviewDom.test.ts` — existing test surfaces to extend.

## Approaches — Feature 1 (hide same-file self-reference edges)

1. **Analyzer-side: never emit any edge where source entity's file == target entity's file.**
   - Pros: single choke point, applies uniformly to every consumer, no wire/schema change.
   - Cons: irreversible — loses the "two functions calling each other in the same module" signal; no toggle possible later without changing analyzer output; harder to unit test with the existing TS suite.
   - Effort: Low-Medium.

2. **Render-time filter in `filterGraph`/`renderEdge` (webview/graphView.ts)** — using `graph.nodes` (which carries `span.path`) to look up source/target entity paths, drop an edge before layout/routing when `sourceEntity.span.path === targetEntity.span.path`.
   - Pros: reversible/toggleable without protocol changes (all needed data already flows to the webview); consistent with the existing "display-only filter" pattern; testable with existing TS unit tests.
   - Cons: the edge still exists in `graph.edges`/counts unless also stripped from `renderRelationshipIndicator` counts and `relationshipDetails.ts`'s edge loop — needs consistent hiding across three call sites, not one.
   - Effort: Medium.

3. **Narrow the scope to the exact bug shape (ancestor/descendant containment)** — hide an edge only when its target entity is a descendant of (or equal to) its source entity via the `containerId` chain, covering the reported `Main(x)`/`class Main` case while still showing genuine peer-to-peer same-file call edges.
   - Pros: directly targets the reported example without discarding useful same-file peer relationships; continues the same containment-chain reasoning already used elsewhere in the codebase.
   - Cons: doesn't satisfy the literal "same file, hide" wording if the user wants ALL same-file edges gone; requires walking `containerId` chains; still leaves same-file peer call edges drawn.
   - Effort: Medium.

**Recommendation**: Approach 2 (render-time filter, applied consistently to routing + relationship-indicator counts + the details popup), using the literal same-file rule as the default. **Open question for the user before spec**: does "same file" mean ANY same-file edge (broader — covers two peer functions calling each other too), or only the "container calls its own nested descendant" shape from the concrete example given? These are two different-sized fixes.

## Approaches — Feature 2 (relationship vintage filter)

1. **Reuse `buildEdgeSourceIndex`'s existing `side` computation as-is.**
   - Pros: zero new plumbing — `edgeSources` is already sent with every `graph` message; fastest to implement.
   - Cons: silently collapses "left-only" and "content-resolution-failed" into the same bucket; doesn't distinguish "exists in both" from "brand-new"; reusing a navigation-focused struct for filtering is a mild coupling smell.
   - Effort: Low.

2. **Add a first-class vintage/origin field to the merged display graph, computed once in `mergeGraphsForDisplay`** — an index-aligned `edgeOrigins: ("left" | "right" | "both")[]` (or a `ChangeStatus`-style `vintageFor` pure function), threaded through the `graph` message alongside (not reusing) `edgeSources`, consumed by a new `GraphFilter.vintages?: ("current" | "removed")[]`.
   - Pros: clean separation of concerns, explicit "both" case, doesn't depend on `store.getFileContent` succeeding, easiest to unit test in isolation, matches the existing `ChangeStatus`/`changeStatusFor` convention.
   - Cons: new wire-protocol field and a small amount of duplicate key-matching logic next to `buildEdgeSourceIndex`'s (unless refactored to share a helper).
   - Effort: Medium.

3. **Filter host-side, before the edge ever reaches `filterGraph`** — extend `mergeGraphsForDisplay` (or a wrapper) to drop stale left-only edges by default unless a filter says otherwise.
   - Pros: keeps `mergeGraphsForDisplay`'s contract ("decides which single representation to show") arguably intact — vintage selection is that kind of decision.
   - Cons: breaks the current separation where `mergeGraphsForDisplay` is filter-agnostic and `filterGraph` is the sole filter surface; `sendGraph`'s current structure would need restructuring; less consistent with the Section/Change/Relationship precedent.
   - Effort: Medium-High.

**UI**: no checkbox-group pattern exists yet (`selectControl` only builds `<select>`s; the "Run variants" fieldset at `webview/index.ts:201-206` is a decent structural template — `<fieldset>` + `<legend>` + per-option `<label><input type=checkbox>`). `GraphFilter`/`requestGraphView`'s wire schema is already array-shaped and multi-select-ready, so a checkbox-based control is naturally additive, not a schema change.

**Minimal sane default checkbox set**: "Current" (right/worktree edges, plus edges whose `span.path` is in `untrackedPaths`) checked by default, "Removed" (left-only edges — the stale/ghost case) unchecked by default. A finer-grained `changeStatuses`-aligned per-edge set is possible but `changeStatusFor` is defined purely in terms of node `qualifiedName` pairing today; extending it to edges is a larger design question best deferred unless "Current/Removed" proves insufficient.

**Recommendation**: Approach 2 (dedicated `edgeOrigins`/vintage field in `mergeGraphsForDisplay`, independent of `buildEdgeSourceIndex`) paired with a new checkbox-group toolbar widget modeled on the "Run variants" fieldset, and a new `GraphFilter.vintages` array consumed by `filterGraph`.

## Risks

- Feature 1's exact scope ("any same-file edge" vs. "only the container-calls-its-own-descendant shape") is genuinely ambiguous from the user's own phrasing — the literal example given matches the narrower ancestor/descendant case, but the stated rule is the broader same-file rule. Confirm before spec.
- Feature 1, if implemented at render time, must be applied consistently across three consumers of `graph.edges` (`routedPaths`, relationship-indicator counts, `relationshipDetails.ts`'s edge list) or a hidden edge will still surface in popups/counts while invisible on the canvas.
- Feature 2's existing `buildEdgeSourceIndex` silently loses side information when `store.getFileContent` fails; a new `edgeOrigins` computation should be a pure key comparison against `left.edges`/`right.edges`, not dependent on content resolution succeeding.
- No existing test coverage maps directly onto either feature yet; new fixtures needed for genuinely same-file entities/edges and multi-snapshot merge scenarios with byte-shifted spans.

## Ready for Proposal

Yes, pending one clarifying question: for Feature 1, should "hide same-file edges" apply to ANY same-file call/import edge, or only to the "source is an ancestor container of the target" shape? Feature 2 has no comparable blocking ambiguity.
