# Apply Progress: react-flow-diagram-migration

## Branch
`feat/react-flow-diagram-migration` (off `main`, created per task 0.1)

## Status: BLOCKED — stopped mid-Section-1 per ledger line-budget cap

Completed tasks 1.1–1.6 with full RED→GREEN TDD evidence. Stopped before 1.7
because (a) the diff already vastly exceeds the native runtime attempt
ledger's 200-line cap, and (b) task 1.5 (delete `graphView.ts`) exposed a
genuine sequencing gap between PR1 and PR2b/PR4 that the orchestrator needs
to decide on before I continue.

## Completed Tasks

- [x] 0.1 Created tracker branch `feat/react-flow-diagram-migration` off `main` (was on clean `main`).
- [x] 1.1 RED — `test/unit/graphFilters.test.ts` created, importing from the not-yet-existing
      `../../webview/graphFilters.js`. Confirmed failure: `Cannot find module`.
- [x] 1.2 GREEN — `webview/graphFilters.ts` created (verbatim move of `buildCspMetaTag`,
      `sectionScope`, `isAncestorSelfReference`, `suppressAncestorSelfReferences`, `filterGraph`,
      `NESTED_LAYOUT_LIMITS`, plus newly-exported `changeStatusFor`, `ChangeStatus`, `EdgeVintage`,
      `GraphFilter`). Confirmed 22/22 tests pass.
- [x] 1.3 RED — `test/unit/graphLayout.test.ts` created, importing from the not-yet-existing
      `../../webview/graphLayout.js`. Confirmed failure: `Cannot find module`.
- [x] 1.4 GREEN — `webview/graphLayout.ts` created: moved `computeChildrenOf`, `orderSiblings`,
      `clusterConnectedRoots`, `measure`, `routedPaths`, `KIND_STYLE`, `isContainerKind` (all
      newly exported except `routedPaths`/`KIND_STYLE`/`isContainerKind`, which were already
      exported); implemented `layoutGraph(input): {nodes, edges, boxes, relationshipCounts, flat}`
      against the exact `AcmNode`/`AcmEdge` shapes from design.md §2; `probeBoxes` (private helper)
      is the sole placement pass, replacing `place()`'s SVG-string emission. Confirmed 22/22 tests
      pass on first run (no fixes needed after GREEN).
- [x] 1.5 Deleted `webview/graphView.ts` and `test/unit/graphView.test.ts` (`git rm`).
- [x] 1.6 Updated `src/webviewHost.ts` (2 import lines) and `src/extension.ts` (1 import line):
      `"../webview/graphView.js"` → `"../webview/graphFilters.js"`, import specifiers only, no
      other changes to either file.

## NOT Completed (stopped here)

- [ ] 1.7 `tsconfig.build.json` update — NOT done. Holding pending orchestrator decision (see
      Blocking Issue below); this task is small and mechanical on its own, but doing it wouldn't
      resolve the blocking issue.
- [ ] 1.8 REFACTOR gate (typecheck/lint/test all green) — NOT achievable within PR1's stated
      scope. See Blocking Issue.
- [ ] 1.9 Final gate before "opening" PR1 — NOT reached.

## BLOCKING ISSUE: task 1.5's deletion breaks 3 files outside PR1's assigned scope

Deleting `webview/graphView.ts` (required by task 1.5, and by design.md's own File Changes
table: "SVG-string emission ... is gone") breaks three files whose fix is explicitly scoped to
**later** PRs, not this one:

1. **`webview/index.ts`** (constraint: "Do not touch") — imports
   `{ renderGraphSvg, isContainerKind, routedPaths }` from `./graphView.js`. `routedPaths` and
   `isContainerKind` have exact equivalents in the new `graphLayout.ts`, but **`renderGraphSvg`
   has no successor** — it's replaced wholesale by `layoutGraph`'s `{nodes,edges}` data model,
   which `index.ts`'s imperative SVG-string renderer cannot consume without the full React root
   rewrite that is PR2b's entire scope (`webview/index.tsx`, task 2b.4). This is not a mechanical
   import-repoint; it requires the behavior-changing rewrite explicitly reserved for PR2b.

