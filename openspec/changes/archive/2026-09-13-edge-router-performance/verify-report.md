# Verify Report: edge-router-performance

**Change**: `edge-router-performance`
**Mode**: Hybrid (OpenSpec files + Engram)
**Verified against**: branch `feat/edge-router-performance`, HEAD `7e789fc` (PR0 gate + PR1-PR5 all landed: `18d1704`, `df1d39b`, `27ec49b`+`423f3b6`, `91fd180`, `b57e798`+`9a59d96`, `7e789fc`)
**Verified at**: 2026-09-13

## Overall Verdict: **PASS**

Every delta-spec requirement is implemented and backed by a genuinely passing, runtime-executed test (re-run in this session, not trusted from apply-progress narrative). All tasks in `tasks.md` are checked. Full gate (typecheck, lint, full unit suite, real e2e, build, build:webview) is green, re-run directly in this session. `src/webviewProtocol.ts`, `src/protocol.ts`, `src/webviewHost.ts` are confirmed byte-for-byte untouched (`git diff main...HEAD -- src/` is empty). `test/unit/edgeGeometry.test.ts` is confirmed to have zero diff against `main`. The one disclosed known limitation (anchor/escape-hop crossings) is accurately and narrowly documented, not silently hidden or overstated. No CRITICAL or WARNING issues found.

## Task Completion (`tasks.md`)

`rg -n "^\- \[ \]" tasks.md` → no matches. All phases (0 gate, 1, 2, 3a, crossing-fix, 3b, 4, 5) marked `[x]`, consistent with apply-progress.md's per-phase COMPLETE markers.

## Requirement-by-Requirement Verification (source + runtime evidence, not narrative trust)

### 1. "Oversized-graph gate threshold reflects a measured render budget"

