# Tasks: Migrate change-map rendering to React Flow

## Review Workload Forecast

Validated against real file sizes (not just restated from design): `webview/graphView.ts` 648
lines, `webview/index.ts` 940 lines, `webview/edgeGeometry.ts` 657 lines (unchanged),
`webview/positionOverrides.ts` 46 lines, `webview/relationshipDetails.ts` 94 lines (unchanged),
`test/unit/graphView.test.ts` 989 lines, `test/unit/positionOverrides.test.ts` 60 lines,
`test/unit/relationshipDetails.test.ts` 120 lines, `test/unit/webviewDom.test.ts` 974 lines.

The design's own PR1 (~420) and PR2 (~520) estimates assume mostly-verbatim relocation counts as
low-diff. In practice PR1 deletes/replaces 648+989=1637 existing lines across two new files
(`graphFilters.ts`, `graphLayout.ts` + their tests) while also adding newly-exported functions and
the `layoutGraph`→`{nodes,edges}` shape — realistically 650-850 changed lines, already over budget
alone. PR2 as scoped in the design bundles build tooling (~120-160 lines, genuinely small) with a
full React-root port of the 940-line `index.ts` AND a from-scratch rewrite of the 974-line
`webviewDom.test.ts` — realistically 900-1200 changed lines, far beyond any single-PR exception.

**Correction to the design's forecast**: I confirm the overall verdict (High risk, chained PRs
required) but the granular numbers are too low for PR1 and PR2. I additionally split PR2 into
PR2a (build tooling, mechanical, low risk) and PR2b (React root port, still very large — see
Risks). PR3/PR4/PR5 estimates from the design are broadly consistent with real file sizes
(`positionOverrides.ts`/`relationshipDetails.test.ts` are both small).

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~650-850 / PR2a ~120-160 / PR2b ~900-1200 / PR3 ~150-220 / PR4 ~250-320 / PR5 ~120-180 / Aggregate ~2200-2900 |
| 400-line budget risk | High (PR1 and PR2b individually exceed budget by 2-3x) |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR2a → PR2b → PR3 → PR4 → PR5 (6 slices; design proposed 5) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — orchestrator must ask the user (see Risks) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `graphFilters.ts`/`graphLayout.ts` split, verbatim + newly-exported symbols, `src/` import repoint | PR1 (base: tracker) | `npm test -- graphFilters` / `npm test -- graphLayout` | N/A — pure unit tests, no rendering | Revert PR1; nothing downstream exists yet |
| 2a | esbuild build script, package.json deps, tsconfig.webview.json, copy-webview-assets.mjs | PR2a (base: PR1) | `npm run build:webview` (manual, no unit test — pure build tooling) | Manual: inspect `out/webview/webview/{index.js,styles.css}` emitted | Revert PR2a only; PR1 stands alone, `build:webview` reverts to `tsc`-only |
| 2b | `index.tsx` React root + `appReducer.ts` + `AcmEntityNode.tsx`; `webviewDom.test.ts` rewrite | PR2b (base: PR2a) | `npm test -- appReducer` then `npm test -- webviewDom` | `test/e2e/scenarios.ts` click-to-navigate must stay green | Revert PR2b only; PR2a's build tooling stands alone unused until this lands |
| 3 | `positionOverrides.ts` absolute redesign + container-drag cascade (D14) | PR3 (base: PR2b) | `npm test -- positionOverrides` | N/A — pure unit tests | Revert PR3 only; drag persists nothing, no crash (pruneTo guard) |
| 4 | `edgeStyleConfig.ts` + `AcmKindEdge.tsx` + palette CSS + `relationshipDetails.test.ts` rewrite | PR4 (base: PR3) | `npm test -- edgeStyleConfig` then `npm test -- relationshipDetails` | Manual visual check: particle animates, popup opens/closes | Revert PR4 only; edges keep prior style values |
| 5 | Hover highlight + CSS + `.vsix` size measurement | PR5 (base: PR4) | `npm test -- webviewDom -t "hover"` | Manual: package `.vsix`, record size delta; manual perf probe at {nodes:300,edges:600} | Revert PR5 only; no hover dimming, rest of migration stands |

---

## Section 0: Setup

- [ ] 0.1 Create tracker branch `feat/react-flow-diagram-migration` off `main`.

## Section 1 (PR1, base: tracker) — `graphFilters.ts` + `graphLayout.ts` split

Spec: "Render the diagram via React Flow's node/edge data model" (data-model foundation).

