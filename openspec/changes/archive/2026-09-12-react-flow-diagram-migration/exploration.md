# Exploration: Migrate webview flowchart rendering from hand-rolled SVG to React Flow (`@xyflow/react`)

**Change name**: `react-flow-diagram-migration`
**Status**: partial (exploration complete, ready for proposal)

## Current State (verified against real code)

- **No bundler today** — confirmed. `package.json` `build:webview` = `tsc -p tsconfig.webview.json && node scripts/copy-webview-assets.mjs`. `tsconfig.webview.json` compiles `webview/**/*.ts` → `out/webview` as native `ES2022`/`ES2022` modules (`moduleResolution: "Bundler"`, `lib: ["ES2022","DOM"]`). `scripts/copy-webview-assets.mjs` only copies `styles.css`; JS files stay as separate `.js` module files, loaded by the browser's native ESM loader.
- **Only runtime dependency is `zod`** — confirmed in `package.json`; no React/Vue/D3/UI lib present anywhere.
- **CSP** (`webview/graphView.ts:buildCspMetaTag`, wired in `src/extension.ts:buildWebviewHtml`): `default-src 'none'; img-src {cspSource} data:; style-src {cspSource}; script-src 'nonce-{nonce}'; script-src-elem 'nonce-{nonce}'`. Exactly one `<script type="module" nonce="...">` tag loads `out/webview/webview/index.js`; `localResourceRoots` is scoped to `out/webview`. Because the entry script is a native ES module, its static `import`s of sibling files (`relationshipDetails.js`, `positionOverrides.js`, `graphView.js`) are permitted by the CSP without needing their own nonce (module graph import is not gated by `script-src-elem` per spec) — this is *why* the current no-bundler setup already works under this CSP.
- **`graphView.ts` is NOT a pure renderer** — most important finding for design later. It's dual-compiled: `tsconfig.build.json` (host/extension-side, Node/NodeNext, no DOM lib, excludes `webview/index.ts`) includes `webview/graphView.ts` and `webview/edgeGeometry.ts` directly. `src/webviewHost.ts` imports `filterGraph`, `suppressAncestorSelfReferences`, `EdgeVintage` from `../webview/graphView.js`; `src/extension.ts` imports `buildCspMetaTag` from it too. So `graphView.ts` bundles together: (a) pure, host-reusable graph/business logic (`filterGraph`, `sectionScope`, `changeStatusFor`, `isAncestorSelfReference`, `NESTED_LAYOUT_LIMITS`, `buildCspMetaTag`) that must stay DOM-free and importable from Node, and (b) SVG-only rendering internals (`renderGraphSvg`, `renderFlatSvg`, `renderNodeRect`, `renderEdge`, `place`/`measure`, `computeChildrenOf`, `clusterConnectedRoots`, `orderSiblings`, `KIND_STYLE`, `routedPaths`) that only `webview/index.ts` consumes. A migration must split this file rather than delete it wholesale.
- **Containment layout** (`computeChildrenOf` + `measure`/`place` in `graphView.ts`): builds a `containerId`-keyed tree, orders siblings via Kahn topological sort over the non-`contains` subgraph (`orderSiblings`), clusters unconnected root components (`clusterConnectedRoots`), then recursively measures bottom-up pixel sizes (`NODE_H=32, HEADER_H=20, PAD_X=12, PAD_Y=10, GAP_Y=8, NODE_MIN_W=200, ROOT_GAP=24, MARGIN=16`) and places boxes top-down, degrading to `renderFlatSvg`'s vertical stack above `NESTED_LAYOUT_LIMITS = {nodes:60, edges:120}`. Containment is expressed purely as SVG nesting — there is no drawn "contains" edge.
- **Edge routing** (`webview/edgeGeometry.ts`, 657 lines, framework-agnostic, no DOM/imports): rectangle-obstacle-aware orthogonal/elbow routing with Bezier tail blending, outer-lane fallback, and `edgePathsFor` batch coordination (port reservation, crossing-penalty cost function, label-row/container-lane clearance). Substantial, tested, pure geometry.
- **Drag/pan/zoom + protocol wiring** (`webview/index.ts`, 940 lines): manual `pointerdown/pointermove/pointerup` drag state machine (`DRAG_THRESHOLD` click-vs-drag distinction), `positionOverrides.set(nodeId, {dx,dy})` committed on `pointerup`, full-DOM-pass edge re-routing during live drag, `positionOverrides.pruneTo(...)` on refresh, per-edge `click` → `navigate` postMessage, `bindRelationshipDetails(...)`, `themeTokens` message handling.
- **`positionOverrides.ts`**: pure, DOM-free `Map<string, {dx,dy}>` with LRU eviction (`MAX_POSITION_OVERRIDES = 200`), `pruneTo(presentIds)`. Framework-agnostic; trivially reusable with any renderer.
- **`relationshipDetails.ts`**: pure DOM popup bound imperatively via `bindRelationshipDetails(root, graph, edgeSources, navigate)`; listens for clicks/keydowns on `[data-relationship-source]` elements inside `root`, positions via `getBoundingClientRect()`, calls `navigate(edgeIndex)`. Coupled to the `data-relationship-source` attribute contract emitted by `graphView.ts`'s `renderRelationshipIndicator`, not to SVG per se.
- **Protocol** (`src/webviewProtocol.ts`, `src/protocol.ts`): `HostToWebviewMessage` `"graph"` variant carries `{graph, diff, sourceIndex, edgeSources, edgeOrigins, untrackedPaths}`; `AnalysisGraph` is Zod-typed `{snapshot, nodes: Entity[], edges: Edge[], diagnostics}` with `Entity.containerId` for containment and `Edge.kind: "contains"|"import"|"call"` + `EdgeResolution`. None of this needs to change for a rendering-engine swap.
- **Oversized threshold**: `OVERSIZED_THRESHOLDS = {nodes:300, edges:600}` lives in `src/webviewHost.ts`, independent of and above `NESTED_LAYOUT_LIMITS` (60/120) — two separate gates.
- **Test coupling to the SVG string is severe** — `test/unit/graphView.test.ts` alone calls `renderGraphSvg(...)` in ~35 places, parsing markup via JSDOM and asserting on `data-node-id`, `data-edge-kind`, `data-resolution`, `<path d="...">`, nesting via `<g transform="translate(...)">`, etc. `test/unit/relationshipDetails.test.ts` and `test/unit/webviewDom.test.ts` also build JSDOM fixtures by embedding `renderGraphSvg(...)` output. All three suites need a full rewrite once rendering stops producing this exact SVG shape.