- `src/webviewProtocol.ts:16-19` — confirmed directly: `OVERSIZED_THRESHOLDS = { nodes: 300, edges: 600 } as const`.
- `test/unit/graphLayout.test.ts:676` — `"computes layoutGraph at {nodes:300, edges:600} (OVERSIZED_THRESHOLDS boundary) within its 10000ms spec budget"`.
- **Ran it in this session**: `npx vitest run test/unit/graphLayout.test.ts` → PASS, real measured `4695.82ms` (well under 10000ms, consistent with apply-progress's own repeated ~4.2-6.4s measurements).
- **PASS**

### 2. "Nested layout threshold reflects a measured render budget"

- `webview/graphFilters.ts:32` — confirmed directly: `NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 } as const`, unchanged.
- `test/unit/graphLayout.test.ts:659` — `"computes layoutGraph at {nodes:60, edges:120} ... within its 2000ms spec budget"`.
- **Ran it**: PASS, real measured `3.44ms` (~580x margin).
- **PASS**

### 3. "Preserve filtering, popup, navigation, and gates under React Flow" (MODIFIED)

- `webview/index.tsx:672-676` — `<div id="oversized-consent" hidden={!state.graphSummary?.oversized}>` with a `render-full` button posting `{type:"confirmOversized", confirmed:true}` — a confirmation UI, not a hard refusal. Unchanged by this change (no diff to this block in the PR history; only routing internals touched).
- Real e2e run (`npm run test:e2e`, real VS Code Extension Development Host) includes and passes `"[e2e] oversized consent scenario ok"` in this session's output — confirms the gate-as-confirmation behavior at runtime, not just in source.
- **PASS**

### 4. "Drag a node to reposition it" (MODIFIED)

- `webview/index.tsx:490-515` (`onNodeDragStop`) builds `movedIds` (dragged node + D14 cascade via `descendantsOf`), stores `pendingDragCommitRef.current = { movedIds, previousRoutes: edgeRoutesRef.current }`, then bumps `overrideSeq` — the scoped path, not an unconditional full `layoutGraph`.
- `webview/graphLayout.ts:259-278` (`routedPaths`) — when a `DragCommitScope` is supplied, calls `scopedEdgePathsFor(boxes, routingEdges, scope.movedIds, previousForCore) ?? edgeRoutesFor(boxes, routingEdges)` — the `??` is the fallback-to-full-reroute path.
- `test/unit/graphLayout.test.ts:593` — `"completes a drag-commit re-route comfortably under 500ms at {nodes:300, edges:600} ..."`. **Ran it**: PASS, real measured `130.95ms` (well under 500ms, vs. ~4.7s for a full pass at the same size, confirmed by the sibling perf-probe test in the same run).
- Fallback test (`test/unit/graphLayout.test.ts:545`, `"falls back to a full re-route (not a crash, not an unrouted edge) when the moved edge cannot be routed at all"`) — read directly: builds a fixture where the moved edge cannot be routed, asserts `scoped.paths.get(0)`/`get(1)` both equal an independently-computed `fullReroute`'s output (the whole call degrades to a genuine full pass, not per-edge). **Ran as part of the full suite**: PASS.
- **PASS**

### 5. "Dragging a container repositions its descendants" (MODIFIED)

- `webview/index.tsx:498-503` — inside `onNodeDragStop`, `for (const descendantId of descendantsOf(node.id, layout))` adds each descendant to `movedIds` (feeding the scoped-reroute scope) and sets its absolute `positionOverrides` offset by the same `dx`/`dy` — confirms the D14 cascade mechanism is preserved and its ids are included in the scoped-reroute `movedIds` set, not routed around it.
- **PASS**

### 6. Correctness-properties requirement (folded into "Draw directional import and call edges")

- Spot-checked `test/unit/coordinatedRouting.test.ts`: genuinely property-based — orthogonality checks (`x===x||y===y`, no `C` command), clearance via `segmentIntersectsRect` against inflated boxes, port-distinctness (`n=8` duplicate edges), determinism-as-reproducibility (`edgePathsFor(b,e)).toEqual(edgePathsFor(b,e))` — self-comparison, not comparison to a historical algorithm's fixed output), self-loop, outer-lane-fallback-matches-`edgePathFor`, and a 200-seeded randomized sweep.
- The only `toEqual`/`toBe` assertions against a **fixed literal** are (a) the unresolved-stub case (`[undefined, "M128,78 L128,106"]`), which the spec explicitly permits to stay exact since it's `edgePathFor`'s own untouched single-edge fallback, and (b) two self-referential determinism checks (`edgePathsFor(...)` compared to a second call with the same input) — not byte-identical-to-old-algorithm assertions. No leftover legacy-algorithm golden assertions found.
- **Ran it**: `test/unit/coordinatedRouting.test.ts` — 18/18 PASS as part of the full suite (200-seeded sweep took 2570ms, within its 30000ms test timeout).
- **PASS**

### 7. `test/unit/edgeGeometry.test.ts` needed zero edits

- `git diff main...HEAD --stat -- test/unit/edgeGeometry.test.ts` → **empty output**, confirmed directly, not trusted from the repeated apply-progress claim.
- **PASS**

## Spec Compliance Matrix

| # | Requirement | Status | Covering test (re-run this session) |
|---|---|---|---|
| 1 | Oversized-graph gate threshold reflects a measured render budget | PASS | `graphLayout.test.ts` `{300,600} <10000ms` (4695.82ms) |
| 2 | Nested layout threshold reflects a measured render budget | PASS | `graphLayout.test.ts` `{60,120} <2000ms` (3.44ms) |
| 3 | Preserve filtering, popup, navigation, and gates under React Flow (gate stays confirmation) | PASS | e2e `oversized consent scenario ok` |
| 4 | Drag a node to reposition it — scoped re-route within 500ms + fallback | PASS | `graphLayout.test.ts` `{300,600} <500ms` (130.95ms) + fallback test |
| 5 | Dragging a container repositions its descendants — D14 cascade in scoped scope | PASS | source inspection (`descendantsOf` feeds `movedIds`) + PR4 graphLayout tests |
| 6 | Draw directional import/call edges — correctness properties, reproducibility not byte-identity | PASS | `coordinatedRouting.test.ts` (18/18) |
| 7 (holistic) | `edgeGeometry.test.ts` needed zero edits | PASS | `git diff` empty |

All 7 verified items: **PASS**.

## Full Gate — Real Execution, This Session

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, clean (both tsconfigs) |
| `npm run lint` (`--max-warnings=0`) | exit 0, clean |
| `npm test` | **590/590 tests, 36/36 files passed** |
| `npm run test:e2e` | real VS Code Extension Development Host, **exit code 0**, all scripted scenarios passed including oversized-consent |
| `npm run build` | clean |
| `npm run build:webview` | clean (1.1mb bundle, pre-existing size warning only, not a new regression) |

## Scope Boundary Check

- `git diff main...HEAD --stat -- src/` → **empty**. `src/webviewProtocol.ts`, `src/protocol.ts`, `src/webviewHost.ts` are genuinely untouched — this was purely a `webview/`-internal router rewrite, no host-side trust-boundary code touched. No scope violation.
- `rg "TODO|FIXME|XXX|HACK"` across `webview/routingGraph.ts`, `webview/routeSearch.ts`, `webview/edgeGeometry.ts`, `webview/graphLayout.ts`, `webview/index.tsx`, `src/webviewProtocol.ts` → **zero matches**. No unresolved-gap markers left in the code.

## Known Limitation Disclosure Check

The one explicitly-disclosed known limitation — anchor/escape-hop crossings (narrower than the originally-found gap), deferred after a measured ~130x regression from a hard `crossesAny` acceptance-gate attempt was reverted — is:
- Accurately documented in `apply-progress.md`'s crossing-fix section (tasks CF.1-CF.5), including the exact measured regression (~49.6s at `{100,200}` vs. ~0.4s without it).
- Accurately and narrowly documented in the test itself: `test/unit/coordinatedRouting.test.ts:45-65`'s doc comment explains precisely which crossing category remains (fixed anchor→escape hops, outside the shared visibility graph) and why the stronger fix was rejected, backed by a bounded (`<=1`) assertion rather than a false "zero crossings" claim.
- Not mentioned in the delta spec text itself, but the base spec's own language ("substantially fewer crossings than a direct path, not a guarantee of zero in general") already accommodates this — no spec contradiction, no overstatement of "fully fixed" found anywhere in spec/design/apply-progress.
- **Correctly disclosed, not hidden or overstated.**

## Review Workload / Delivery Forecast Accuracy

Tasks.md forecast `~1,500-1,900` authored lines across a 5-slice chain (High budget risk), explicitly flagging PR3a as a probable `size:exception` candidate. Apply-progress confirms this played out largely as forecast (PR3a/3b split as designed, PR4 ran over its own `~50`-line estimate at `+350/-24` but stayed under the 400-line single-PR budget without needing an exception). No unresolved forecast-vs-actual gap found.

## Issues

**CRITICAL**: None.
**WARNING**: None.
**SUGGESTION**: None beyond what apply-progress.md already self-flagged (the nested-fixture grid-blow-up risk at `|X| > ~30`, explicitly out-of-scope-for-today per Phase 0's own gate decision 0.6, and the pre-existing 1.1mb webview bundle-size warning, unrelated to this change).

## Readiness

**Ready for delivery (PR to GitHub) and eventual `sdd-archive`.** All 7 spec requirements verified against real runtime evidence gathered independently in this session (not narrative trust), all tasks checked, full gate green, scope boundary respected, known limitation honestly disclosed. No genuine unresolved gaps found that would block archive.
