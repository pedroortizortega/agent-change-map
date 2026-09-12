# Design: Migrate change-map rendering to React Flow (`@xyflow/react`)

## Technical Approach

React Flow replaces the **rendering and interaction** layer only. Everything that computes
*where things go* — `measure`/`place`-style containment layout, `orderSiblings`' Kahn sort,
`clusterConnectedRoots`, and the entire `edgeGeometry.ts` coordinated router — is preserved
verbatim and simply re-targeted: instead of emitting SVG strings, it now emits a
`{nodes, edges}` data model that `<ReactFlow>` renders. This keeps every existing geometry
test's semantics, keeps one absolute coordinate space (so drag persistence stays trivial), and
confines the rewrite to presentation.

Three modules come out of today's 649-line `webview/graphView.ts` + 940-line `webview/index.ts`:

```
graphFilters.ts   DOM-free, host-safe, dual-compiled  (what src/ imports today)
graphLayout.ts    webview-only, pure, no React        (positions + edge paths + node data)
index.tsx         React root: state, <ReactFlow>, postMessage bridge
```

`graphLayout.ts` is pure and DOM-free too — it is "webview-only" solely because the host has no
reason to import it. That purity is what makes the test strategy cheap (see Testing Strategy).

Deviation note: this design exceeds the 800-word phase budget. Precedent is
`openspec/changes/archive/2026-09-07-graph-layout-and-interaction/design.md` (~400 lines); the
phase brief required nine items resolved concretely rather than restated.

---

## Architecture Decisions

| # | Question | Rejected | Decision & rationale |
|---|---|---|---|
| D1 | Where edge paths come from | React Flow's built-in `getBezierPath`/`getSmoothStepPath` from the handle coordinates it hands the edge component | **`graphLayout.ts` computes the whole `d` string via the existing `edgePathsFor` batch router and ships it in `edge.data.path`; the custom edge renders `<BaseEdge path={data.path}/>` and ignores `sourceX/Y`/`targetX/Y`.** Built-in path helpers are per-edge and know nothing about obstacles, lane allocation, or port assignment — adopting them silently discards `routeWaypoints`, `needsOuterLaneFallback`/`outerLaneEdgePath`, and `ROUTE_CLEARANCE`, i.e. the two live-testing bug fixes that produced the current router. Passing the path through `data` costs one field and keeps the router the single source of geometry truth. |
| D2 | Containers as React Flow parents | `parentId` + `extent:"parent"` subflows | **Plain nodes at absolute positions, `zIndex` ordered (container 0, leaf 1), `draggable` per `isContainerKind`.** Explicit proposal scope decision. Real subflows force child positions to become *parent-relative*, which would fork the coordinate space used by drag persistence and by `edgePathsFor` (which is absolute-only). The `parentId` field is still emitted in node data for hit-testing and for a future subflow slice, but is **not** given to React Flow. |
| D3 | React state container | Redux/Zustand; React Flow's `useNodesState`/`useEdgesState` as the source of truth | **One `useReducer` holding the protocol-shaped snapshot (`graph`, `diff`, `sourceIndex`, `edgeSources`, `untrackedPaths`, filter/oversized/status), with `nodes`/`edges` derived by `useMemo(() => layoutGraph(...))`.** The graph is *derived data from the host*, never independently editable; storing React Flow's arrays as truth would mean reconciling two sources on every `graph` message. `useReducer` also makes the message handler a pure `(state, message) => state` function that is unit-testable without React. |
| D4 | postMessage integration | A React context/provider wrapping a message bus | **One `useEffect(() => { window.addEventListener("message", h); return () => remove }, [])` in the root that calls `dispatch({type:"host", message})`.** Single listener, single dispatch, mirrors today's single `handleHostMessage`, and keeps `window` access at exactly one site. |
| D5 | Override value shape | Keep `{dx,dy}` deltas | **Absolute `{x,y}`.** React Flow's `onNodeDragStop` hands back `node.position`, which is already absolute in the D2 coordinate space; storing a delta would require re-deriving the layout base on every drop just to subtract it. Explicit, spec'd behaviour change (supersedes Decision 3 of the 2026-09-07 design, whose `dx/dy` rationale — *nested `<g>` local transforms* — no longer exists once nodes are absolutely positioned divs). |
| D6 | Legacy override migration | Migrate `{dx,dy}` by re-deriving a base | **Discard.** Proposal resolution 1. See "Legacy state" below — verified unreachable in practice, guarded anyway. |
| D7 | CSS delivery for `@xyflow/react/dist/style.css` | A second `<link>` in `buildWebviewHtml`; `import "@xyflow/react/dist/style.css"` in the bundle | **`scripts/copy-webview-assets.mjs` concatenates vendor CSS + `webview/styles.css` into the single existing `out/webview/webview/styles.css`.** A second `<link>` changes `src/extension.ts`'s HTML (proposal restricts it to imports-only) and adds a resource to audit; a JS-side CSS import would make esbuild emit `index.css` that nothing loads, or inject a `<style>` at runtime — which `style-src ${cspSource}` (no `unsafe-inline`) blocks. Concatenation order is vendor-first so our `--acm-*` tokens and `.react-flow__*` overrides always win the cascade. |
| D8 | Hover highlight carrier | A `highlighted` boolean in node/edge `data` | **A `className` (`acm-dim`) on the node/edge objects, driven by `hoverId` in root component state.** Both re-create the arrays, but `className` changes are applied by React as an attribute update on the *existing* element, whereas a `data` change re-renders the custom edge component and risks remounting `<animateMotion>` (restarting every particle on every hover). Class-only also makes the assertion a one-liner in tests and keeps the visual values in CSS, not JS. |
| D9 | Hover vs. the always-on particle | Speed up / emphasise the particle on the connected subgraph | **Hover changes opacity and stroke emphasis only; particle duration is constant.** Mutating `<animateMotion dur>` restarts the SMIL timeline, so every particle on the connected subgraph would visibly snap back to its edge's start the instant you hover — the opposite of "resaltar el flujo". Dimming the *unrelated* 80% is what actually makes the flow read. |
| D10 | `relationshipDetails.ts` | Rewrite as React components | **Keep imperative; bind once from `useEffect` against a container `ref`, dispose on cleanup.** It is a delegated-listener + portal-to-`document.body` popup that never touches React-owned DOM — it reads `data-relationship-source` (React renders it as a real attribute) and appends its own detached `<div>`. Rewriting it would re-litigate focus management, Escape/outside-click, and positioning for zero behavioural gain. |
| D11 | esbuild `process.env.NODE_ENV` | Leave undefined | **`define: {"process.env.NODE_ENV": '"production"'}` is mandatory.** `react`/`react-dom` reference `process.env.NODE_ENV` at module scope; without the define the bundle throws `process is not defined` on load and the webview renders blank. This is the single most likely silent build failure in this change. |
| D12 | Ambiguous/unresolved edges | Reinstate a drawn stub (option ii); draw to first in-view candidate (option iii) | **RESOLVED by user: option (i), indicator-only.** Ambiguous/unresolved relationships stay undrawn — no line, no arrowhead, no particle — exactly as today. "Every edge animates" (proposal resolution 2) applies only to *drawn* edges (resolved `import`/`call` with both endpoints in view). `EDGE_STYLE_UNRESOLVED` governs only the relationship-indicator chrome, which already uses `--acm-edge-ambiguous`. Corrects the base spec's stale "renders as a dashed line" text (pre-existing drift, not introduced by this change). |
| D13 | Palette | Palette A (Baseline Refined); Palette B (Cool/Teal/Amber) | **RESOLVED by user: Palette C, "Theme-Native Charts."** `--acm-edge-{import,call,ambiguous}` resolve through `var(--vscode-charts-{blue,purple,orange}, <today's hex fallback>)`. Every installed VS Code theme supplies its own contrast-tuned values; no `body.vscode-*` branch needed. Tests assert the custom-property *name*, not a resolved color. |
| D14 | Container drag cascade | Drop the "descendants move too" requirement (containers are now plain nodes, not React Flow parents) | **RESOLVED by user: implement the cascade.** `onNodeDragStop` on a container node MUST also compute and persist an absolute override for every descendant (recursively, any depth), not only the dragged container. See §4 "Container drag cascade" below. |

