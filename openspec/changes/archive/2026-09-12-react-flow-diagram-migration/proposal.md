# Proposal: Migrate change-map rendering to React Flow (`@xyflow/react`)

## Intent

The change map is drawn by a hand-rolled SVG string builder (`renderGraphSvg`) plus a manual pointer drag state machine (`webview/index.ts`, 940 lines). Every interaction (drag, hover, zoom, edge re-route) is bespoke and re-derived on each frame, so new visual affordances cost disproportionate effort and the test suite is welded to exact SVG markup. Moving rendering onto React Flow buys interaction primitives, custom node/edge components, and a data model instead of strings — unlocking kind-styled edges, animated flow particles, and connected-subgraph hover highlight.

## Scope

### In Scope
- esbuild bundling for the webview (`bundle`, `format:esm`, `splitting:false`); `tsc -p tsconfig.webview.json --noEmit` kept for typecheck only.
- Split `webview/graphView.ts` → host-safe DOM-free `graphFilters.ts` (`filterGraph`, `sectionScope`, `changeStatusFor`, `isAncestorSelfReference`, `buildCspMetaTag`, `NESTED_LAYOUT_LIMITS`, `EdgeVintage`) + webview-only `graphLayout.ts` (`computeChildrenOf`, `orderSiblings`, `clusterConnectedRoots`, `measure`) emitting `{id, position, parentId?, data}[]`.
- `webview/index.tsx` React root mounting `<ReactFlow>`, preserving postMessage handling, `themeTokens`, refresh/oversized-confirm, click-to-navigate, relationship popup.
- `positionOverrides.ts` redesigned from `{dx,dy}` deltas to absolute positions (`onNodeDragStop` → `node.position`); LRU cap 200 and `pruneTo` retained. Explicit, spec'd behavior change.
- Custom `edgeTypes` per `Edge.kind` with per-kind dash pattern and an SVG `<animateMotion>` particle (declarative, no JS loop, no CSP relaxation).
- New `webview/edgeStyleConfig.ts` — the single source of edge visual truth.
- Hover highlight of the connected subgraph via `getConnectedEdges`/`getIncomers`/`getOutgoers`.
- Rewrite `graphView.test.ts`, `relationshipDetails.test.ts`, `webviewDom.test.ts` against the node/edge data model + rendered DOM.

### Out of Scope
- Native React Flow subflows (`parentId` + `extent:'parent'`), drag-reparenting, and parent auto-sizing.
- Any auto-layout engine (dagre/elkjs).
- Changes to `src/webviewProtocol.ts`, `src/protocol.ts`, `src/webviewHost.ts` logic, CSP policy, or `OVERSIZED_THRESHOLDS {nodes:300, edges:600}`.
- Vite; dev-server workflow inside the webview.
- Re-tuning `NESTED_LAYOUT_LIMITS` thresholds (measure, do not change, in this slice).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `change-map-visualization`: rendering engine becomes React Flow; drag persistence moves from delta-from-base to absolute positions; edges gain per-kind dash pattern plus an animated directional particle; hovering a node or edge highlights its connected subgraph; the SVG `data-*` markup contract ("Preserve node and edge data attribute contract", "Draw directional import and call edges", "Drag a node to reposition it", "Dragged positions persist across a panel refresh") is restated against React Flow's rendered DOM.

## Approach

**Build**: esbuild replaces the `tsc` emit; one nonce'd `<script type="module">` still loads a single local bundle, so CSP is unchanged. `@xyflow/react/dist/style.css` is bundled/copied alongside `styles.css`.

**Layout**: reuse the existing absolute-position containment algorithm verbatim; containers become plain non-interactive background nodes at absolute coordinates rather than true React Flow parents. This preserves the tested ordering/measuring logic and keeps one coordinate space for drag persistence.

**Edge styling — isolated configuration module.** All per-kind visuals live in `webview/edgeStyleConfig.ts`, never inline in the edge component, so alternative visual languages can be swapped or snapshot-tested without touching rendering code. Shape:

```ts
export interface EdgeKindStyle {
  stroke: string;          // CSS var reference, resolved from styles.css
  strokeWidth: number;
  dashArray?: string;      // undefined = solid
  particle: { radius: number; fill: string; durationMs: number };
}
export const EDGE_STYLE_BY_KIND: Record<"import" | "call", EdgeKindStyle>;
export const EDGE_STYLE_UNRESOLVED: EdgeKindStyle; // ambiguous/unresolved override
```

Values must preserve today's visual language, verified in `webview/styles.css` and `graphView.ts` marker defs: `import` = `var(--acm-edge-import)` `#4f9cf9`, `call` = `var(--acm-edge-call)` `#c586c0`, ambiguous/unresolved = `var(--acm-edge-ambiguous)` `#f0883e`, `stroke-width: 3`, arrowhead filled in the matching hue. Colors stay as `var(--acm-*)` references so the existing `:root` token contract and `themeTokens` handling remain authoritative; the module adds dash pattern and particle parameters as *new* per-kind dimensions on top of the unchanged palette.

