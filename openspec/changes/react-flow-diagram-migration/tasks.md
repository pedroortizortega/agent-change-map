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
| Suggested split | PR1 → PR2a → **PR2b-i → PR2b-ii** → PR3 → PR4 → PR5 (7 slices; design proposed 5, PR2b split further per user decision after PR1/PR2a both overran forecast) |
| Delivery strategy | ask-on-risk |
| Chain strategy | **RESOLVED: stacked-to-main** — each PR targets the previous PR's branch and merges to `main` as it's approved; user chose this over feature-branch-chain. |

Decision needed before apply: Resolved (split into 6 chained PRs, stacked-to-main)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High (accepted by user; each PR reviewed independently)

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `graphFilters.ts`/`graphLayout.ts` split, verbatim + newly-exported symbols, `src/` import repoint | PR1 (base: tracker) | `npm test -- graphFilters` / `npm test -- graphLayout` | N/A — pure unit tests, no rendering | Revert PR1; nothing downstream exists yet |
| 2a | esbuild build script, package.json deps, tsconfig.webview.json, copy-webview-assets.mjs | PR2a (base: PR1) | `npm run build:webview` (manual, no unit test — pure build tooling) | Manual: inspect `out/webview/webview/{index.js,styles.css}` emitted | Revert PR2a only; PR1 stands alone, `build:webview` reverts to `tsc`-only |
| 2b-i | `appReducer.ts` + `AcmEntityNode.tsx`, tested in isolation, not wired into anything | PR2b-i (base: PR2a) | `npm test -- appReducer` then `npm test -- AcmEntityNode` | N/A — isolated unit/component tests | Revert PR2b-i only; nothing else references these files yet |
| 2b-ii | `index.tsx` React root wiring 2b-i's pieces; deletes old `index.ts`+`graphView.ts`; `webviewDom.test.ts` rewrite | PR2b-ii (base: PR2b-i) | `npm test -- webviewDom` | `test/e2e/scenarios.ts` click-to-navigate must stay green | Revert PR2b-ii only; PR2b-i's isolated pieces stand alone unused until this lands |
| 3 | `positionOverrides.ts` absolute redesign + container-drag cascade (D14) | PR3 (base: PR2b-ii) | `npm test -- positionOverrides` | N/A — pure unit tests | Revert PR3 only; drag persists nothing, no crash (pruneTo guard) |
| 4 | `edgeStyleConfig.ts` + `AcmKindEdge.tsx` + palette CSS + `relationshipDetails.test.ts` rewrite | PR4 (base: PR3) | `npm test -- edgeStyleConfig` then `npm test -- relationshipDetails` | Manual visual check: particle animates, popup opens/closes | Revert PR4 only; edges keep prior style values |
| 5 | Hover highlight + CSS + `.vsix` size measurement | PR5 (base: PR4) | `npm test -- webviewDom -t "hover"` | Manual: package `.vsix`, record size delta; manual perf probe at {nodes:300,edges:600} | Revert PR5 only; no hover dimming, rest of migration stands |

---

## Section 0: Setup

- [x] 0.1 Create tracker branch `feat/react-flow-diagram-migration` off `main`.

## Section 1 (PR1, base: tracker) — `graphFilters.ts` + `graphLayout.ts` split — DONE

Spec: "Render the diagram via React Flow's node/edge data model" (data-model foundation).