---

## 1. Build

### `scripts/build-webview.mjs` (new)

```js
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["webview/index.tsx"],
  outfile: "out/webview/webview/index.js",   // exact path src/extension.ts:226 already resolves
  bundle: true,
  format: "esm",                              // <script type="module"> is unchanged
  splitting: false,                           // one file → one nonce'd <script>, CSP unchanged
  platform: "browser",
  target: ["es2022", "chrome114"],            // VS Code ^1.95 ships Chromium ≫ 114
  jsx: "automatic",
  jsxImportSource: "react",
  define: { "process.env.NODE_ENV": '"production"' },   // D11 — mandatory
  loader: { ".css": "empty" },                // safety net: a stray CSS import never emits a file
  external: [],                               // nothing is external; `acquireVsCodeApi` is a global
  minify: false,                              // keep the bundle reviewable/diffable in the .vsix
  legalComments: "none",
  sourcemap: process.env.ACM_WEBVIEW_SOURCEMAP === "1" ? "inline" : false,
  logLevel: "info",
});
```

`sourcemap` defaults **off**: an external `.map` is not fetchable under `default-src 'none'`
without adding a CSP source, and an inline map roughly doubles the `.vsix` payload the proposal
asks us to measure.

### `package.json`

```diff
-    "build:webview": "tsc -p tsconfig.webview.json && node scripts/copy-webview-assets.mjs",
+    "build:webview": "tsc -p tsconfig.webview.json --noEmit && node scripts/build-webview.mjs && node scripts/copy-webview-assets.mjs",
```

`tsc` keeps **type authority**, esbuild takes **emit authority** — esbuild strips types without
checking them, so dropping the `--noEmit` pass would let type errors ship. The existing
`typecheck` script already runs the same project and stays unchanged (belt and braces; the
`build:webview` copy is what makes a plain `npm run build` fail on a type error).

New deps: `react`, `react-dom`, `@xyflow/react` → `dependencies`;
`esbuild`, `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/dom` → `devDependencies`.

### `tsconfig.webview.json`

```diff
     "lib": ["ES2022", "DOM"],
-    "types": ["node"]
+    "types": ["node"],
+    "jsx": "react-jsx",
+    "jsxImportSource": "react",
+    "noEmit": true
   },
-  "include": ["webview/**/*.ts"]
+  "include": ["webview/**/*.ts", "webview/**/*.tsx"]
```

`noEmit` in the file (not only in the flag) guarantees no stale `tsc` output can ever shadow the
esbuild bundle at `out/webview/webview/index.js`.

### `tsconfig.build.json` (host tree)

```diff
-  "include": ["src/**/*.ts", "webview/graphView.ts", "webview/edgeGeometry.ts"],
-  "exclude": ["test/**", "webview/index.ts"]
+  "include": ["src/**/*.ts", "webview/graphFilters.ts"],
+  "exclude": ["test/**", "webview/index.tsx"]
```

`edgeGeometry.ts` drops out of the host tree: after the split, nothing under `src/` imports it
(verified — `src/` imports only `buildCspMetaTag`, `filterGraph`, `suppressAncestorSelfReferences`,
`GraphFilter`, `EdgeVintage`, all of which land in `graphFilters.ts`).

### `scripts/copy-webview-assets.mjs`

