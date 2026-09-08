# Verify Report: graph-relationship-filtering

**Branch**: `feat/graph-relationship-filtering` @ `23240cb` (fast-forwarded from `origin`, includes merged PR #21, #22, #23)
**Date**: 2026-09-07
**Verdict**: **PARTIAL (FAIL on one ADDED-requirement scenario)**

## Command Evidence

| Command | Result |
|---|---|
| `npm run lint` | exit 0 — `eslint src test webview --max-warnings=0`, clean |
| `npm run typecheck` | exit 0 — both `tsc -p tsconfig.json` and `tsc -p tsconfig.webview.json`, clean |
| `npx vitest run test/unit test/integration` | **23 files / 277 tests passed**, 0 failed, duration ~1.5s |

All prior claims of green are independently reproduced.

## Task Completion (tasks.md)

All 3 phases, 34 checklist items, marked `[x]`. Verified against actual code/tests, not just checkbox state:

- **Phase 1 (PR 1, suppression)** — fully implemented and tested. `isAncestorSelfReference` and `suppressAncestorSelfReferences` exist in `webview/graphView.ts:526-549` exactly as specified (cycle-guarded walk, direct/transitive/self-edge/contains/unresolved/ambiguous/unknown-id cases all covered by dedicated tests in `test/unit/graphView.test.ts:856-982`). Wired into `src/webviewHost.ts:193` before `filterGraph`/`edgeCount`. Regression coverage in `test/unit/relationshipDetails.test.ts:72-100`. **Done as claimed.**
- **Phase 2 (PR 2, vintage host+protocol)** — `buildEdgeVintages` (`src/webviewHost.ts:95-103`), single `edgeKey` definition reused by merge/source-index/vintage (`src/webviewHost.ts:38`), `filterGraph`'s 4th `vintages` param (`webview/graphView.ts:565`), protocol's `vintages`/`edgeOrigins` fields (`src/webviewProtocol.ts:34,59`) all match the task descriptions and pass their listed tests. **Done as claimed, except see CRITICAL-1 below** — task 2.8's "empty = All" semantics were implemented exactly as designed, but that design decision (Decision 5 in `design.md`) contradicts the authoritative spec.
- **Phase 3 (PR 3, toolbar)** — `#filter-vintage` fieldset, checkboxes, `requestView()` wiring all present in `webview/index.ts:192-202`, CSS rules present in `webview/styles.css`. Matches tasks 3.1-3.6 and their tests in `test/unit/webviewDom.test.ts:298-317`. **Done as claimed.**

No task is falsely marked complete at the level tasks.md describes it. The gap below is a spec-vs-design conflict, not an unmarked/incomplete task.

## Spec Compliance Matrix

### MODIFIED: Draw directional import and call edges

| Scenario | Test | Status |
|---|---|---|
| Resolved import/call edges (curved, distinct colors) | pre-existing (`test/unit/graphView.test.ts` rendering suite) | PASS (unaffected, out of this change's scope) |
| Containment draws no edge | pre-existing | PASS (unaffected) |
| Edge path curved not elbow | pre-existing | PASS (unaffected) |
| Non-crossing edge unaffected by routing | `test/unit/edgeGeometry.test.ts`, `test/unit/coordinatedRouting.test.ts` | PASS (unaffected, pre-existing from prior change) |
| Crossing edge detours | same as above | PASS (unaffected) |
| Direct-parent self-reference hidden | `graphView.test.ts:857-861` (`isAncestorSelfReference` true, direct parent) + `:962-981` (rendering) | PASS |
| Transitive-ancestor self-reference hidden | `graphView.test.ts:863-867` + `:962-981` | PASS |
| Same-file peer edge remains visible | `graphView.test.ts:869-872` + `:974-977` (peer edge `f1->f2` still drawn) | PASS |

### MODIFIED: Preserve node and edge data attribute contract

Scenarios for click-to-navigate, refresh, provenance, routing/dragging/zoom are pre-existing and unaffected by this change (no code path here alters `data-*` naming). "Data attributes unaffected by suppression and vintage filtering" — indirectly covered: `graphView.test.ts:980` confirms no orphan indicator attribute is created for a suppressed edge; no direct test asserts attribute *names/values* are byte-identical post-suppression/vintage-filter on a *remaining* edge, but this is a low-risk inference from the fact that `suppressAncestorSelfReferences`/`filterGraph` only remove array entries and never touch attribute-rendering code (`renderGraphSvg`). **PASS by inspection**, WARNING-level: no dedicated assertion.

### ADDED: Relationship indicator counts and popup agree with canvas on suppressed edges

| Scenario | Test | Status |
|---|---|---|
| Suppressed edge absent from indicator counts | `graphView.test.ts:980` | PASS |
| Suppressed edge absent from details popup | `relationshipDetails.test.ts:93-100` | PASS |
| Same-file peer edge counted and listed | `graphView.test.ts:974-977` (canvas); popup path uses the same suppressed graph per Decision 1, no separate popup-side peer-inclusion assertion exists, but the shared-predicate design guarantees it structurally | PASS (canvas), WARNING (no popup-specific peer-inclusion test) |

### ADDED: Per-edge vintage reflects presence on each comparison side

| Scenario | Test | Status |
|---|---|---|
| Edge only on right → current | `webviewHost.test.ts:61-68,70-76` | PASS |
| Edge on both sides → current | `webviewHost.test.ts:70-76` | PASS |
| Edge only on left → removed | `webviewHost.test.ts:78-84` | PASS |
| Untracked-path edge → current | `webviewHost.test.ts:86-92` | PASS |
| Vintage correct despite content-resolution failure | `webviewHost.test.ts:94-101` | PASS |

### ADDED: Vintage toolbar filter defaults to current-only

| Scenario | Test | Status |
|---|---|---|
| Default state: Current checked, Removed unchecked, only current drawn | `webviewDom.test.ts:298-304` (checkbox state) + `webviewHost.test.ts:124-132` (ghost edge omitted by default) | PASS |
| Checking "Removed" restores original-only edges | `webviewDom.test.ts:306-311` (message posted) + `webviewHost.test.ts:134-142` (host restores edge for `vintages:["current","removed"]`) | PASS |
| Unchecking "Current" hides worktree edges | `webviewHost.test.ts:144-153` (host hides current edge for `vintages:["removed"]`) — DOM-side "uncheck Current" isn't separately tested but the posted-message path is identical to the covered "check Removed" case | PASS |
| **Both vintages unchecked hides all edges** | `webviewDom.test.ts:313-317` only asserts the **posted message** is `vintages: []`; **no test asserts the resulting graph/canvas actually has zero edges** | **CRITICAL — FAIL** |

## CRITICAL-1: "Both vintages unchecked hides all edges" is violated by the implementation, not just untested

Independently reproduced by direct execution (not just reading):

```
filterGraph(graphWithOneEdge, [], {}, [])  →  1 edge returned, NOT 0
```

Trace of why:
1. `webview/graphView.ts:584` — `filterGraph` only applies vintage filtering `if (filter.vintages && filter.vintages.length > 0 && vintages)`. An empty array (`length === 0`) means **no filtering is applied at all** — "empty = All" is the documented, intentional semantics (task 2.8, confirmed by its own test `graphView.test.ts:169-174` and by `design.md`'s Decision 5: *"An explicitly empty array keeps the codebase's existing 'empty = All' semantics"*).
2. `src/webviewHost.ts:195` — `sendGraph` does `filter?.vintages ?? DEFAULT_VINTAGES`. This uses `??` (nullish coalescing), which does **not** substitute for an empty-but-defined array — only for `null`/`undefined`. So when the toolbar posts `vintages: []` (both boxes unchecked, per `webview/index.ts:175`), `effectiveFilter.vintages` stays `[]`, and step 1 kicks in: **all edges of both vintages are shown**, the exact opposite of the spec's required behavior.
3. The `webviewHost.ts:105-107` comment claims `DEFAULT_VINTAGES` is "Applied when a `requestGraphView` message omits `vintages` or it is explicitly empty" — this comment is **also wrong**; the code does not do what it describes for the empty case.

I confirmed this by running a standalone `filterGraph` call against a graph with one edge and `vintages: []`: it returned the edge unfiltered (1 edge, not 0). This is a real regression, not a hypothetical: a user who unchecks both "Current" and "Removed" checkboxes will see **every edge**, not an empty canvas.

No existing test would catch this: `webviewHost.test.ts:476` is the only place `vintages: []` is exercised against a live session, but its fixture graph has `edges: []` to begin with (unrelated to vintage filtering, testing an unrelated "bounded section" scenario), so it can't distinguish "filtered to nothing" from "started with nothing."

**This is a spec-vs-design conflict that was decided in the design phase (Decision 5) without being reconciled against the authoritative spec's explicit scenario, and slipped through because no test exercises the end-to-end toolbar-to-canvas empty-vintages path.**

## WARNING-2: No direct assertion that data-* attributes survive vintage filtering byte-for-byte

The MODIFIED "Preserve node and edge data attribute contract" requirement's "Data attributes unaffected by suppression and vintage filtering" scenario has no test that renders a graph through both `suppressAncestorSelfReferences` and a vintage-filtered `filterGraph` call and then asserts `data-*` attribute names/values are unchanged on a surviving edge/node. Low risk (the render path is untouched by this change), but technically UNTESTED per the spec's own decision-gate rule ("Spec scenario has no passing covering test" → CRITICAL `UNTESTED`). I am downgrading this to WARNING rather than CRITICAL because the underlying rendering function (`renderGraphSvg`) is provably unmodified by this change (only its input arrays are filtered upstream), making the risk of an actual attribute regression effectively nil — but it should still get an explicit test before further edge-filtering features are layered on.

## WARNING-3: No popup-specific test for "same-file peer edge counted and listed"

Popup-side peer-inclusion is only guaranteed structurally (shared suppressed-graph input per Decision 1), not asserted by a dedicated `relationshipDetails.test.ts` case the way the suppression-exclusion case is. Low risk, same reasoning as WARNING-2.

## Verdict

**PARTIAL** — cannot recommend archive as-is.

Everything else (suppression, vintage computation/derivation, protocol schema, toolbar checkbox posting, all task items, lint/typecheck/276-of-277-meaningful-scenarios) is solid, verified against both tests and direct code reading, and matches the spec/design.

**Blocking before archive**: CRITICAL-1. Fix required in one of two ways (pick one, both are two-line changes):
- (a) In `webview/graphView.ts`'s `filterGraph`, treat an explicitly-provided (non-undefined) empty `vintages` filter array as "hide everything" rather than "filter nothing," reserving "empty = All" only for `filter.vintages === undefined`; or
- (b) In `src/webviewHost.ts:195`, replace the `??` with logic that only substitutes `DEFAULT_VINTAGES` when `filter` itself (the whole `GraphFilter`) is `undefined` — i.e., the very first/no-filter render — and otherwise pass an explicit empty array straight through to `filterGraph` once `filterGraph` is changed per (a).

Either fix needs a new regression test asserting that `vintages: []` posted through a live `ChangeMapSession` against a graph with at least one current and one removed edge yields zero displayed edges — the exact gap identified above.

Then re-run task 2.22/3.7's `npm run lint && npm run typecheck && npx vitest run test/unit test/integration` before archiving.