**Hover**: derive the connected set with xyflow helpers and toggle a `highlighted` flag in node/edge `data`; styling consumes it from the same config module.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `webview/graphView.ts` | Removed/Split | → `graphFilters.ts` (host-safe) + `graphLayout.ts` (webview) |
| `webview/index.ts` | Removed | → `webview/index.tsx` React root |
| `webview/edgeStyleConfig.ts` | New | Isolated per-kind color/dash/particle config |
| `webview/positionOverrides.ts` | Modified | Absolute positions instead of `{dx,dy}` |
| `webview/relationshipDetails.ts` | Modified | Bound against React-rendered DOM |
| `webview/edgeGeometry.ts` | Modified | Informs custom-edge path computation |
| `webview/styles.css` | Modified | React Flow class coexistence; `--acm-*` tokens unchanged |
| `package.json`, `tsconfig.webview.json`, `scripts/copy-webview-assets.mjs` | Modified | esbuild + react/react-dom/@xyflow/react; JSX config; CSS copy |
| `src/webviewHost.ts`, `src/extension.ts` | Modified (imports only) | Repoint to `graphFilters.js` |
| `test/unit/{graphView,relationshipDetails,webviewDom}.test.ts` | Rewritten | Data-model + DOM assertions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Test rewrite (~35 SVG-string assertions + 2 more suites) blows the 400-line review budget | High | Flag as a `sdd-tasks` decision point: chained-PR slice vs `size:exception`. Not resolved here. |
| `.vsix` size growth from react + react-dom + @xyflow/react (unmeasured) | Medium | Measure packaged size before/after; record as a success criterion. |
| React Flow performance near `{nodes:300, edges:600}` (unmeasured) | Medium | Empirically probe at threshold; thresholds stay unchanged in this slice. |
| Absolute-position override migration invalidates persisted drags | Medium | Treat legacy `{dx,dy}` entries as unreadable and drop them; spec the reset explicitly. |
| Two build tools (tsc types, esbuild emit) drift | Low | `--noEmit` typecheck stays a required CI step. |
| Popup/navigate regressions from imperative DOM binding under React | Medium | Keep the `data-relationship-source` attribute contract; rewire, don't rewrite, the popup logic. |

## Rollback Plan

Single-commit revert restores `webview/graphView.ts`, `webview/index.ts`, `build:webview`, and the three test suites; no host-side (`src/`), protocol, or CSP change to unwind. Persisted position overrides are in-memory/session-scoped, so no data migration to reverse.

## Dependencies

- `esbuild` (dev), `react`, `react-dom`, `@xyflow/react` (runtime).
- Exploration artifact `sdd/react-flow-diagram-migration/explore`.

## Success Criteria

- [ ] Webview renders the change map via `<ReactFlow>` with containment, filtering (scope/relationshipKind/changeStatus/vintage), and the oversized gate intact.
- [ ] Drag persists across refresh using absolute positions; relationship popup and click-to-navigate work unchanged.
- [ ] `import` vs `call` edges differ by color *and* dash pattern, with an animated particle, all values sourced only from `edgeStyleConfig.ts`.
- [ ] Hovering a node or edge highlights its connected subgraph.
- [ ] CSP meta tag byte-identical; `src/webviewProtocol.ts` unchanged.
- [ ] `.vsix` size delta measured and recorded.
- [ ] Full test suite green.

## Proposal question round — RESOLVED

Decisions taken with the user, binding for `sdd-spec`/`sdd-design`:

1. **Legacy drag state**: persisted `{dx,dy}` overrides are **discarded** on upgrade, not migrated (session-scoped, low impact).
2. **Particle semantics**: **always animating** on every visible edge — decorative direction indicator, not gated on hover/selection, does not encode traffic/weight.
3. **Dash assignment**: **`import` = dashed** (dependency/structure relationship), **`call` = solid** (execution flow).
4. **Palette**: **rethought, not frozen**. Today's exact hexes (`#4f9cf9`/`#c586c0`/`#f0883e`) are the baseline reference only — `sdd-design` must present 2-3 concrete candidate palettes (validated for contrast in both VS Code light and dark themes, still resolved through `--acm-*` custom properties so `themeTokens` handling stays authoritative) for the user to choose from before tasks/code are written. This is now a required `sdd-design` deliverable, not an implicit constant.
5. **Ambiguous/unresolved edges**: **animated too** — gets the same particle treatment as `import`/`call` (previously: static stub, no particle, no arrowhead). `sdd-design` must decide explicitly whether the arrowhead is also added to match, and document the resolved kind's dash pattern in the same style config.