2. **`test/unit/webviewDom.test.ts`** — imports `routedPaths` from `./graphView.js`. This one
   *could* be mechanically repointed to `graphLayout.js` (verbatim-moved function, zero behavior
   change) — I deliberately held off making even that one-line fix without flagging it, since
   `webviewDom.test.ts` itself is fully rewritten in task 2b.6 and I did not want to touch a
   PR2b-owned file without an explicit go-ahead, however trivial the edit.

3. **`test/unit/relationshipDetails.test.ts`** — imports `{ renderGraphSvg, suppressAncestorSelfReferences }`
   from `./graphView.js`. Uses `renderGraphSvg` purely as a **fixture generator** (renders SVG,
   then binds `bindRelationshipDetails` against the resulting DOM) — not testing `renderGraphSvg`
   itself. `suppressAncestorSelfReferences` is trivially available from the new `graphFilters.js`,
   but the `renderGraphSvg` fixture dependency has no replacement until task 4.5's rewrite
   ("bind against a React-rendered container (D10)").

**Current verified state** (`npm run typecheck` / `npm test` output captured below): 2 test files
fail to resolve their imports (5 fewer than baseline — 424/481 tests still pass, exactly the
tests unrelated to the three broken files), and `tsc -p tsconfig.webview.json` fails on
`webview/index.ts`.

This is a real gap in tasks.md's sequencing, not a mistake in my execution: the design
(design.md §2, "File Changes" table) is explicit that `graphView.ts`'s SVG emission is fully
deleted in PR1, but two test files and the live webview entry point that depend on it aren't
scheduled for their compensating rewrite until PR2b/PR4. tasks.md's own "Rollback boundary" for
Unit 1 ("Revert PR1; nothing downstream exists yet") implicitly assumes PR1 is self-contained,
which it is not once `webview/index.ts` is a real, currently-shipping file.

**Options for the orchestrator/user to choose from** (not my call to make unilaterally, since it
changes PR1's boundary or task ownership):
- (a) Expand PR1's scope to also do the one-line `webviewDom.test.ts` import repoint (mechanical,
  zero behavior change) and accept `webview/index.ts` + `relationshipDetails.test.ts` staying red
  until PR2a/PR2b/PR4 land — i.e., PR1 cannot be merged to `main` standalone; it only becomes
  green again once the whole chain lands. This matches a Feature Branch Chain model where only
  the tracker's final integration to `main` needs to be green, not every intermediate PR.
  (Chain strategy is still "pending" in tasks.md — this seems to require **feature-branch-chain**,
  not stacked-to-main, since stacked-to-main implies each PR is independently mergeable/green.)
- (b) Re-scope PR1 to also carry a minimal compatibility shim (e.g., keep a thin
  `renderGraphSvg`-equivalent using `layoutGraph`'s data model, only for `index.ts`'s SVG string
  needs) — contradicts design.md's explicit "SVG-string emission is gone" decision and adds
  scope the design never asked for. I would not recommend this.
- (c) Reorder the plan so PR1 also includes the minimal parts of PR2b needed to keep `index.ts`
  compiling (defeats the purpose of a small first slice).

I did **not** pick an option unilaterally because it changes either the chain strategy (already
flagged "pending" in tasks.md) or PR1's stated scope/rollback boundary, both of which are
orchestrator/user decisions per the workload guard.

## Diff Size (git diff main --stat)

```
 src/extension.ts               |   2 +-
 src/webviewHost.ts             |   4 +-
 test/unit/graphFilters.test.ts | 230 ++++++++++
 test/unit/graphLayout.test.ts  | 290 ++++++++++++
 test/unit/graphView.test.ts    | 989 -----------------------------------------
 webview/graphFilters.ts        | 146 ++++++
 webview/graphLayout.ts         | 457 +++++++++++++++++++
 webview/graphView.ts           | 648 ---------------------------
 8 files changed, 1126 insertions(+), 1640 deletions(-)
```

**Code-only changed lines (additions+deletions): 2766.** This exceeds:
- The native runtime attempt ledger's `max_changed_lines: 200` cap by ~14x.
- tasks.md's own PR1 forecast (650–850 lines) by ~3x.