```js
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const vendor = readFileSync(require.resolve("@xyflow/react/dist/style.css"), "utf8");
const own = readFileSync(resolve("webview/styles.css"), "utf8");
const out = resolve("out/webview/webview/styles.css");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${vendor}\n/* --- agent-change-map --- */\n${own}`);
```

One output file, one `<link>`, `buildWebviewHtml` and `buildCspMetaTag` byte-identical.

---

## 2. Module split

### `webview/graphFilters.ts` — DOM-free, host-safe, dual-compiled

Exactly the symbols `src/` needs plus the pure predicates the layout shares. Every body moves
**verbatim**; only the file location changes.

```ts
export type ChangeStatus = "added" | "removed" | "modified" | "unchanged";
export type EdgeVintage  = "current" | "removed";
export interface GraphFilter { scopeIds?: string[]; relationshipKinds?: Edge["kind"][];
                               changeStatuses?: ChangeStatus[]; vintages?: EdgeVintage[] }

export const NESTED_LAYOUT_LIMITS: { readonly nodes: 60; readonly edges: 120 };

export function buildCspMetaTag(nonce: string, cspSource: string): string;
export function changeStatusFor(qualifiedName: string, diff: CorrelatedDiffEntry[]): ChangeStatus;  // now exported
export function sectionScope(graph: AnalysisGraph, scopeId: string): AnalysisGraph;
export function isAncestorSelfReference(edge: Edge, nodes: readonly Entity[]): boolean;
export function suppressAncestorSelfReferences(graph: AnalysisGraph): AnalysisGraph;
export function filterGraph(graph: AnalysisGraph, diff: CorrelatedDiffEntry[],
                            filter: GraphFilter, vintages?: readonly EdgeVintage[]): AnalysisGraph;