- [ ] 1.1 RED — create `test/unit/graphFilters.test.ts` importing from `../../webview/graphFilters`, porting `filterGraph`/`sectionScope`/`isAncestorSelfReference`/`suppressAncestorSelfReferences`/`buildCspMetaTag`/`changeStatusFor` assertions verbatim from `graphView.test.ts`. Confirm it fails (module doesn't exist).
- [ ] 1.2 GREEN — create `webview/graphFilters.ts`: move the listed symbols verbatim from `graphView.ts` (design §2), export `changeStatusFor` (currently private). Confirm 1.1 passes.
- [ ] 1.3 RED — create `test/unit/graphLayout.test.ts` importing from `../../webview/graphLayout`, porting `measure`/placement/routing assertions from `graphView.test.ts`, plus new cases for the newly-exported `computeChildrenOf`, `orderSiblings`, `clusterConnectedRoots` (design §2 — "the whole point of the split"). Confirm it fails.
- [ ] 1.4 GREEN — create `webview/graphLayout.ts`: move layout symbols, export the previously-private functions, implement `layoutGraph(input): {nodes, edges, boxes, relationshipCounts, flat}` per design's exact `AcmNode`/`AcmEdge` shapes (§2), replacing `place()` with `probeBoxes` as sole placement pass. Confirm 1.3 passes.
- [ ] 1.5 Delete `webview/graphView.ts` and `test/unit/graphView.test.ts` (fully superseded).
- [ ] 1.6 Update `src/webviewHost.ts` and `src/extension.ts`: import specifier `graphView.js` → `graphFilters.js` only.
- [ ] 1.7 Update `tsconfig.build.json`: `include` → `graphFilters.ts`; `exclude` → `index.tsx` (design §1 diff).
- [ ] 1.8 REFACTOR — run `npm run typecheck`, `npm run lint`, `npm test`; confirm full suite green.
- [ ] 1.9 Final gate before opening PR1.

## Section 2a (PR2a, base: PR1) — Build tooling

Spec: "Render the diagram via React Flow's node/edge data model" (bundling prerequisite, no behavior visible yet).

- [ ] 2a.1 Add `react`, `react-dom`, `@xyflow/react` to `dependencies`; `esbuild`, `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/dom` to `devDependencies`.
- [ ] 2a.2 Create `scripts/build-webview.mjs` per design's exact esbuild config — `define: {"process.env.NODE_ENV": '"production"'}` is mandatory (D11).
- [ ] 2a.3 Update `package.json`'s `build:webview` script to run `tsc --noEmit` → `build-webview.mjs` → `copy-webview-assets.mjs`.
- [ ] 2a.4 Update `tsconfig.webview.json`: `jsx: "react-jsx"`, `jsxImportSource: "react"`, `noEmit: true`, include `.tsx`.
- [ ] 2a.5 Modify `scripts/copy-webview-assets.mjs` to concatenate `@xyflow/react/dist/style.css` + `webview/styles.css` into one `out/webview/webview/styles.css` (vendor-first order, D7).
- [ ] 2a.6 Manual verification — run `npm run build:webview`; confirm `out/webview/webview/index.js` and `styles.css` are emitted with no errors. No automated test: this is build tooling, not application logic.
- [ ] 2a.7 Final gate: `npm run typecheck` + `npm run build:webview` green before opening PR2a.

## Section 2b (PR2b, base: PR2a) — React root port

Spec: "Render the diagram via React Flow's node/edge data model", "Preserve filtering, popup, navigation, and gates under React Flow", "Preserve node and edge data attribute contract".

- [ ] 2b.1 RED — create `test/unit/appReducer.test.ts` covering every `HostToWebviewMessage` case, stale-reply guards (`currentSignatureRequestId`/`currentTargetId`, `pendingAction.requestId`), oversized gate, refresh-landing `pendingInspect` — ported from `index.ts`'s `handleHostMessage` switch. Confirm it fails.
- [ ] 2b.2 GREEN — create `webview/state/appReducer.ts`: pure `(AppState, HostToWebviewMessage) => AppState`. Confirm 2b.1 passes.
- [ ] 2b.3 Create `webview/nodes/AcmEntityNode.tsx`: single node component owning the `data-node-id`/`data-node-kind`/`data-change-status` contract, container-vs-leaf rendering via `data.container`.
- [ ] 2b.4 Create `webview/index.tsx`: `<App/>` root, `useReducer(appReducer, initialState)`, single `window` message `useEffect`, `useMemo(layoutGraph)`, `<ReactFlow>` config (module-level `NODE_TYPES`/`EDGE_TYPES`), ported panels (`#diff-panel`, `#signature-form`, `#draft-content`, `#action-status`, …) with identical element ids.
- [ ] 2b.5 Delete `webview/index.ts`.
- [ ] 2b.6 RED — rewrite `test/unit/webviewDom.test.ts` with `@testing-library/react` + jsdom: node/edge `data-*` contract present after render, click-to-navigate, panel ids/behavior parity. Stub `ResizeObserver`/`getBoundingClientRect` in a shared setup file per design's jsdom caveat. Confirm it fails against the deleted `index.ts`.
- [ ] 2b.7 GREEN — confirm `webviewDom.test.ts` passes against `index.tsx`/`AcmEntityNode.tsx`.
- [ ] 2b.8 Verify `test/e2e/scenarios.ts` click-to-navigate stays green untouched (no edits).
- [ ] 2b.9 REFACTOR — run `npm run typecheck`, `npm run lint`, `npm test`; confirm full suite green.
- [ ] 2b.10 Final gate before opening PR2b. **Flag for review**: this is the single largest slice (~900-1200 lines); if it proves unreviewable at that size, split further into 2b-i (reducer + root wiring) and 2b-ii (`webviewDom.test.ts` rewrite alone) before opening the PR.

## Section 3 (PR3, base: PR2b) — `positionOverrides.ts` absolute redesign + drag cascade

Spec: "Dragged positions persist across a panel refresh", "Dragging a container repositions its descendants".

- [ ] 3.1 RED — update `test/unit/positionOverrides.test.ts`: `Position{x,y}` absolute shape, `entries()`, `hydratePositionOverrides({a:{dx:1,dy:2}})` → `size === 0` (legacy-discard, D6). Confirm it fails.
- [ ] 3.2 GREEN — modify `webview/positionOverrides.ts`: `Offset{dx,dy}` → `Position{x,y}`, add `entries()`, add `hydratePositionOverrides` guard (finite-value rejection). Confirm 3.1 passes.
- [ ] 3.3 RED — add cascade test cases (`graphLayout.test.ts` or a new `descendantsOf.test.ts`): dragging a container persists an absolute override for every descendant at any depth (D14 scenario). Confirm it fails.
- [ ] 3.4 GREEN — implement `descendantsOf(id, layoutResult)` (walks `data.parentId` chains) and wire `onNodeDragStop` in `index.tsx` per design §4's exact cascade code. Confirm 3.3 passes.
- [ ] 3.5 REFACTOR — run full `npm test`; confirm stale-position-for-removed-node scenario still no-ops (`pruneTo`).
- [ ] 3.6 Final gate before opening PR3.

## Section 4 (PR4, base: PR3) — `edgeStyleConfig.ts` + custom edge + palette

Spec: "Source edge visuals from a single style config module", "Draw directional import and call edges" (dash/color), "Distinguish ambiguous and unresolved edges".

- [ ] 4.1 RED — create `test/unit/edgeStyleConfig.test.ts`: exact `EDGE_STYLE_BY_KIND` values, `edgeStyleFor` dispatch, invariant regex `/^var\(--acm-edge-(import|call|ambiguous)\)$/` on every `stroke`/`particle.fill`. Confirm it fails.
- [ ] 4.2 GREEN — create `webview/edgeStyleConfig.ts` per design's exact code (Palette C, D13): `import` dashed `8 6`, `call` solid, `EDGE_STYLE_UNRESOLVED` dotted `2 5`. Confirm 4.1 passes.
- [ ] 4.3 Create `webview/edges/AcmKindEdge.tsx`: `BaseEdge` + `<animateMotion>` particle, `mpath`/stable `pathId`, `data-edge-index`/`data-edge-kind`/`data-resolution` attrs.
- [ ] 4.4 Update `webview/styles.css`: `--acm-edge-{import,call,ambiguous}` `var(--vscode-charts-*, <fallback>)` chain, `.react-flow__*` coexistence rules.
- [ ] 4.5 RED — rewrite `test/unit/relationshipDetails.test.ts` binding against a React-rendered container (D10). Confirm it fails against the old imperative-DOM fixture.
- [ ] 4.6 GREEN — wire `relationshipDetails.ts`'s `useEffect` binding (keyed on `graphSeq`) in `index.tsx`, no source changes to `relationshipDetails.ts` itself. Confirm 4.5 passes.
- [ ] 4.7 DOM test — extend `webviewDom.test.ts`: each edge renders exactly one `<animateMotion>` with `mpath href` matching its `pathId`.
- [ ] 4.8 REFACTOR — run full `npm test`, `npm run lint`, `npm run typecheck`.
- [ ] 4.9 Final gate before opening PR4.

## Section 5 (PR5, base: PR4) — Hover highlight + measurement

Spec: "Highlight the connected subgraph on hover", "Animate a directional particle on every drawn edge" (particle must not restart on hover, D9).

- [ ] 5.1 RED — add hover-highlight cases to `webviewDom.test.ts`: hovering a node/edge adds `acm-dim` to non-connected elements and `acm-hot` to the connected subgraph; hover end restores normal styling. Confirm it fails.
- [ ] 5.2 GREEN — implement `hoverId` state + `useMemo(highlightNodes/highlightEdges)` via `getIncomers`/`getOutgoers`/`getConnectedEdges` (design §7); add `.acm-dim`/`.acm-hot`/`.acm-particle` CSS rules. Confirm 5.1 passes.
- [ ] 5.3 REFACTOR — confirm particle `durationMs` is never mutated by hover (D9); assert `<animateMotion>` is not remounted across a hover toggle.
- [ ] 5.4 Manual measurement — package the `.vsix` before/after migration, record the size delta (proposal success criterion).
- [ ] 5.5 Manual measurement — probe React Flow at `{nodes:300, edges:600}` with concurrent SMIL particles; if degraded, record as a follow-up (particle capping), not a code change in this PR.
- [ ] 5.6 Final gate: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all green before opening PR5.