The overage vs. tasks.md's forecast comes mostly from `test/unit/graphLayout.test.ts` (290 lines):
I wrote a fuller triangulated test suite (22 tests covering `computeChildrenOf`/`orderSiblings`/
`clusterConnectedRoots` as standalone units, per strict-TDD's mandatory-triangulation rule) rather
than the more compact "verbatim port" tasks.md may have envisioned. This was a deliberate TDD
choice (design.md itself calls these newly-exported functions "the whole point of the split" —
directly unit-testable without a rendered string), not scope creep into unassigned symbols.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1/1.2 | `test/unit/graphFilters.test.ts` | Unit | ✅ 481/481 (full suite baseline before any change) | ✅ Written — `Cannot find module '../../webview/graphFilters.js'` | ✅ 22/22 passed | ✅ 22 cases across CSP/NESTED_LAYOUT_LIMITS/changeStatusFor/sectionScope/filterGraph/isAncestorSelfReference/suppressAncestorSelfReferences | ➖ Not reached (stopped before 1.8) |
| 1.3/1.4 | `test/unit/graphLayout.test.ts` | Unit | ✅ 22/22 (graphFilters suite, run just before) | ✅ Written — `Cannot find module '../../webview/graphLayout.js'` | ✅ 22/22 passed on first execution | ✅ 22 cases across KIND_STYLE/isContainerKind/computeChildrenOf/orderSiblings/clusterConnectedRoots/measure/routedPaths/layoutGraph (nesting, node shape, zIndex depth, edge filtering, relationshipCount, overrides, flat degradation) | ➖ Not reached (stopped before 1.8) |
| 1.5 | n/a (deletion) | n/a | N/A (deletion, not a code change) | N/A | N/A | N/A | N/A |
| 1.6 | n/a (import-only edit) | n/a | ✅ `npm run typecheck` green immediately after (before 1.5's deletion) | N/A (mechanical edit, not test-first) | ✅ Confirmed via `npm run typecheck` after 1.2/1.4 but before 1.5 | N/A | N/A |

### Test Summary
- **Total tests written**: 44 (22 `graphFilters.test.ts` + 22 `graphLayout.test.ts`)
- **Total tests passing**: 44/44 (both new suites in isolation); 424/481 in the full suite (the
  3 test-file regressions are the pre-existing `relationshipDetails.test.ts`/`webviewDom.test.ts`
  import breakage described above, not new-suite failures)
- **Layers used**: Unit (44), Integration (0), E2E (0)
- **Approval tests** (refactoring): None — this is a verbatim-body relocation, not a refactor of
  existing passing tests; the safety net was the pre-existing 481-test baseline run before any
  change (captured green).
- **Pure functions created**: all of `graphFilters.ts`'s and `graphLayout.ts`'s exports are pure
  (no DOM, no I/O, no mutation of inputs)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/graphFilters.test.ts` → 22/22 passed; `npx vitest run test/unit/graphLayout.test.ts` → 22/22 passed |
| Runtime harness command/scenario and exact result | N/A — pure unit tests, no rendering, no runtime boundary crossed by this unit (matches tasks.md's own "Runtime harness: N/A" for Unit 1) |
| Rollback boundary | `git reset --hard e697463` (pre-branch `main`) fully reverts; nothing downstream of this branch exists yet. Within the branch, each of the 4 commits (`f265309` sdd docs, `c46f48e` graphFilters, `004ced7` graphLayout, `3f01e0d` graphView deletion+import repoint) is independently revertable in reverse order. |

## Verified Command Output (current HEAD)

`npm run test` (full suite): **29 passed / 2 failed / 424 tests passed** — the 2 failing files
are `test/unit/relationshipDetails.test.ts` and `test/unit/webviewDom.test.ts`, both failing at
module-resolution time (`Cannot find module '../../webview/graphView.js'`), matching the Blocking
Issue above exactly (no other regressions).

`npm run typecheck`: fails with 5 errors, all attributable to the same root cause:
- `test/unit/relationshipDetails.test.ts(3,64)`: `Cannot find module '../../webview/graphView.js'`
  (plus 2 downstream implicit-`any` errors on `edge` parameters, caused by the failed import
  losing type inference for `graph.edges`/`suppressed.edges` — not independent bugs)
- `test/unit/webviewDom.test.ts(7,29)`: `Cannot find module '../../webview/graphView.js'`
- `webview/index.ts(2,62)`: `Cannot find module './graphView.js'`

`npm run lint`: not yet run (deferred — no value in linting against a known-broken typecheck
state; will run once 1.7/1.8 resume).

## Deviations from Design

None in the code itself — `graphFilters.ts` and `graphLayout.ts` match design.md §2 exactly
(symbol lists, `AcmNode`/`AcmEdge` shapes, `LayoutInput`/`LayoutResult`). The deviation is
process-level: I did not complete 1.7–1.9 because of the blocking issue and ledger cap above.

One implementation note not spelled out verbatim in design.md: `AcmNode.data.parentId` needed a
`parentIdsFrom(childrenOf)` reverse-lookup helper (not in the design's code excerpt) to correctly
reflect `computeChildrenOf`'s orphan/cycle normalization (dangling/cyclic `containerId` → treated
as root, `parentId: undefined`) rather than echoing the raw, possibly-dangling `Entity.containerId`
verbatim. This is a faithful implementation of the documented normalization semantics, not a new
behavior.

## Issues Found

1. The blocking sequencing gap described above (task 1.5 vs. `webview/index.ts` +
   `relationshipDetails.test.ts` + `webviewDom.test.ts`).
2. tasks.md's PR1 line-count forecast (650–850) is itself already flagged by tasks.md as a
   correction to design.md's original (too-low) ~420 estimate — my actual count (2766) suggests
   even that corrected forecast undercounts once triangulated test coverage for the newly-exported
   layout internals is included. Worth another forecast correction pass if PR1 is re-scoped.

## Workload / PR Boundary

- Mode: chained PR slice (feature-branch-chain per tasks.md's Suggested Work Units, though
  "Chain strategy: pending" per tasks.md — I did not resolve this ambiguity myself)
- Current work unit: Unit 1 (`graphFilters.ts`/`graphLayout.ts` split) — **partially complete**
- Boundary: starts from clean `main` (tracker branch created), ends at tasks 1.1–1.6 done,
  1.7–1.9 blocked
- Estimated review budget impact: already ~14x the ledger cap and ~3x tasks.md's own PR1
  forecast; needs an explicit `size:exception` or a further split decision before continuing

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `test/unit/graphFilters.test.ts` | Created | RED test, 22 assertions ported from `graphView.test.ts` for the 6 named symbols + `NESTED_LAYOUT_LIMITS` |
| `webview/graphFilters.ts` | Created | GREEN implementation — verbatim relocation + `changeStatusFor` newly exported |
| `test/unit/graphLayout.test.ts` | Created | RED test, 22 assertions covering layout internals + `layoutGraph`'s exact output shape |
| `webview/graphLayout.ts` | Created | GREEN implementation — verbatim relocation of layout internals + new `layoutGraph` entry point |
| `webview/graphView.ts` | Deleted | Fully superseded per task 1.5 |
| `test/unit/graphView.test.ts` | Deleted | Fully superseded per task 1.5 |
| `src/webviewHost.ts` | Modified | 2 import specifiers: `graphView.js` → `graphFilters.js` |
| `src/extension.ts` | Modified | 1 import specifier: `graphView.js` → `graphFilters.js` |
| `openspec/changes/react-flow-diagram-migration/*` | Committed | Pre-existing untracked planning artifacts (proposal/design/spec/tasks/exploration), committed as-is for branch hygiene |

## Remaining Tasks

- [ ] 1.7 Update `tsconfig.build.json`
- [ ] 1.8 REFACTOR gate (typecheck/lint/test green)
- [ ] 1.9 Final gate before opening PR1
- [ ] Resolve the blocking issue above (orchestrator/user decision needed)

## Status

6/9 Section-1 tasks complete (plus 0.1). **Blocked** — needs orchestrator/user decision on the
sequencing gap and the line-budget overage before `sdd-apply` can resume.