```

`changeStatusFor` becomes exported (it is currently module-private and duplicated in intent
between `place` and `filterGraph`); `graphLayout.ts` imports it rather than re-implementing.

`src/webviewHost.ts` and `src/extension.ts` change **imports only**:
`"../webview/graphView.js"` → `"../webview/graphFilters.js"`.

### `webview/graphLayout.ts` — webview-only, pure, no DOM, no React

```ts
export const KIND_STYLE: Record<Entity["kind"], KindStyle>;      // moved verbatim
export function isContainerKind(kind: Entity["kind"]): boolean;  // moved verbatim
export function computeChildrenOf(nodes: Entity[], edges?: readonly Edge[]): Map<string|undefined, Entity[]>;
export function orderSiblings(bucket: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[];
export function clusterConnectedRoots(roots: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[];
export function measure(node: Entity, childrenOf: Map<string|undefined, Entity[]>, memo: Map<string, Size>): Size;
export function routedPaths(edges: readonly Edge[], boxes: Map<string, Rect>): Map<number, string|undefined>;

/** THE entry point index.tsx calls. */
export function layoutGraph(input: LayoutInput): LayoutResult;
```

`computeChildrenOf` / `orderSiblings` / `clusterConnectedRoots` / `measure` become **exported**
(today private) — that is the whole point of the split: they become directly unit-testable
without a rendered string. `place()` is replaced by `probeBoxes` promoted to the only placement
pass (it already computes exactly the absolute boxes `place` did, without emitting markup).

```ts
export interface LayoutInput {
  graph: AnalysisGraph;
  diff: CorrelatedDiffEntry[];
  untrackedPaths: readonly string[];
  overrides: ReadonlyMap<string, Position>;   // absolute, applied AFTER placement
}

export interface LayoutResult {
  nodes: AcmNode[];
  edges: AcmEdge[];
  boxes: Map<string, Rect>;                   // post-override, for re-routing on drag
  relationshipCounts: Map<string, number>;
  flat: boolean;                              // true when NESTED_LAYOUT_LIMITS was exceeded
}
```

### Node output shape (exact)

```ts
export type AcmNode = {
  id: string;                                 // === Entity.id  (data-node-id)
  type: "acmEntity";                          // one nodeType; the kind lives in data
  position: { x: number; y: number };         // ABSOLUTE (D2); overrides already applied
  draggable: boolean;                         // === isContainerKind(kind)  (unchanged rule)
  selectable: true;
  zIndex: number;                             // containment depth: container behind leaf
  className?: string;                         // "acm-dim" when hover-dimmed (D8)
  width: number; height: number;              // from measure(); React Flow uses these for fitView
  data: {
    nodeId: string;                           // data-node-id
    kind: Entity["kind"];                     // data-node-kind
    qualifiedName: string;                    // label text
    status: ChangeStatus;                     // data-change-status
    provenance: "tracked" | "untracked";      // data-provenance
    container: boolean;                       // isContainerKind — drives header-only rendering
    parentId: string | undefined;             // NOT given to React Flow (D2); hit-test/debug only
    relationshipCount: number;                // 0 ⇒ no indicator rendered
    box: Rect;                                // w/h/rx/stroke-width source for the custom node
  };
};
```

There is **one** node type. A container is not a different component — it is the same component
with `data.container === true`, which suppresses body fill and uses `KIND_STYLE[kind].dasharray`,
exactly as `renderNodeRect` does today. Two components would duplicate the `data-*` contract.

### Edge output shape (exact)

```ts
export type AcmEdge = {
  id: string;                                 // `e${protocolIndex}` — stable, index-derived
  source: string; target: string;             // resolved, both in view (else no edge — see D12)
  type: "acmKind";                            // one edgeType, parameterised by data.kind
  interactionWidth: 16;                       // clickable hit area, replaces today's bare <path>
  className?: string;                         // "acm-dim" when hover-dimmed (D8)
  data: {
    edgeIndex: number;                        // data-edge-index — the PROTOCOL index, preserved
    kind: "import" | "call";                  // data-edge-kind
    resolution: EdgeResolution["kind"];       // data-resolution
    path: string;                             // the `d` from edgePathsFor (D1)
    pathId: string;                           // `acm-edge-path-${edgeIndex}` — mpath target
    title: string;                            // resolutionLabel(), rendered as <title>
  };
};
```

`data.edgeIndex` remains the **array index into `graph.edges`**, so `edgeSources[index]`,
`navigateEdge(index)`, and `relationshipDetails.ts`'s `dataset.edgeIndex` keep working untouched.

---

## 3. `webview/index.tsx`

```
index.tsx
├── <App/>                      root; useReducer(appReducer, initialState)
│   ├── useEffect: window "message" → dispatch({type:"host", message})
│   ├── useMemo:   layoutGraph({graph, diff, untrackedPaths, overrides})
│   ├── <Toolbar/>              filters + Refresh (dispatch → vscode.postMessage)
│   ├── <OversizedConsent/>     rendered iff state.oversized
│   ├── <ReactFlowProvider><GraphCanvas/></ReactFlowProvider>
│   └── <DiffPanel/> <SignatureSection/> <CallBox/> …  (ported 1:1 from index.ts)
├── nodes/AcmEntityNode.tsx
├── edges/AcmKindEdge.tsx
└── state/appReducer.ts         pure (state, HostToWebviewMessage) => state
```

**Non-graph UI is a straight port**, not a redesign: the diff panel, signature form, call box,
confirmation flow, and draft overlay keep their exact element ids (`#diff-panel`,
`#signature-form`, `#draft-content`, `#action-status`, …) because `test/e2e/scenarios.ts` and the
host protocol address them by id. They become JSX rendering the same ids; their imperative
`byId(...).textContent = …` mutations become reducer state fields.

`appReducer` is the pure heart: `(AppState, HostToWebviewMessage) => AppState`. Every case in
today's `handleHostMessage` switch maps to a reducer case. Stale-reply guards
(`currentSignatureRequestId`/`currentTargetId`, `pendingAction.requestId`) become state fields
compared inside the reducer — same logic, now testable with zero DOM.

### `<ReactFlow>` configuration

```tsx
<ReactFlow
  nodes={nodes} edges={edges}
  nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}       // module-level consts — NEVER inline
  onNodesChange={onNodesChange}                        // position changes → live re-route (D1)
  onNodeDragStop={onNodeDragStop}                      // commit absolute override
  onNodeClick={(_, n) => !suppressClick.current && choosePair(n.id)}
  onEdgeClick={(_, e) => navigateEdge(e.data.edgeIndex)}
  onNodeMouseEnter={(_, n) => setHoverId(n.id)}
  onNodeMouseLeave={() => setHoverId(undefined)}
  onEdgeMouseEnter={(_, e) => setHoverId(e.id)}
  onEdgeMouseLeave={() => setHoverId(undefined)}
  fitView fitViewOptions={{ padding: 0.1 }}            // replaces resetViewBox()
  minZoom={0.2} maxZoom={5}                            // === ZOOM_MIN/ZOOM_MAX, unchanged
  panOnScroll={false} zoomOnScroll                     // wheel = zoom-to-cursor, today's feel
  panOnDrag                                            // background drag pans (new, free)
  nodesConnectable={false} elementsSelectable
  proOptions={{ hideAttribution: false }}
  aria-label="Change map"
/>
```

`nodeTypes`/`edgeTypes` **must** be module-level constants; defining them inline remounts every
node and edge on every render, which would restart every particle animation ~60×/s during a drag.

`fitView` replaces `resetViewBox()`: a `graph` message produces a new `layoutGraph` result, and
`useFitViewOnGraph` (a `useEffect` on `state.graphSeq`) calls `fitView()` from `useReactFlow()`.
A monotonically incremented `graphSeq` — not `graph` identity — is the trigger, so a re-render
caused by hover or drag never re-fits the viewport.

**Oversized gate & refresh**: unchanged protocol. `graphSummary` sets
`state.oversized`; `<OversizedConsent hidden={!oversized}>` renders the same text plus a
`#render-full` button posting `{type:"confirmOversized", confirmed:true}`. `#trigger-refresh`
posts `{type:"requestRefresh", requestId}`. The refresh-landing behaviour (re-issue
`inspectSources` for `selectedNodeId` when `loadReason === "refresh"`) moves into the reducer's
`graph` case as a `pendingInspect` field, drained by a `useEffect` that posts it. Keeping the
post-side-effect out of the reducer keeps the reducer pure.

---

## 4. `webview/positionOverrides.ts`

```ts
export const MAX_POSITION_OVERRIDES = 200;                 // unchanged
export interface Position { x: number; y: number }         // replaces `Offset { dx, dy }`

export class PositionOverrides {
  get size(): number;
  get(id: string): Position | undefined;
  set(id: string, position: Position): void;               // delete-then-set LRU + evict oldest
  pruneTo(presentIds: Iterable<string>): void;             // unchanged
  entries(): IterableIterator<[string, Position]>;         // new: feeds layoutGraph's `overrides`
}

/** Defensive rehydration guard (D6). Returns an EMPTY store for anything that is not a map of
 *  finite absolute {x,y} — in particular for legacy `{dx,dy}` entries, which are dropped
 *  wholesale rather than reinterpreted as absolute coordinates. */
export function hydratePositionOverrides(raw: unknown): PositionOverrides;
```

`set` rejects non-finite values (`Number.isFinite(x) && Number.isFinite(y)`), so a `{dx,dy}`
object reaching it via `unknown` yields `undefined`/`undefined` and is refused rather than
written as `NaN` and rendered off-canvas.

**Legacy state — verified**: the webview calls `acquireVsCodeApi()` for `postMessage` **only**;
`getState`/`setState` are used nowhere in the repository (grep-verified across `src/`, `webview/`,
`test/`). Overrides therefore live in module memory and die with the panel. A legacy `{dx,dy}`
map cannot survive into new code by any existing path. `hydratePositionOverrides` exists so that
the invariant is *enforced at the boundary* rather than *assumed*, and so the "discard, never
misread" behaviour of proposal resolution 1 is directly testable.

**Wiring**:

```ts
const onNodeDragStop = useCallback((_: MouseEvent, node: Node) => {
  const before = layoutResult.boxes.get(node.id);                             // pre-drag absolute box
  const dx = node.position.x - (before?.x ?? node.position.x);
  const dy = node.position.y - (before?.y ?? node.position.y);
  overrides.current.set(node.id, { x: node.position.x, y: node.position.y }); // the dragged node itself
  for (const descendantId of descendantsOf(node.id, layoutResult)) {          // D14 — cascade
    const box = layoutResult.boxes.get(descendantId);
    if (box) overrides.current.set(descendantId, { x: box.x + dx, y: box.y + dy });
  }
  suppressClick.current = true;                                                // same guard as today
  setOverrideSeq(s => s + 1);                                                  // re-run layoutGraph
}, [layoutResult]);
```

`descendantsOf(id, layoutResult)` walks `data.parentId` chains over `layoutResult.nodes` (the
field D2 keeps for exactly this purpose) to collect every node nested under the dragged one, at
any depth — a plain data traversal, no React Flow API involved. It is a no-op for a leaf node
(empty descendant set), so the single-node path above is unchanged for non-container drags.

`layoutGraph` applies `overrides` after `probeBoxes` and calls `pruneTo(boxes.keys())` on every
run — the exact `applyPositionOverrides()` contract, minus the DOM. Each descendant's override is
stored individually (not as a group/anchor), so a later independent drag of one descendant simply
overwrites its own entry without disturbing its siblings' — matching the base spec's per-node
persistence model.

Live re-routing during a drag: `onNodesChange` filters `position` changes, applies them to a
`boxes` clone, and recomputes `routedPaths` over the **full** edge set (never per-edge) — the
coordinated router's invariant from the 2026-09-07 design, preserved.

---

## 5. `webview/edgeStyleConfig.ts`

```ts
export type EdgeKind = "import" | "call";

export interface EdgeKindStyle {
  /** CSS custom-property reference. NEVER a raw hex — the property value is theme-resolved. */
  stroke: `var(--acm-edge-${string})`;
  strokeWidth: number;
  dashArray?: string;                 // undefined = solid
  arrow: "filled" | "open" | "none";
  particle: { radius: number; fill: `var(--acm-edge-${string})`; durationMs: number };
}

export const EDGE_STYLE_BY_KIND: Readonly<Record<EdgeKind, EdgeKindStyle>> = {
  import: { stroke: "var(--acm-edge-import)", strokeWidth: 3, dashArray: "8 6",
            arrow: "filled",
            particle: { radius: 3, fill: "var(--acm-edge-import)", durationMs: 2600 } },
  call:   { stroke: "var(--acm-edge-call)",   strokeWidth: 3, dashArray: undefined,
            arrow: "filled",
            particle: { radius: 3, fill: "var(--acm-edge-call)",   durationMs: 1800 } },
};

/** Applies to ambiguous/unresolved relationships. Consumed ONLY by the relationship-indicator
 *  chrome (D12, resolved: indicator-only) — never by a drawn edge, since these relationships
 *  have no in-view target node and cannot exist as a React Flow edge. */
export const EDGE_STYLE_UNRESOLVED: EdgeKindStyle = {
  stroke: "var(--acm-edge-ambiguous)", strokeWidth: 3, dashArray: "2 5",
  arrow: "open",
  particle: { radius: 3, fill: "var(--acm-edge-ambiguous)", durationMs: 3200 },
};

export function edgeStyleFor(kind: EdgeKind, resolution: EdgeResolution["kind"]): EdgeKindStyle;
```

Dash assignment per proposal resolution 3: **`import` dashed** (`8 6`, structural/dependency),
**`call` solid** (execution flow). Ambiguous uses a distinct *dotted* `2 5` so it can never be
confused with `import`'s dash at a glance. `call`'s particle is faster (1800 ms) than `import`'s
(2600 ms) — execution reads as faster than dependency; both are decorative and constant (D9).

**The stroke values are CSS custom-property references, and that is the real contract.** With
Palette C (D13) they resolve via `var(--vscode-charts-*, <fallback>)` in a single `:root` block —
no `body.vscode-light`/`vscode-high-contrast` branch is needed, because VS Code itself supplies
the theme-appropriate `--vscode-charts-*` value per installed theme. This closes the gap in
today's setup, where `:root` carries dark-tuned hexes only and `#4f9cf9` on a white editor
background is ≈2.4:1 — below the 3:1 WCAG 1.4.11 minimum for non-text graphical objects.

`themeTokens` handling is untouched: it owns `--tok-*` (draft syntax colours) via CSSOM and has
never governed `--acm-*`. No overlap, no new host message.

### PALETTE — RESOLVED: Palette C, "Theme-Native Charts"

```css
:root {
  --acm-edge-import:    var(--vscode-charts-blue,   #0b5cd6);
  --acm-edge-call:      var(--vscode-charts-purple, #9b2fa0);
  --acm-edge-ambiguous: var(--vscode-charts-orange, #b04d00);
}
```

Every installed theme — light, dark, high-contrast, and third-party — supplies values its own
author already contrast-tuned against its own background; **no `body.vscode-*` branch needed at
all**, and no hard-coded hex to re-audit when VS Code ships a new default theme.

**Fallback values use Palette A's *light*-theme hexes, not today's dark-tuned ones**, closing the
grounded contrast gap this exploration found (`#4f9cf9` on white is ≈2.4:1, below the WCAG 1.4.11
3:1 floor): the fallback only engages for a theme that omits `--vscode-charts-*` entirely, and
such a theme cannot be assumed dark, so a light-safe fallback is the conservative choice.

Consequence for testing (per D13): a colour-exact visual regression test is not possible across
themes, since `--vscode-charts-*` values vary per theme. `edgeStyleConfig.test.ts`'s invariant
asserts the custom-property *reference* (`/^var\(--acm-edge-(import|call|ambiguous)\)$/`), not a
resolved colour — see Testing Strategy.

---

## 6. Custom edge component

One parameterised component; the kind only selects a config entry.

```tsx
// webview/edges/AcmKindEdge.tsx
export function AcmKindEdge({ id, data }: EdgeProps<AcmEdge>) {
  const style = edgeStyleFor(data.kind, data.resolution);
  return (
    <g className={`acm-edge acm-edge-${data.kind}`}
       data-edge-index={data.edgeIndex}
       data-edge-kind={data.kind}
       data-resolution={data.resolution}>
      <title>{data.title}</title>
      <BaseEdge id={data.pathId} path={data.path}
                markerEnd={style.arrow === "none" ? undefined : `url(#acm-arrow-${data.kind})`}
                style={{ stroke: style.stroke, strokeWidth: style.strokeWidth,
                         strokeDasharray: style.dashArray, fill: "none",
                         strokeLinejoin: "round", strokeLinecap: "round" }} />
      <circle className="acm-particle" r={style.particle.radius} fill={style.particle.fill}>
        <animateMotion dur={`${style.particle.durationMs}ms`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
          <mpath href={`#${data.pathId}`} />
        </animateMotion>
      </circle>
    </g>
  );
}
```

- `BaseEdge`'s `id` becomes the `<path id>`; `data.pathId` (`acm-edge-path-${edgeIndex}`) is
  derived from the protocol index, so it is **stable across re-layout and re-render** — an
  unstable id would break the `mpath` reference and silently kill the particle.
- `<mpath href>` (SVG2) with `xlinkHref` as a legacy fallback attribute; Chromium honours `href`.
- Arrow markers stay in a single `<defs>` rendered once by `<GraphCanvas>` inside the React Flow
  SVG, keeping today's `acm-arrow-import` / `acm-arrow-call` ids and `orient="auto-start-reverse"`.

**CSP compatibility (explicit):**

| Concern | Status |
|---|---|
| `script-src 'nonce-…'` | The whole bundle is the one nonce'd `<script type="module">`. No `eval`, no dynamic `import()`, no injected `<script>`. `splitting:false` guarantees a second chunk is never requested. |
| Inline event handlers | None. JSX `onClick` attaches via `addEventListener`; React never emits an `onclick=""` attribute. |
| `style-src ${cspSource}` (no `unsafe-inline`) | React applies the `style` prop through the **CSSOM** (`node.style.setProperty`), which `style-src` does not govern — the same mechanism `applyThemeColors` already relies on and `webview/highlight.ts` documents. No `setAttribute("style", …)` anywhere; no runtime `<style>` injection (D7 — React Flow's stylesheet is a static file). |
| `<animateMotion>` | Declarative SMIL. Not script, not style. No `requestAnimationFrame` loop, no timer, no CSP surface, and no per-frame React render. |
| `default-src 'none'` | No font, image, or network fetch is added. |

`buildCspMetaTag` is therefore **byte-identical**, and the existing test asserting its exact
policy string stays green unmodified.

---

## 7. Hover highlight

State lives in `<GraphCanvas>`: `const [hoverId, setHoverId] = useState<string|undefined>()`
(a node id or an edge id — the two namespaces are disjoint because edge ids are `e${index}`).

```ts
const { highlightNodes, highlightEdges } = useMemo(() => {
  if (!hoverId) return EMPTY;
  const node = nodes.find(n => n.id === hoverId);
  if (node) {
    const neighbours = [...getIncomers(node, nodes, edges), ...getOutgoers(node, nodes, edges)];
    return { highlightNodes: new Set([node.id, ...neighbours.map(n => n.id)]),
             highlightEdges: new Set(getConnectedEdges([node], edges).map(e => e.id)) };
  }
  const edge = edges.find(e => e.id === hoverId);
  return edge ? { highlightNodes: new Set([edge.source, edge.target]),
                  highlightEdges: new Set([edge.id]) } : EMPTY;
}, [hoverId, nodes, edges]);
```

De-emphasis is **opacity reduction on the non-connected set** — confirmed, not replaced.
Alternatives considered: greying non-connected strokes to a neutral colour (destroys the kind
encoding exactly when the user is reading relationships), or hiding them (layout appears to
change, and React Flow would re-fit). Opacity is reversible, purely visual, and one CSS rule.

```css
.react-flow__node.acm-dim, .react-flow__edge.acm-dim { opacity: 0.18; transition: opacity 120ms; }
.react-flow__edge.acm-hot .acm-edge path { stroke-width: 4; }
.react-flow__edge.acm-hot .acm-particle { r: 4; }
```

`acm-dim` is applied to everything **not** in the highlight sets; `acm-hot` to everything in
them. One `className` swap per element (D8) — the particle's `<animateMotion>` is never
re-created, so speed and phase are untouched (D9). Hover styling constants that are *visual per
kind* (emphasis stroke width, particle radius) live in `edgeStyleConfig.ts`; the dim opacity is a
global, so it lives in CSS.

---

## 8. `relationshipDetails.ts` rewiring

**Stays imperative. No restructuring.** (D10)

```tsx
const graphRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!graphRef.current || !state.graph) return;
  return bindRelationshipDetails(graphRef.current, state.graph, state.edgeSources, navigateEdge);
}, [state.graphSeq]);                 // re-bind exactly when a new graph snapshot lands
```

Why it still works, precisely:

1. React renders **real DOM**. `data-relationship-source={nodeId}` in JSX becomes a genuine
   attribute, so `target.closest("[data-relationship-source]")` resolves identically.
2. The binding is **delegated** — two capture-phase listeners on the container, not per-indicator
   listeners — so React re-rendering, adding, or removing indicator elements never invalidates it.
3. The popup is created with `doc.createElement` and appended to `doc.body`, i.e. entirely
   **outside React's tree**. React never reconciles it and cannot clobber it.
4. `popup.style.left/top` are CSSOM writes — CSP-safe for the same reason as D-table row 3 above.

The only real hazard is *lifetime*: today `disposeRelationshipDetails?.()` runs manually at the
top of the `graph` case. Under React the `useEffect` cleanup does it, keyed on `graphSeq`, which
is strictly more reliable (it also fires on unmount). One caveat to honour in implementation:
under React 18 StrictMode the effect double-invokes in development — the bundle does **not** use
StrictMode, and must not start, or the popup binds twice and `stopImmediatePropagation` makes the
second binding swallow the first's open.

---

## Data Flow

```
host ── postMessage ──► window "message" (one useEffect listener)
                              │
                              ▼
                     dispatch({type:"host", message})
                              │
                     appReducer  (PURE: state, message → state)
                              │
        ┌─────────────────────┼──────────────────────────┐
        ▼                     ▼                          ▼
   graph/diff/…        oversized/status            diff/signature/call
        │                     │                          │
        └──► useMemo layoutGraph(graph, diff, overrides) │
                    │  computeChildrenOf → orderSiblings │
                    │  → clusterConnectedRoots → measure │
                    │  → probeBoxes → apply overrides    │
                    │  → routedPaths (edgeGeometry)      │
                    ▼                                    ▼
             {nodes, edges, boxes}                  ported JSX panels
                    │
                    ├─ className ← hoverId (getConnectedEdges/Incomers/Outgoers)
                    ▼
               <ReactFlow nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}/>
                    │                          │
          AcmEntityNode (data-* contract)   AcmKindEdge (BaseEdge + animateMotion)
                    │
      onNodeDragStop → PositionOverrides.set(id, absolute) → overrideSeq++ ─┐
                                                                            │
                    ◄───────────────────── re-run layoutGraph ──────────────┘

      useEffect(ref) → bindRelationshipDetails → popup appended to document.body