## Affected Areas

- `webview/graphView.ts` — split into a DOM-free host-safe module and a webview-only layout module.
- `webview/edgeGeometry.ts` — routing math informs but doesn't verbatim-reuse a React Flow custom-edge path computation.
- `webview/index.ts` → `webview/index.tsx` — React root mounting `<ReactFlow>`; must preserve postMessage protocol handling, theme token application, refresh/oversized-confirm flow.
- `webview/positionOverrides.ts` — event source moves from manual `pointerup` math to `onNodeDragStop(event, node)`; delta-from-base → absolute-position semantics is a real behavior change to design explicitly.
- `webview/relationshipDetails.ts` — reusable logic against React-rendered real DOM, or re-expressed as a custom node's own popover.
- `tsconfig.webview.json` — needs `jsx`/`jsxImportSource` config and a build step change.
- `tsconfig.build.json` — must keep excluding React/DOM-flavored code.
- `package.json` — new `esbuild`, `react`, `react-dom`, `@xyflow/react` deps; `build:webview` script rewritten.
- `scripts/copy-webview-assets.mjs` — must also handle `@xyflow/react`'s own CSS.
- `test/unit/graphView.test.ts`, `test/unit/relationshipDetails.test.ts`, `test/unit/webviewDom.test.ts` — substantial rewrites (SVG-string assertions → React Flow node/edge data + DOM assertions).
- `src/extension.ts` (`buildWebviewHtml`) — likely unchanged in structure, but must serve the new bundled entry/stylesheet.

## Approaches

### A. esbuild bundling, single-file output (recommended)
Bundle `webview/index.tsx` (React + `@xyflow/react` + local modules) into one `out/webview/webview/index.js` via esbuild (`bundle:true, format:"esm", target:"es2022", splitting:false`), replacing the `tsc -p tsconfig.webview.json` emit step. Keep `tsc -p tsconfig.webview.json --noEmit` for type-checking only.
- **Pros**: single script tag stays valid under current CSP unchanged; esbuild is fast/zero-config; CSS bundling handles `@xyflow/react/dist/style.css`.
- **Cons**: two build tools (tsc for types, esbuild for emit) to keep in sync; requires the `graphView.ts` split as a hard prerequisite.
- Effort: Medium.

### B. Vite for webview build
- **Cons**: dev server unusable inside `vscode-webview://` CSP anyway; heavier devDependency surface than esbuild for a single-entry bundle; more CSP-safety config (must disable code-splitting) for no clear benefit over A.
- Effort: Medium-High, not recommended.

