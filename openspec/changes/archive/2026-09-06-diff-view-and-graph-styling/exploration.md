# Exploration: diff-view-and-graph-styling

## Scope

Two visual improvements to the Agent Change Map webview:

1. Git-diff-style line coloring for the Left/Right source comparison panel.
2. Hierarchical, dashed/solid, directional restyling of the SVG change-map graph.

## Request 1 — Diff-style source panel

**Current state**: `webview/index.ts` (`case "sourcePair"`) renders two flat `<pre>` blocks with a header line and an "Affected lines: n, m" note. The affected-line computation, `affectedLinesForSources()` in `src/webviewHost.ts`, is a longest-common-prefix/longest-common-suffix trim — not a true line diff. It cannot distinguish added vs. removed vs. unchanged lines, only "somewhere in the untrimmed middle." `sourcePair` on the wire (`src/webviewProtocol.ts`) carries no diff-op data at all.

**Constraint**: strict CSP (`default-src 'none'`, nonce-scoped scripts, no remote/CDN resources) and no bundler — `tsc -p tsconfig.webview.json` compiles `webview/**/*.ts` straight to ES modules. Any diff library must be vendored as a plain, license-preserved `.ts` port, not `npm install`ed and imported as-is (unless its published output is plain ESM `tsc` can resolve unbundled).

**Recommendation**: vendor a small Myers/LCS line-diff (trimmed port of `vscode-diff`'s line-diff computer, or the smaller `diff`/jsdiff `diffLines`), computed **host-side** in `src/` next to `affectedLinesForSources` (replacing its prefix/suffix trim). Extend the `sourcePair` wire message with real per-line diff ops (added/removed/unchanged). Render as a two-column, per-line colored panel (green/red backgrounds, de-emphasized/collapsed unchanged runs) instead of flat `<pre>` text. Word-level (intra-line) highlighting is a good future enhancement, out of scope for this pass.

## Request 2 — Graph visual language

**Current state**: `renderGraphSvg()` in `webview/graphView.ts` draws every node as an identical flat rounded rect in a single vertical stack, colored only by change status (`status-added/removed/modified/unchanged`). Edges are not drawn at all — they exist only as text lines below the nodes (e.g. `module:app --import--> resolved -> function:route.ruta1@0`).

**Reference (user-provided mockup)**: an outer dashed, thin, gray "app" module box; a dashed, thicker, orange "route" module box; nested inside it a solid, even-thicker, orange "ruta1" function box; a green elbow arrow from a dot at the bottom of "app" to a dot at the top of "ruta1".

**Styling rules** (as specified):
1. Modules/scripts (`.py` files) → dashed outline, thinnest stroke.
2. Functions/classes → solid outline (never dashed), thicker than their module, and distinct thickness from each other.
3. Containment (module contains function/class) is drawn as real geometric nesting, not a stacked sibling with a text-only "contains" edge.
4. Changed nodes (added/removed/modified) get color; unchanged nodes stay gray/uncolored — this part of the current scheme is already correct and must be preserved.
5. Import/call edges must be drawn as real lines/arrows whose direction indicates flow (source = importer/caller, destination = imported/called symbol).

**Open question A — edge directionality convention** (user explicitly asked to be told the convention rather than have one picked silently). Three candidates:
- **A. Arrowhead-at-destination, color-coded by kind** (source box → line → arrowhead at the resolved target; `import` and `call` get distinct colors). This is exactly what the user's own mockup shows (green arrow from `app` into `route.ruta1`). **Recommended.**
- **B. UML-style dependency arrows**: open arrowhead + dashed line for `import`, solid arrowhead + solid line for `call`. Borrows an existing external convention; trades color for line/arrowhead shape.
- **C. Graphviz call-graph style**: plain directed arrow, arrowhead at callee/imported symbol, no color-by-kind (kind shown on hover only, as today's tooltip already does). Simplest, but loses at-a-glance import/call distinction.

**Open question B — fill vs. outline**: today's nodes are filled rects colored by status. The mockup's boxes read as outline-only (colored stroke, no fill) for both modules and entities. Needs explicit confirmation before implementation, since it changes the current visual scheme.

**Recommendation**: rewrite `renderGraphSvg` around a recursive containment layout keyed on `Entity.containerId` (already present on every entity, at arbitrary depth — package → module → class → method). Map `kind` to dash-pattern + stroke-width (container = dashed/thin; class/function/method = solid/thicker, mutually distinct). Keep existing `status-*` classes for color. Draw real `<path>` edges with `<marker>` arrowheads per Convention A once confirmed. Preserve `data-node-id` / `data-edge-index` attributes exactly, since `webview/index.ts`'s click-to-navigate wiring depends on them and needs zero changes under this rewrite.

## Test-coverage impact (Strict TDD)

- `test/unit/graphView.test.ts` (~L81-85) hard-codes the current flat-stack "edges rendered as text below all nodes" assumption. This **will** break under the nested-layout + drawn-edges rewrite — expected, not a regression; must be rewritten as part of this change (RED before GREEN on the new geometry).
- `test/unit/webviewHost.test.ts` (~L109-122) and `test/unit/webviewDom.test.ts` (~L112-115) assert the current prefix/suffix `affectedLines` + flat `<pre>` text contract for `sourcePair`; both need new assertions once diff ops + per-line DOM land.
- New tests needed: nested bounding-box containment (child box geometrically inside parent), dash-pattern/stroke-width per `kind`, marker/arrowhead direction per edge kind, orphaned-node behavior when a node's container is filtered out of the current scope/section view, and line-diff correctness (added/removed/unchanged classification) for the new host-side diff function.

## Risks

- `vscode-diff`'s vendorable surface may be larger than needed without a bundler; a quick spike should confirm it trims cleanly before committing over the smaller `diff`/jsdiff port.
- Both open questions above (edge convention, fill-vs-outline) must be confirmed with the user before `sdd-design`/`sdd-tasks` — they materially change the graph's visual contract.

## Ready for proposal

Yes, carrying open questions A and B into the proposal for explicit user confirmation.
