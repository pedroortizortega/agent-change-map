# Verify Report: graph-relationship-filtering (RE-VERIFICATION)

**Branch**: `feat/graph-relationship-filtering` @ `de353b0` (fast-forwarded from `origin`, includes merged PR #21, #22, #23, #24)
**Date**: 2026-09-07
**Verdict**: **PASS**

## What changed since the prior PARTIAL verdict

PR #24 (`2c53c7f fix(graph): unchecking both vintage checkboxes hides all edges`) is present on
the branch. It changes `webview/graphView.ts`'s `filterGraph` vintage condition from:

```ts
if (filter.vintages && filter.vintages.length > 0 && vintages) { ... }
```

to:

```ts
if (filter.vintages !== undefined && vintages) { ... }
```

This distinguishes `filter.vintages` being entirely absent (`undefined` — skip vintage
filtering, matching the "empty = All" convention shared with `scopeIds`/`relationshipKinds`/
`changeStatuses`) from being explicitly `[]` (the vintage checkbox pair with both boxes
unchecked — filter to nothing, per the spec's "Both vintages unchecked hides all edges"
scenario). `src/webviewHost.ts:195`'s `filter?.vintages ?? DEFAULT_VINTAGES` was left
unchanged and is correct as-is: `??` only substitutes on `null`/`undefined`, never on `[]`, so
an explicit empty array from the toolbar reaches `filterGraph` unmodified and is now correctly
interpreted as "hide everything."

Two new regression tests were added:
- `test/unit/graphView.test.ts` — `filterGraph(graph, [], { vintages: [] }, vintages)` on a
  graph with both `"current"` and `"removed"` edges → asserts `filtered.edges` is `[]`.
- `test/unit/webviewHost.test.ts` — `ChangeMapSession.handleIntent({ ..., vintages: [] })`
  against a `ghostGraphs()` fixture (has both current and removed edges) → asserts the posted
  `graph` message's `edges` has length `0`. This closes the exact gap the prior report
  identified: the only previous `vintages: []` host-level test used a fixture whose
  `edges` was already `[]`, so it could not distinguish "filtered to nothing" from "started
  with nothing." The new test uses a non-empty fixture and asserts the *filtered* count.

## Independent re-verification (not just re-reading the new tests)

I re-traced `filterGraph` by direct execution against a fresh graph with one `"current"` and
one `"removed"` edge and `filter: { vintages: [] }`:

```
filterGraph(graphWithBothVintages, [], { vintages: [] }, ["current","removed"])
  → result.edges.length === 0   (confirmed via a throwaway vitest file, executed and deleted)
```

Confirmed. The previously-failing scenario now passes both by its own new test and by my
independent re-execution.

## Command Evidence (independently re-run on this branch)

| Command | Result |
|---|---|
| `npm run lint` | exit 0 — `eslint src test webview --max-warnings=0`, clean |
| `npm run typecheck` | exit 0 — both `tsc -p tsconfig.json` and `tsc -p tsconfig.webview.json`, clean |
| `npx vitest run test/unit test/integration` | **23 files / 279 tests passed**, 0 failed (was 277 before PR #24's +2 new tests), duration ~1.6s |

## Full Spec Compliance Matrix (all requirements/scenarios re-checked, not just the prior failure)

### MODIFIED: Draw directional import and call edges

| Scenario | Test | Status |
|---|---|---|
| Resolved import/call edges (curved, distinct colors) | pre-existing rendering suite | PASS |
| Containment draws no edge | pre-existing | PASS |
| Edge path curved not elbow | pre-existing | PASS |
| Non-crossing edge unaffected by routing | `edgeGeometry.test.ts`, `coordinatedRouting.test.ts` | PASS |
| Crossing edge detours | same as above | PASS |
| Direct-parent self-reference hidden | `graphView.test.ts` `isAncestorSelfReference`/rendering suites | PASS |
| Transitive-ancestor self-reference hidden | same | PASS |
| Same-file peer edge remains visible | `graphView.test.ts` (peer edge case) | PASS |

### MODIFIED: Preserve node and edge data attribute contract

| Scenario | Test | Status |
|---|---|---|
| Click-to-navigate unaffected | pre-existing | PASS |
| Contract holds after refresh | pre-existing | PASS |
| Provenance styling doesn't alter data attributes | pre-existing | PASS |
| Styling/layout survive routing, dragging, zoom | pre-existing | PASS |
| **Data attributes unaffected by suppression and vintage filtering** | No dedicated test renders through both `suppressAncestorSelfReferences` AND a vintage-filtered `filterGraph` call asserting byte-identical `data-*` on a surviving node/edge. | **PASS by inspection, WARNING (unchanged from prior report)** — `renderGraphSvg` is provably unmodified by this change; only its upstream input arrays are filtered. Not addressed by PR #24 (out of scope: PR #24 only touched the vintage-empty-array bug). Still non-blocking. |

### ADDED: Relationship indicator counts and popup agree with canvas on suppressed edges

| Scenario | Test | Status |
|---|---|---|
| Suppressed edge absent from indicator counts | `graphView.test.ts` | PASS |
| Suppressed edge absent from details popup | `relationshipDetails.test.ts` | PASS |
| Same-file peer edge counted and listed | `graphView.test.ts` (canvas); popup path shares the same suppressed-graph input per Decision 1, no dedicated popup-side peer-inclusion assertion | **PASS (canvas), WARNING (unchanged from prior report)** — no popup-specific peer-inclusion test exists. Not addressed by PR #24. Still non-blocking (structural guarantee via shared input, low risk).

### ADDED: Per-edge vintage reflects presence on each comparison side

| Scenario | Test | Status |
|---|---|---|
| Edge only on right → current | `webviewHost.test.ts` | PASS |
| Edge on both sides → current | `webviewHost.test.ts` | PASS |
| Edge only on left → removed | `webviewHost.test.ts` | PASS |
| Untracked-path edge → current | `webviewHost.test.ts` | PASS |
| Vintage correct despite content-resolution failure | `webviewHost.test.ts` | PASS |

### ADDED: Vintage toolbar filter defaults to current-only

| Scenario | Test | Status |
|---|---|---|
| Default state: Current checked, Removed unchecked, only current drawn | `webviewDom.test.ts` + `webviewHost.test.ts` | PASS |
| Checking "Removed" restores original-only edges | `webviewDom.test.ts` + `webviewHost.test.ts` | PASS |
| Unchecking "Current" hides worktree edges | `webviewHost.test.ts` | PASS |
| **Both vintages unchecked hides all edges** | `graphView.test.ts` (`filterGraph` unit) + `webviewHost.test.ts` (`ChangeMapSession.handleIntent` end-to-end, non-empty fixture) | **PASS — previously CRITICAL FAIL, now fixed and independently re-verified** |

## Task Completion (tasks.md)

All 3 phases, 34 checklist items, still marked `[x]` and match the code as described. PR #24's
fix is a post-hoc bug fix discovered during verification (not a tasks.md line item, correctly
so — it corrects a spec-vs-design conflict inside already-completed task 2.8/2.20's scope,
per its own commit message and modified inline doc comment on `filterGraph`).

## Documentation drift (non-blocking, informational)

Two comments were not updated to reflect PR #24's corrected semantics — neither affects
runtime behavior, both are just stale prose:

1. `src/webviewHost.ts:105-106` — comment says `DEFAULT_VINTAGES` is "Applied when a
   `requestGraphView` message omits `vintages` or it is explicitly empty," but as of PR #24 an
   explicit empty array is passed straight through (unfiltered by `??`) and is now interpreted
   by `filterGraph` as "hide everything," not defaulted to `["current"]`. Only an entirely
   omitted `vintages` field triggers the default.
2. `openspec/changes/graph-relationship-filtering/design.md`'s Decision 5 still states "An
   explicitly empty array keeps the codebase's existing 'empty = All' semantics," which is the
   design decision the spec's own "Both vintages unchecked hides all edges" scenario
   overrides. The design doc was not amended alongside the code fix.

Recommend a follow-up doc-only touch-up before or during archive, but this does not block
archive — the spec (the authoritative artifact) and the shipped code now agree, verified above.

## Verdict

**PASS.**

- The previously-blocking CRITICAL (vintages:[] not hiding all edges) is fixed, covered by two
  new regression tests, and independently re-confirmed by direct execution.
- No other requirement/scenario regressed: 279/279 tests pass (277 prior + 2 new), lint and
  typecheck are clean.
- The two prior WARNINGs (data-attribute-integrity across vintage-filtered rendering;
  popup-specific same-file-peer test) remain open and untouched by PR #24, but remain
  low-risk/non-blocking exactly as assessed before — they were never CRITICAL.
- Minor documentation drift noted above (stale comment + stale design decision text); does not
  block archive.

**This change is ready for `sdd-archive`.**