### C. Containment layout strategy
**C.1 Native subflows** (`parentId` + `extent:'parent'`): idiomatic but requires porting `orderSiblings`/`clusterConnectedRoots` into subflow child-order terms, manual parent auto-sizing (React Flow doesn't auto-size parents to children), and reworking `positionOverrides`' coordinate space to parent-relative.

**C.2 Keep current absolute-position containment algorithm, feed React Flow absolute node positions, containers as plain non-interactive background nodes** (recommended): reuses the already-tested `computeChildrenOf`/`orderSiblings`/`clusterConnectedRoots`/`measure` algorithm verbatim, just swapping SVG string emission for `Node[]` objects. Container nodes become ordinary absolutely-positioned rectangles rather than true React Flow parents — acceptable since drag-reparenting isn't a current or requested behavior.

### D. Edge line-style-by-kind + animated particle
Custom `edgeTypes` returning `<BaseEdge path={...} style={...}/>` plus children. Distinct `strokeDasharray` per `data.kind` (today edges are only color-differentiated via CSS class `edge-import`/`edge-call`, not dash-differentiated — this is a genuine visual upgrade, not parity work). Particle animation via SVG `<circle><animateMotion mpath="#edgePathId"/></circle>` — fully declarative, CSP-safe (no inline `<script>`, no JS animation loop).
- Effort: Low-Medium once the custom edge component pattern exists.

### E. Hover highlighting of connected subgraph
`onNodeMouseEnter`/`onEdgeMouseEnter` plus xyflow's built-in `getConnectedEdges`/`getIncomers`/`getOutgoers` helpers to compute the connected set and toggle a `highlighted` data flag via `setNodes`/`setEdges`. Idiomatic and simpler than hand-rolled graph walking.

## Recommendation

Adopt **A** (esbuild bundling) + **C.2** (reuse absolute-position containment, skip native subflows) + **D** (custom edgeTypes with SVG `animateMotion`) + **E** (xyflow connected-node helpers for hover). Concretely: split `graphView.ts` into a DOM-free `graphFilters.ts` (host-safe, dual-compiled: `filterGraph`/`sectionScope`/`changeStatusFor`/`isAncestorSelfReference`/`buildCspMetaTag`/`NESTED_LAYOUT_LIMITS`/`EdgeVintage`) and a webview-only `graphLayout.ts` (`computeChildrenOf`/`orderSiblings`/`clusterConnectedRoots`/`measure`, producing `{id, position, parentId?, data}[]` instead of SVG strings); new `webview/index.tsx` React root consuming both plus `positionOverrides` (redesigned to store absolute positions, matching `onNodeDragStop`'s `node.position`) and `relationshipDetails.ts` rewired against React-rendered real DOM.

Lower effort/risk than native subflows or Vite; reuses the largest chunk of already-tested pure logic; keeps host/extension side (`src/webviewHost.ts`, `src/extension.ts`, CSP, protocol) completely untouched.

## Risks

- **Test rewrite is the single largest cost**: ~35+ assertions in `graphView.test.ts` plus all of `relationshipDetails.test.ts` and parts of `webviewDom.test.ts` are written against the exact SVG string; not refactor-safe. Recommend rewriting tests to assert against React Flow's `Node[]`/`Edge[]` data model and rendered DOM (`@testing-library/react` + jsdom) rather than preserving old SVG-string assertions.
- **Bundle size in the packaged `.vsix`**: `@xyflow/react` + `react`/`react-dom` add real weight to an extension that currently ships almost no runtime code; measure actual `.vsix` size impact before committing.
- **Performance near oversized thresholds** (300 nodes / 600 edges): needs empirical validation with React Flow specifically; the equivalent of today's `NESTED_LAYOUT_LIMITS` (60/120) boundary must be re-measured, not assumed identical.
- **No auto-layout library (dagre/elkjs) needed**: the existing bespoke algorithm already solves ordering/containment for this containment+call/import model; introducing a generic layout engine would be a net-negative unless a future exploration shows the bespoke algorithm breaking down at scale.
- **`positionOverrides` semantic change** (delta-from-base → absolute position) touches persisted-drag behavior; must be explicitly speced in proposal/design, not assumed a drop-in swap.
- **Native subflow temptation**: if a later phase wants `parentId`/`extent:'parent'` subflows (e.g. for reparenting drag), that's a larger, separable follow-up — not in this change's scope.
- **CSP confirmed compatible** (not a risk, stated for completeness): esbuild-bundled React + `@xyflow/react`, fully local, single nonce'd `<script type="module">`, no eval/inline scripts, no remote origins — zero CSP relaxation required.
- **Tooling gap**: no `.codegraph/` index exists for this repo; this exploration relied on direct targeted reads rather than CodeGraph-assisted call/impact graphs. Consider initializing CodeGraph before `sdd-design`/`sdd-tasks` for more precise blast-radius analysis.

## Ready for Proposal

Yes. Architecture is well understood, the key design fork (containment strategy) has a clear recommendation with rationale, and the biggest risk (test rewrite scope) is explicit enough to size in `sdd-tasks`. Recommend proceeding to `sdd-propose` with the C.2 + esbuild + custom-edge-with-`animateMotion` direction, flagging that the SVG-string-coupled test suites will need a substantial, budgeted rewrite — likely a candidate for its own chained-PR slice given the 400-line review budget.