- [x] 1.1 RED — create `test/unit/graphFilters.test.ts` importing from `../../webview/graphFilters`, porting `filterGraph`/`sectionScope`/`isAncestorSelfReference`/`suppressAncestorSelfReferences`/`buildCspMetaTag`/`changeStatusFor` assertions verbatim from `graphView.test.ts`. Confirm it fails (module doesn't exist).
- [x] 1.2 GREEN — create `webview/graphFilters.ts`: move the listed symbols verbatim from `graphView.ts` (design §2), export `changeStatusFor` (currently private). Confirm 1.1 passes.
- [x] 1.3 RED — create `test/unit/graphLayout.test.ts` importing from `../../webview/graphLayout`, porting `measure`/placement/routing assertions from `graphView.test.ts`, plus new cases for the newly-exported `computeChildrenOf`, `orderSiblings`, `clusterConnectedRoots` (design §2 — "the whole point of the split"). Confirm it fails.
- [x] 1.4 GREEN — create `webview/graphLayout.ts`: move layout symbols, export the previously-private functions, implement `layoutGraph(input): {nodes, edges, boxes, relationshipCounts, flat}` per design's exact `AcmNode`/`AcmEdge` shapes (§2), replacing `place()` with `probeBoxes` as sole placement pass. Confirm 1.3 passes.
- [x] 1.5 **DEFERRED (sequencing correction, PR1 apply attempt 1)** — do NOT delete `webview/graphView.ts`/`test/unit/graphView.test.ts` in this PR. `webview/index.ts` (only replaced in PR2b) still imports `renderGraphSvg`/`isContainerKind`/`routedPaths` from it; deleting it here breaks a file outside PR1's scope and two test suites (`webviewDom.test.ts`, `relationshipDetails.test.ts`) that PR1 must not touch. `graphView.ts` and its test suite stay as-is, coexisting temporarily as dead code from `src/`'s perspective (superseded by `graphFilters.ts`/`graphLayout.ts` there, but still the live renderer for `webview/index.ts` until PR2b). Deletion moves to task 2b.5b, alongside `index.ts`'s deletion, when nothing references it anymore.
- [x] 1.6 Update `src/webviewHost.ts` and `src/extension.ts`: import specifier `graphView.js` → `graphFilters.js` only. (`webview/index.ts` keeps importing from `graphView.js` unchanged — untouched per PR1's scope.)
- [x] 1.7 Update `tsconfig.build.json`: `include` → add `webview/graphFilters.ts`, KEEP `webview/graphView.ts` and `webview/edgeGeometry.ts` in `include` for now (still needed transitively — `graphView.ts` isn't deleted yet, see 1.5) — this task is effectively a no-op until PR2b actually removes them; skip changing `exclude` (no `index.tsx` exists yet). Confirm `tsc -p tsconfig.build.json` still compiles cleanly with graphFilters.ts added alongside the untouched files.
- [x] 1.8 REFACTOR — run `npm run typecheck`, `npm run lint`, `npm test`; confirm full suite green.
- [x] 1.9 Final gate before opening PR1.

**PR1 result**: 525/525 tests green (44 new: 22 graphFilters + 22 graphLayout), typecheck/lint/build clean, 1130 code-only changed lines (additive-only). Branch `feat/react-flow-diagram-migration`, merged-ready, not yet pushed.

## Section 2a (PR2a, base: PR1) — Build tooling

Spec: "Render the diagram via React Flow's node/edge data model" (bundling prerequisite, no behavior visible yet).

- [x] 2a.1 Add `react`, `react-dom`, `@xyflow/react` to `dependencies`; `esbuild`, `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/dom` to `devDependencies`.
- [x] 2a.2 Create `scripts/build-webview.mjs` per design's exact esbuild config — `define: {"process.env.NODE_ENV": '"production"'}` is mandatory (D11).
- [x] 2a.3 Update `package.json`'s `build:webview` script to run `tsc --noEmit` → `build-webview.mjs` → `copy-webview-assets.mjs`.
- [x] 2a.4 Update `tsconfig.webview.json`: `jsx: "react-jsx"`, `jsxImportSource: "react"`, `noEmit: true`, include `.tsx`.
- [x] 2a.5 Modify `scripts/copy-webview-assets.mjs` to concatenate `@xyflow/react/dist/style.css` + `webview/styles.css` into one `out/webview/webview/styles.css` (vendor-first order, D7).
- [x] 2a.6 Manual verification — run `npm run build:webview`; confirm `out/webview/webview/index.js` and `styles.css` are emitted with no errors. No automated test: this is build tooling, not application logic. (Verified via temporary entry-point swap to the pre-existing `webview/index.ts`, reverted after — see apply-progress.)
- [x] 2a.7 Final gate: `npm run typecheck` green + build pipeline verified (see 2a.6 — final `webview/index.tsx` entry expectedly unresolved until PR2b creates it).

## Section 2b (PR2b, base: PR2a) — React root port

Spec: "Render the diagram via React Flow's node/edge data model", "Preserve filtering, popup, navigation, and gates under React Flow", "Preserve node and edge data attribute contract".

**Pre-split, per user decision (before any PR2b apply attempt started)**: split into 2b-i (foundational,
non-wired building blocks — safe to land independently, `webview/index.ts` untouched and still live)
and 2b-ii (the atomic switch — wires everything up, deletes the old renderer, rewrites the DOM test
suite). This mirrors design.md's own "Rollout Order" language calling PR2 "the atomic switch — the
moment the user sees React Flow"; 2b-i extracts everything that does NOT require flipping that switch.

### Section 2b-i (base: PR2a) — Reducer + node component (foundational, non-wired)

- [x] 2b-i.1 RED — create `test/unit/appReducer.test.ts` covering every `HostToWebviewMessage` case, stale-reply guards (`currentSignatureRequestId`/`currentTargetId`, `pendingAction.requestId`), oversized gate, refresh-landing `pendingInspect` — ported from `index.ts`'s `handleHostMessage` switch (read-only port; `index.ts` itself is untouched). Confirm it fails.
- [x] 2b-i.2 GREEN — create `webview/state/appReducer.ts`: pure `(AppState, HostToWebviewMessage) => AppState`. Confirm 2b-i.1 passes. Not yet imported by anything else in the tree.
- [x] 2b-i.3 RED — create a test for `webview/nodes/AcmEntityNode.tsx` (rendered in isolation via `@testing-library/react`, no `<ReactFlow>` wrapper needed): asserts the `data-node-id`/`data-node-kind`/`data-change-status` contract and container-vs-leaf rendering via `data.container`. Confirm it fails.
- [x] 2b-i.4 GREEN — create `webview/nodes/AcmEntityNode.tsx`. Confirm 2b-i.3 passes. Not yet mounted by any app root.
- [x] 2b-i.5 REFACTOR — run `npm run typecheck`, `npm run lint`, `npm test`; confirm full suite green, including the **unchanged** `webviewDom.test.ts`/`relationshipDetails.test.ts` (nothing wired yet, `webview/index.ts` and `webview/graphView.ts` are both still live and untouched).
- [x] 2b-i.6 Final gate before opening PR2b-i.

**PR2b-i result**: 569/569 tests green (44 new: 37 appReducer + 7 AcmEntityNode), typecheck/lint
clean, purely additive (`appReducer.ts`, `AcmEntityNode.tsx`, their tests, `vitest.config.ts`
extended for `.tsx`/jsdom support). Neither file is imported by `index.ts`/anything wired yet.
Branch `feat/react-flow-diagram-migration`, base: PR2a tip, stacked-to-main.

### Section 2b-ii (base: PR2b-i) — Atomic switch: wire the React root, delete the old renderer

- [x] 2b-ii.1 Create `webview/index.tsx`: `<App/>` root, `useReducer(appReducer, initialState)` (from 2b-i), single `window` message `useEffect`, `useMemo(layoutGraph)`, `<ReactFlow>` config (module-level `NODE_TYPES`/`EDGE_TYPES`), `AcmEntityNode` (from 2b-i) as the sole node type, ported panels (`#diff-panel`, `#signature-form`, `#draft-content`, `#action-status`, …) with identical element ids.
- [x] 2b-ii.2 Delete `webview/index.ts`.
- [x] 2b-ii.3 Delete `webview/graphView.ts` and `test/unit/graphView.test.ts` (deferred from 1.5 — `graphFilters.ts`/`graphLayout.ts` are now the sole successors and nothing references the old file). Update `tsconfig.build.json`: drop `webview/graphView.ts` and `webview/edgeGeometry.ts` from `include` (verify no `src/` import of `edgeGeometry.ts` remains before removing it); set `exclude` → `webview/index.tsx`.
- [x] 2b-ii.4 RED — rewrite `test/unit/webviewDom.test.ts` with `@testing-library/react` + jsdom: node/edge `data-*` contract present after render, click-to-navigate, panel ids/behavior parity. Stub `ResizeObserver`/`getBoundingClientRect` in a shared setup file per design's jsdom caveat. Confirm it fails against the just-deleted `index.ts`.
- [x] 2b-ii.5 GREEN — confirm `webviewDom.test.ts` passes against `index.tsx`/`AcmEntityNode.tsx`.
- [x] 2b-ii.6 Verify `test/e2e/scenarios.ts` click-to-navigate stays green untouched (no edits).
- [x] 2b-ii.7 REFACTOR — run `npm run typecheck`, `npm run lint`, `npm test`; confirm full suite green.
- [x] 2b-ii.8 Final gate before opening PR2b-ii.

## Section 3 (PR3, base: PR2b-ii) — `positionOverrides.ts` absolute redesign + drag cascade

Spec: "Dragged positions persist across a panel refresh", "Dragging a container repositions its descendants".

- [x] 3.1 RED — update `test/unit/positionOverrides.test.ts`: `Position{x,y}` absolute shape, `entries()`, `hydratePositionOverrides({a:{dx:1,dy:2}})` → `size === 0` (legacy-discard, D6). Confirm it fails.
- [x] 3.2 GREEN — modify `webview/positionOverrides.ts`: `Offset{dx,dy}` → `Position{x,y}`, add `entries()`, add `hydratePositionOverrides` guard (finite-value rejection). Confirm 3.1 passes.
- [x] 3.3 RED — add cascade test cases (`graphLayout.test.ts` or a new `descendantsOf.test.ts`): dragging a container persists an absolute override for every descendant at any depth (D14 scenario). Confirm it fails.
- [x] 3.4 GREEN — implement `descendantsOf(id, layoutResult)` (walks `data.parentId` chains) and wire `onNodeDragStop` in `index.tsx` per design §4's exact cascade code. Confirm 3.3 passes.
- [x] 3.5 REFACTOR — run full `npm test`; confirm stale-position-for-removed-node scenario still no-ops (`pruneTo`).
- [x] 3.6 Final gate before opening PR3.

**PR3 result**: 513/513 unit tests green (16 in `positionOverrides.test.ts`, up from 5: absolute
`{x,y}` shape, `entries()`, `hydratePositionOverrides` legacy-discard/finite-value guard,
`descendantsOf` traversal + D14 cascade persistence), typecheck/lint clean, `npm run test:e2e`
passed for real (exit code 0, all 9 scenarios completed). `descendantsOf` and `onNodeDragStop`
wiring land in `webview/positionOverrides.ts` and `webview/index.tsx` respectively, per design §4.
Branch `feat/react-flow-diagram-migration`, base: PR2b-ii tip (`656c444`), stacked-to-main.

## Section 4 (PR4, base: PR3) — `edgeStyleConfig.ts` + custom edge + palette

Spec: "Source edge visuals from a single style config module", "Draw directional import and call edges" (dash/color), "Distinguish ambiguous and unresolved edges".

- [x] 4.1 RED — create `test/unit/edgeStyleConfig.test.ts`: exact `EDGE_STYLE_BY_KIND` values, `edgeStyleFor` dispatch, invariant regex `/^var\(--acm-edge-(import|call|ambiguous)\)$/` on every `stroke`/`particle.fill`. Confirm it fails.
- [x] 4.2 GREEN — create `webview/edgeStyleConfig.ts` per design's exact code (Palette C, D13): `import` dashed `8 6`, `call` solid, `EDGE_STYLE_UNRESOLVED` dotted `2 5`. Confirm 4.1 passes.
- [x] 4.3 Create `webview/edges/AcmKindEdge.tsx`: `BaseEdge` + `<animateMotion>` particle, `mpath`/stable `pathId`, `data-edge-index`/`data-edge-kind`/`data-resolution` attrs. Wired into `index.tsx`'s module-level `EDGE_TYPES` (replacing PR2b-ii's `PlainEdge` placeholder), plus a shared `<defs>`/`<marker>` block (`acm-arrow-import`/`acm-arrow-call`, `orient="auto-start-reverse"`) rendered once inside `<ReactFlow>`, ported verbatim from the deleted `graphView.ts`'s marker markup.
- [x] 4.4 Update `webview/styles.css`: `--acm-edge-{import,call,ambiguous}` `var(--vscode-charts-*, <fallback>)` chain (Palette C, no `body.vscode-*` branch needed), `.acm-arrow-import`/`.acm-arrow-call`/`.acm-particle` coexistence rules replacing the dead `graphView.ts`-era `.edge-*`/`.arrow-*`/`.resolution-*` selectors, and fixed the pre-existing dead `.relationship-indicator` badge CSS (mismatched selector, never matched `AcmEntityNode`'s real `.acm-node-relationship-indicator` circle) to target the real markup, still driven by `--acm-edge-ambiguous` (EDGE_STYLE_UNRESOLVED's indicator-chrome contract, D12).
- [x] 4.5 RED — rewrite `test/unit/relationshipDetails.test.ts` (renamed `.test.tsx` — JSX) binding against a React-rendered container (D10): runs `graph` through the real `layoutGraph` and renders every `AcmNode` via the real `AcmEntityNode` component, replacing PR2b-ii's hand-authored `<g data-relationship-source>` stand-in markup. Confirmed it fails against the old imperative-DOM fixture before rewriting (module/markup mismatch).
- [x] 4.6 GREEN — `relationshipDetails.ts`'s `useEffect` binding in `index.tsx` was already wired from PR2b-ii (D10: source file itself stays untouched, unchanged this PR); confirmed 4.5's rewritten suite passes against it unmodified.
- [x] 4.7 DOM test — extended `webviewDom.test.ts`: each drawn edge (import/call) renders exactly one `<animateMotion>` with `mpath href` matching its own `pathId`; an ambiguous/unresolved relationship renders no `[data-edge-index]`/`.acm-edge`/`.acm-particle`/`<animateMotion>` at all (D12 regression guard, indicator-only).
- [x] 4.8 REFACTOR — ran full `npm test` (524/524), `npm run lint`, `npm run typecheck`: all green.
- [x] 4.9 Final gate before opening PR4 — `npm run test:e2e` run for real, exit code 0, all 9 scenarios completed.

**PR4 result**: 524/524 tests green (12 new: 8 `edgeStyleConfig` + 2 net `webviewDom` +
2 net `relationshipDetails`), typecheck/lint clean, `npm run test:e2e` passed for real (exit code
0, all 9 scenarios completed). 455 changed lines (347 additions / 108 deletions) across 7 files —
over the ~250-320 forecast but within the user's standing exception for this change (each PR
reviewed independently, `400-line budget risk: High` already accepted). Confirmed: the palette
resolves entirely via `var(--vscode-charts-*, <fallback>)` with no raw hex anywhere except that
CSS fallback chain (`edgeStyleConfig.ts`'s own invariant test enforces this); ambiguous/unresolved
relationships never reach `graphLayout.ts`'s `AcmEdge[]` output (`buildEdges` already filtered
`resolution.kind !== "resolved"` before this PR — verified, not "fixed") and now have an explicit
DOM regression test proving no drawn line/path/particle exists for them. `webview/index.tsx`,
`webview/styles.css`, `webview/edgeStyleConfig.ts` (new), `webview/edges/AcmKindEdge.tsx` (new).
Branch `feat/react-flow-diagram-migration`, base: PR3 tip (`337e08c`), stacked-to-main.

## Section 5 (PR5, base: PR4) — Hover highlight + measurement

Spec: "Highlight the connected subgraph on hover", "Animate a directional particle on every drawn edge" (particle must not restart on hover, D9).

- [ ] 5.1 RED — add hover-highlight cases to `webviewDom.test.ts`: hovering a node/edge adds `acm-dim` to non-connected elements and `acm-hot` to the connected subgraph; hover end restores normal styling. Confirm it fails.
- [ ] 5.2 GREEN — implement `hoverId` state + `useMemo(highlightNodes/highlightEdges)` via `getIncomers`/`getOutgoers`/`getConnectedEdges` (design §7); add `.acm-dim`/`.acm-hot`/`.acm-particle` CSS rules. Confirm 5.1 passes.
- [ ] 5.3 REFACTOR — confirm particle `durationMs` is never mutated by hover (D9); assert `<animateMotion>` is not remounted across a hover toggle.
- [ ] 5.4 Manual measurement — package the `.vsix` before/after migration, record the size delta (proposal success criterion).
- [ ] 5.5 Manual measurement — probe React Flow at `{nodes:300, edges:600}` with concurrent SMIL particles; if degraded, record as a follow-up (particle capping), not a code change in this PR.
- [ ] 5.6 Final gate: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all green before opening PR5.