```

---

## File Changes

| File | Action | Description |
|---|---|---|
| `webview/graphFilters.ts` | Create | `buildCspMetaTag`, `filterGraph`, `sectionScope`, `changeStatusFor`, `isAncestorSelfReference`, `suppressAncestorSelfReferences`, `NESTED_LAYOUT_LIMITS`, `ChangeStatus`, `EdgeVintage`, `GraphFilter` — bodies verbatim |
| `webview/graphLayout.ts` | Create | `computeChildrenOf`, `orderSiblings`, `clusterConnectedRoots`, `measure`, `routedPaths`, `KIND_STYLE`, `isContainerKind`, `layoutGraph` → `{nodes, edges, boxes}` |
| `webview/graphView.ts` | Delete | Fully replaced by the two above; SVG-string emission (`renderGraphSvg`/`renderFlatSvg`/`place`/`renderEdge`/`DEFS`) is gone |
| `webview/index.ts` | Delete | → `index.tsx` |
| `webview/index.tsx` | Create | React root, `<ReactFlow>`, message effect, ported panels |
| `webview/state/appReducer.ts` | Create | Pure `(state, HostToWebviewMessage) => state` |
| `webview/nodes/AcmEntityNode.tsx` | Create | Single node component; owns the node `data-*` contract |
| `webview/edges/AcmKindEdge.tsx` | Create | Single edge component; `BaseEdge` + particle |
| `webview/edgeStyleConfig.ts` | Create | Per-kind stroke/dash/arrow/particle; the chosen palette's tokens |
| `webview/positionOverrides.ts` | Modify | `Offset{dx,dy}` → `Position{x,y}`; `entries()`; `hydratePositionOverrides` guard; `descendantsOf` helper for container-drag cascade (D14) |
| `webview/relationshipDetails.ts` | Unchanged | Re-bound from `useEffect`; source untouched (D10) |
| `webview/edgeGeometry.ts` | Unchanged | Called by `graphLayout.ts` with the same signatures |
| `webview/highlight.ts` | Unchanged | — |
| `webview/styles.css` | Modify | `body.vscode-light`/`vscode-high-contrast` `--acm-*` branches (or Palette C's `var()` chain), `.react-flow__*` coexistence, `.acm-dim`/`.acm-hot`/`.acm-particle` |
| `scripts/build-webview.mjs` | Create | esbuild config above |
| `scripts/copy-webview-assets.mjs` | Modify | Concatenate `@xyflow/react/dist/style.css` + `styles.css` → one file |
| `package.json` | Modify | `build:webview` script; react/react-dom/@xyflow/react deps; esbuild + @types + testing-library devDeps |
| `tsconfig.webview.json` | Modify | `jsx`/`jsxImportSource`/`noEmit`; include `.tsx` |
| `tsconfig.build.json` | Modify | `include` → `graphFilters.ts`; `exclude` → `index.tsx` |
| `src/webviewHost.ts`, `src/extension.ts` | Modify | Import specifier only: `graphView.js` → `graphFilters.js` |
| `test/unit/graphView.test.ts` | Rewrite | → `graphFilters.test.ts` + `graphLayout.test.ts` |
| `test/unit/relationshipDetails.test.ts` | Rewrite | Bind against React-rendered container |
| `test/unit/webviewDom.test.ts` | Rewrite | `@testing-library/react` + jsdom |
| `test/unit/positionOverrides.test.ts` | Modify | Absolute shape + legacy-discard cases |
| `test/unit/edgeGeometry.test.ts`, `coordinatedRouting.test.ts`, `highlight.test.ts` | Unchanged | Their modules are untouched |

---

## Testing Strategy

The split exists to move assertions **down** the cost curve. Today ~35 assertions parse SVG
strings; most of them are really assertions about *positions, ordering, and attributes* that
`layoutGraph` now returns as plain data.

| Layer | What to test | Approach |
|---|---|---|
| Unit, pure, no DOM | `graphFilters`: `filterGraph` (scope/kind/status/vintage incl. the empty-`vintages` semantics), `sectionScope`, `isAncestorSelfReference`, `buildCspMetaTag` byte-exactness | Direct calls; **ports the existing assertions nearly verbatim** — cheapest, highest-value rewrite |
| Unit, pure, no DOM | `graphLayout`: `computeChildrenOf` bucketing/orphan/cycle guard, `orderSiblings` Kahn order, `clusterConnectedRoots` grouping, `measure` sizes, `layoutGraph` → exact `nodes[].position`/`width`/`height`/`data`, `edges[].data.{path,edgeIndex,pathId}`, flat fallback above `NESTED_LAYOUT_LIMITS` | Direct calls on today's `nestedGraph`/flat fixtures. **This is where the bulk of `graphView.test.ts` lands.** Coordinates are asserted as numbers, not parsed out of `transform="translate(…)"` |
| Unit, pure, no DOM | `edgeStyleConfig`: `EDGE_STYLE_BY_KIND` exact values, `edgeStyleFor` dispatch, and an invariant test that **every `stroke`/`particle.fill` matches `/^var\(--acm-/`** (no raw hex can leak in) | Snapshot + regex invariant |
| Unit, pure, no DOM | `positionOverrides`: LRU eviction at 200, recency refresh, `pruneTo`, and `hydratePositionOverrides({a:{dx:1,dy:2}})` → `size === 0` | Existing suite, adapted |
| Unit, pure, no DOM | `appReducer`: every `HostToWebviewMessage` case, stale-reply guards, oversized gate, refresh-landing `pendingInspect` | Plain `(state, msg)` calls — **new coverage that is currently only reachable through jsdom** |
| Unit, DOM (small) | Only what genuinely needs rendering: node/edge `data-*` contract present after render; hover adds `acm-dim` to non-connected elements; `onNodeDragStop` persists an absolute override that survives a re-render; relationship popup opens/closes/focuses; click-to-navigate and edge-click post the right intents; each edge renders exactly one `<animateMotion>` with an `mpath` whose `href` matches its `<path id>` | `@testing-library/react` + jsdom, rendering `<App/>` and driving it with `window.postMessage`-shaped dispatches |
| Integration | None new | No host/protocol/CSP surface changes |
| E2E | `test/e2e/scenarios.ts` click-to-navigate | **Must stay green untouched** — the element ids it addresses are preserved deliberately |

jsdom caveats to plan for (they size the DOM slice): jsdom implements neither SVG geometry APIs
nor layout, so `getBoundingClientRect()` returns zeros. React Flow needs measured dimensions to
place nodes, so the DOM suite must either stub `ResizeObserver` + `getBoundingClientRect` once in
a shared setup file, or assert on the React Flow DOM without depending on computed transforms.
Prefer the latter: assert attributes and classes, never pixel positions — **pixel positions are
already covered, exactly and cheaply, by the `graphLayout` unit layer.** SMIL is not evaluated by
jsdom either, so particle *motion* is untestable in unit tests; only its declarative presence and
`mpath` wiring are asserted, and actual animation is a manual/visual check.

---

## Threat Matrix

N/A — no request routing, shell command, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The change is presentation-layer only. The two
security-adjacent surfaces it *does* touch are audited explicitly above: the CSP table in §6
(policy string byte-identical, no `unsafe-inline`/`eval`/dynamic import introduced) and the
single-bundle/single-stylesheet resource contract in D7.

---

## Review Workload Forecast

| PR | Scope | Est. authored lines |
|---|---|---|
| #1 | `graphFilters.ts` + `graphLayout.ts` split, `src/` import repoint, tsconfig changes, `graphFilters.test.ts` + `graphLayout.test.ts` | ~420 |
| #2 | esbuild build script, package.json, `copy-webview-assets.mjs`, `index.tsx` + `appReducer.ts` + `AcmEntityNode.tsx` (render parity, no new visuals), `webviewDom.test.ts` rewrite | ~520 |
| #3 | `positionOverrides.ts` absolute redesign + container-drag cascade (D14) + drag wiring + tests | ~220 |
| #4 | `edgeStyleConfig.ts`, `AcmKindEdge.tsx`, palette CSS branches, `relationshipDetails.test.ts` rewrite | ~260 |
| #5 | Hover highlight + CSS + tests; `.vsix` size measurement recorded | ~140 |

PR #1 targets the feature/tracker branch; #2 targets #1; #3 targets #2; #4 targets #3; #5 targets
#4. A single PR lands ~1 520 authored lines, roughly 3.8× the budget. PR #2 is still over budget
on its own and may need a further split (render-parity port vs. build tooling) — `sdd-tasks`
owns that call with real file sizes in hand.

Decision needed before apply: Yes
Chained PRs recommended: Yes
400-line budget risk: High

---

## Migration / Rollout

No data migration. Persisted drag positions are module-scoped memory (no `getState`/`setState`
anywhere), so proposal resolution 1's "discard legacy `{dx,dy}`" is automatic on reload and
additionally guarded by `hydratePositionOverrides`. No host, protocol, or CSP change to unwind.
Rollback is a single-commit revert restoring `graphView.ts`, `index.ts`, the `build:webview`
script, and the three test suites; the `.vsix` shrinks back on the next package.

Rollout order follows the PR chain: #1 and #3 are behaviour-preserving refactors that can land
and sit safely; #2 is the atomic switch (the moment the user sees React Flow); #4 and #5 are
purely additive visual layers on top.

---

## Open Questions

All three blocking decisions raised during this design (palette, ambiguous/unresolved edge
treatment, container-drag cascade) are **resolved** — see D12/D13/D14. Remaining open items are
measurement tasks, not design decisions:

- [ ] `.vsix` size delta is still unmeasured (proposal success criterion). Measure during PR #5.
- [ ] React Flow performance at `{nodes:300, edges:600}` with up to 600 concurrent SMIL particles
      is unmeasured. If it degrades, the cheapest lever is capping particles to the hovered
      subgraph — which would partially reopen proposal resolution 2. Probe before `sdd-apply`
      finishes #4.
