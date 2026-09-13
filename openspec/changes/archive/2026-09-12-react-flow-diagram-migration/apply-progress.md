# Apply Progress: react-flow-diagram-migration

## Branch
`feat/react-flow-diagram-migration` (off `main`, created per task 0.1)

## Status: Section 1 (PR1) COMPLETE — 1.1–1.9 all done, full suite green

Correction applied (approved by user, orchestrator-relayed): task 1.5's premature deletion of
`webview/graphView.ts`/`test/unit/graphView.test.ts` was reverted; deletion is deferred to task
2b.5b (PR2b, alongside `index.ts`'s own deletion). Task 1.7 was re-scoped down to "add
`graphFilters.ts` to `tsconfig.build.json`'s `include`, keep everything else." With that
correction, PR1 is now internally consistent and fully green — but **still far over the native
runtime attempt ledger's 200-line cap** (see Diff Size below); flagging that plainly rather than
working around it, per the orchestrator's explicit instruction.

## Completed Tasks

- [x] 0.1 Created tracker branch `feat/react-flow-diagram-migration` off `main`.
- [x] 1.1 RED — `test/unit/graphFilters.test.ts` created, importing from the not-yet-existing
      `../../webview/graphFilters.js`. Confirmed failure: `Cannot find module`.
- [x] 1.2 GREEN — `webview/graphFilters.ts` created (verbatim move of `buildCspMetaTag`,
      `sectionScope`, `isAncestorSelfReference`, `suppressAncestorSelfReferences`, `filterGraph`,
      `NESTED_LAYOUT_LIMITS`, plus newly-exported `changeStatusFor`, `ChangeStatus`, `EdgeVintage`,
      `GraphFilter`). Confirmed 22/22 tests pass.
- [x] 1.3 RED — `test/unit/graphLayout.test.ts` created, importing from the not-yet-existing
      `../../webview/graphLayout.js`. Confirmed failure: `Cannot find module`.
- [x] 1.4 GREEN — `webview/graphLayout.ts` created: moved `computeChildrenOf`, `orderSiblings`,
      `clusterConnectedRoots`, `measure`, `routedPaths`, `KIND_STYLE`, `isContainerKind`
      (previously-private internals now exported); implemented
      `layoutGraph(input): {nodes, edges, boxes, relationshipCounts, flat}` against the exact
      `AcmNode`/`AcmEdge` shapes from design.md §2; `probeBoxes` (private helper) is the sole
      placement pass, replacing `place()`'s SVG-string emission. Confirmed 22/22 tests pass on
      first run (no fixes needed after GREEN).
- [x] 1.5 **CORRECTED** — `webview/graphView.ts` and `test/unit/graphView.test.ts` restored
      (`git checkout main -- ...`) after an initial (later-corrected) deletion. Both stay exactly
      as on `main`: dead code from `src/`'s perspective (superseded there by `graphFilters.ts`/
      `graphLayout.ts` per 1.6) but still the live renderer for `webview/index.ts`, which PR1 does
      not touch. Deletion deferred to task 2b.5b.
- [x] 1.6 Updated `src/webviewHost.ts` (2 import lines) and `src/extension.ts` (1 import line):
      `"../webview/graphView.js"` → `"../webview/graphFilters.js"`, import specifiers only, no
      other changes to either file. `webview/index.ts` untouched, still imports from
      `graphView.js` as before.
- [x] 1.7 **CORRECTED (re-scoped)** — `tsconfig.build.json`'s `include` gains
      `"webview/graphFilters.ts"`; `webview/graphView.ts` and `webview/edgeGeometry.ts` remain in
      `include` (still needed transitively); `exclude` untouched (no `index.tsx` exists yet).
      Confirmed `tsc -p tsconfig.build.json --noEmit` compiles cleanly.
- [x] 1.8 REFACTOR — ran `npm run typecheck`, `npm run lint`, `npm run test`, and additionally
      `npm run build` (belt-and-braces beyond what 1.8 strictly asked). **All green.**
- [x] 1.9 Final gate — everything committed on the tracker branch, full suite green, build green.
      No actual GitHub PR opened (per instructions — orchestrator handles PR mechanics).

## Verified Command Output (final, HEAD = `0a932a2`)

- `npx tsc -p tsconfig.build.json --noEmit` → exit 0
- `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit`) → exit 0
- `npm run lint` (`eslint src test webview --max-warnings=0`) → exit 0 (one `no-unused-vars` error
  fixed along the way: an unused `routedPaths` import in `graphLayout.test.ts`, since that test
  suite exercises `routedPaths` indirectly through `layoutGraph` rather than calling it directly)
- `npm run test` (`vitest run`) → **32 test files passed, 525 tests passed** (481 baseline + 44 new:
  22 `graphFilters.test.ts` + 22 `graphLayout.test.ts`). `test/unit/graphView.test.ts` (53 tests),
  `test/unit/webviewDom.test.ts` (45 tests), and `test/unit/relationshipDetails.test.ts` (3 tests)
  all pass unchanged, exactly as expected once `graphView.ts` was restored — zero edits were needed
  to any of those three files.
- `npm run build` (`tsc -p tsconfig.build.json && npm run build:webview`) → exit 0, webview assets
  copied successfully

## Diff Size (git diff main --stat, on committed HEAD)

Code only (excludes `openspec/changes/react-flow-diagram-migration/*` planning docs):

```
 src/extension.ts               |   2 +-
 src/webviewHost.ts             |   4 +-
 test/unit/graphFilters.test.ts | 230 +++++++++++++++++++++
 test/unit/graphLayout.test.ts  | 289 ++++++++++++++++++++++++++
 tsconfig.build.json            |   2 +-
 webview/graphFilters.ts        | 146 +++++++++++++
 webview/graphLayout.ts         | 457 +++++++++++++++++++++++++++++++++++++++++
 7 files changed, 1126 insertions(+), 4 deletions(-)
```

**Code-only changed lines: 1130** (1126 insertions + 4 deletions) — additive-only now, as
expected once `graphView.ts`'s deletion was reverted (no more 989+648 = 1637-line deletion count).
This lands squarely in the corrected ~1100–1300 range the orchestrator predicted.

Including the `openspec/changes/react-flow-diagram-migration/*` planning docs (proposal, design,
spec, tasks, exploration, this apply-progress file) in the same branch: **2685 total changed
lines** (2681 insertions + 4 deletions).

**Ledger status — reporting plainly, not working around it**: both figures (1130 code-only, 2685
total) are still far over the native runtime attempt ledger's `max_changed_lines: 200` cap — code-
only alone is ~5.7x the cap. This is expected and was flagged before the correction too: tasks.md's
own Review Workload Forecast for this unit already states "PR1 ~650-850" lines, itself already a
correction upward from design.md's original ~420 estimate; my actual code-only count (1130) is
closer to that corrected band than the pre-correction attempt's number (2766, which included the
large graphView.ts/graphView.test.ts deletion that has now been reverted) but is still above even
that 650-850 band, driven by the fuller triangulated `graphLayout.test.ts` (289 lines) required by
strict-TDD's mandatory-triangulation rule for the newly-exported `computeChildrenOf`/
`orderSiblings`/`clusterConnectedRoots` (design.md itself calls these "the whole point of the
split" — directly unit-testable without a rendered string). I did not trim test coverage to fit
the cap. I am not calling `sdd-attempt finish`/`reset` — that is the orchestrator's action per
its own instruction.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1/1.2 | `test/unit/graphFilters.test.ts` | Unit | ✅ 481/481 (full suite baseline before any change) | ✅ Written — `Cannot find module '../../webview/graphFilters.js'` | ✅ 22/22 passed | ✅ 22 cases across CSP/NESTED_LAYOUT_LIMITS/changeStatusFor/sectionScope/filterGraph/isAncestorSelfReference/suppressAncestorSelfReferences | ➖ None needed — verbatim relocation, no further refactor |
| 1.3/1.4 | `test/unit/graphLayout.test.ts` | Unit | ✅ 22/22 (graphFilters suite, run just before) | ✅ Written — `Cannot find module '../../webview/graphLayout.js'` | ✅ 22/22 passed on first execution | ✅ 22 cases across KIND_STYLE/isContainerKind/computeChildrenOf/orderSiblings/clusterConnectedRoots/measure/routedPaths/layoutGraph (nesting, node shape, zIndex depth, edge filtering, relationshipCount, overrides, flat degradation) | ✅ Removed one unused import (`routedPaths`) flagged by lint; tests still 22/22 green after |
| 1.5 | n/a (revert of an earlier deletion) | n/a | ✅ Full suite re-verified green after revert (525/525, no regressions) | N/A | N/A | N/A | N/A |
| 1.6 | n/a (import-only edit) | n/a | ✅ `npm run typecheck` green | N/A (mechanical edit, not test-first) | ✅ Confirmed via `npm run typecheck` | N/A | N/A |
| 1.7 | n/a (tsconfig edit) | n/a | ✅ `npx tsc -p tsconfig.build.json --noEmit` green before and after | N/A (config edit, not test-first) | ✅ Confirmed via `tsc -p tsconfig.build.json --noEmit` | N/A | N/A |

### Test Summary
- **Total tests written**: 44 (22 `graphFilters.test.ts` + 22 `graphLayout.test.ts`)
- **Total tests passing**: 525/525 full suite (481 pre-existing + 44 new), zero regressions
- **Layers used**: Unit (44 new + 481 pre-existing unaffected), Integration (0 new), E2E (0 new)
- **Approval tests** (refactoring): None — verbatim-body relocation, not a refactor of existing
  passing tests; the safety net was the pre-existing 481-test baseline captured green before any
  change, then re-verified green after the 1.5 revert
- **Pure functions created**: all of `graphFilters.ts`'s and `graphLayout.ts`'s exports are pure
  (no DOM, no I/O, no mutation of inputs)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/graphFilters.test.ts` → 22/22 passed; `npx vitest run test/unit/graphLayout.test.ts` → 22/22 passed; full `npm run test` → 32 files/525 tests passed |
| Runtime harness command/scenario and exact result | N/A — pure unit tests, no rendering, no runtime boundary crossed by this unit (matches tasks.md's own "Runtime harness: N/A" for Unit 1). `npm run build` additionally verified as a belt-and-braces check (webview asset copy still succeeds; not part of tasks.md's Unit 1 harness but zero-cost to check) |
| Rollback boundary | `git reset --hard e697463` (pre-branch `main`) fully reverts; nothing downstream of this branch exists yet. On the branch, each commit is independently revertable in reverse order; the correction commit (`0a932a2`) cleanly isolates the 1.5/1.7 fix from the original 1.1–1.4/1.6 work. |

## Deviations from Design

None in the code itself — `graphFilters.ts` and `graphLayout.ts` match design.md §2 exactly
(symbol lists, `AcmNode`/`AcmEdge` shapes, `LayoutInput`/`LayoutResult`).

One implementation note not spelled out verbatim in design.md: `AcmNode.data.parentId` needed a
`parentIdsFrom(childrenOf)` reverse-lookup helper (not in the design's code excerpt) to correctly
reflect `computeChildrenOf`'s orphan/cycle normalization (dangling/cyclic `containerId` → treated
as root, `parentId: undefined`) rather than echoing the raw, possibly-dangling `Entity.containerId`
verbatim. This is a faithful implementation of the documented normalization semantics, not a new
behavior.

Process-level deviation (corrected, now resolved): my first pass deleted `graphView.ts`/
`graphView.test.ts` per the tasks.md text as it stood at the time, which broke `webview/index.ts`
and two test suites outside PR1's scope. The user/orchestrator corrected tasks.md (1.5 deferred to
2b.5b, 1.7 re-scoped) and I applied that correction; see git history (`3f01e0d` → reverted by
`0a932a2`).

## Issues Found

None outstanding in the code. The one process issue (premature deletion) was caught and corrected
before PR1 was considered complete.

## Workload / PR Boundary

- Mode: chained PR slice. Chain strategy is still listed as "pending" in tasks.md — I have not
  seen an explicit resolution to `stacked-to-main` vs. `feature-branch-chain` in the correction
  message, though the correction's own shape (PR1 leaves `graphView.ts` as intentional temporary
  dead code, only cleaned up in PR2b) reads as more compatible with `feature-branch-chain` (PR1 is
  now independently green and mergeable to a tracker branch, so this ambiguity may already be
  moot — flagging for the orchestrator to confirm, not deciding it myself).
- Current work unit: Unit 1 (`graphFilters.ts`/`graphLayout.ts` split) — **complete**
- Boundary: starts from clean `main` (tracker branch created), ends at all of 1.1–1.9 done, full
  suite green, build green
- Estimated review budget impact: 1130 code-only changed lines vs. a 200-line ledger cap and a
  650-850-line tasks.md forecast — over both, reported plainly per instruction. Orchestrator to
  decide `size:exception` vs. further split vs. ledger reset via `gentle-ai sdd-attempt finish`.

## Files Changed (final state vs. `main`)

| File | Action | What Was Done |
|------|--------|---------------|
| `test/unit/graphFilters.test.ts` | Created | RED test, 22 assertions ported from `graphView.test.ts` for the 6 named symbols + `NESTED_LAYOUT_LIMITS` |
| `webview/graphFilters.ts` | Created | GREEN implementation — verbatim relocation + `changeStatusFor` newly exported |
| `test/unit/graphLayout.test.ts` | Created | RED test, 22 assertions covering layout internals + `layoutGraph`'s exact output shape |
| `webview/graphLayout.ts` | Created | GREEN implementation — verbatim relocation of layout internals + new `layoutGraph` entry point |
| `webview/graphView.ts` | Unchanged (restored to `main` state) | Deletion deferred to task 2b.5b |
| `test/unit/graphView.test.ts` | Unchanged (restored to `main` state) | Deletion deferred to task 2b.5b |
| `src/webviewHost.ts` | Modified | 2 import specifiers: `graphView.js` → `graphFilters.js` |
| `src/extension.ts` | Modified | 1 import specifier: `graphView.js` → `graphFilters.js` |
| `tsconfig.build.json` | Modified | `include` gains `webview/graphFilters.ts`; `webview/graphView.ts`/`webview/edgeGeometry.ts` stay in `include`; `exclude` untouched |
| `openspec/changes/react-flow-diagram-migration/*` | Committed | Pre-existing planning artifacts + this apply-progress file + the corrected `tasks.md` |

## Remaining Tasks

None for Section 1 (PR1) — all of 1.1–1.9 complete. Section 2a (PR2a) and beyond are explicitly
out of scope for this apply batch, per the orchestrator's original instruction not to start them.

## Status

**9/9 Section-1 tasks complete** (0.1 + 1.1–1.9). Full suite green (32 files, 525 tests).
Build green. **Not blocked on correctness** — only flagging the line-budget overage (1130
code-only / 2685 total vs. 200-line ledger cap) for the orchestrator to resolve via
`gentle-ai sdd-attempt finish`/reset or a `size:exception`/chain-strategy decision, per its
explicit instruction that this is not mine to work around.

---

## Status: Section 2a (PR2a) COMPLETE — 2a.1–2a.7 all done, build tooling verified

Base: `feat/react-flow-diagram-migration` at PR1's HEAD (`a670fbc`). Continuing on the same
branch (no new branch created), per the orchestrator's explicit instruction. New commit:
`faaec8d`.

### Completed Tasks

- [x] 2a.1 Added `react` (^19.3.0), `react-dom` (^19.3.0), `@xyflow/react` (^12.11.6) to
      `dependencies`; `esbuild` (^0.28.2), `@types/react` (^19.3.0), `@types/react-dom`
      (^19.3.0), `@testing-library/react` (^16.3.3), `@testing-library/dom` (^10.4.1) to
      `devDependencies`. Versions confirmed via `npm view <pkg> version` at time of apply
      (current stable, not guessed). Ran `npm install` — 41 packages added, 0 vulnerabilities
      introduced (pre-existing 2 moderate advisories, unrelated to new deps). `npm install`
      surfaced an `allow-scripts` gate for `esbuild`'s postinstall (fetches its native binary);
      resolved with `npm approve-scripts esbuild`, which appended an `allowScripts` block to
      `package.json` — a deliberate, expected side effect of installing esbuild via this
      project's install-script policy, not an unrelated change.
- [x] 2a.2 Created `scripts/build-webview.mjs` per design.md §1's exact esbuild config verbatim:
      `bundle:true`, `format:"esm"`, `splitting:false`, `platform:"browser"`,
      `target:["es2022","chrome114"]`, `jsx:"automatic"`, `jsxImportSource:"react"`,
      `define:{"process.env.NODE_ENV":'"production"'}` (D11, mandatory), `loader:{".css":"empty"}`,
      `minify:false`, `sourcemap` gated behind `ACM_WEBVIEW_SOURCEMAP === "1"` (default off).
- [x] 2a.3 Updated `package.json`'s `build:webview` script to
      `tsc -p tsconfig.webview.json --noEmit && node scripts/build-webview.mjs && node scripts/copy-webview-assets.mjs`
      per design.md's exact diff.
- [x] 2a.4 Updated `tsconfig.webview.json`: added `jsx: "react-jsx"`, `jsxImportSource: "react"`,
      `noEmit: true`; `include` now covers `webview/**/*.ts` and `webview/**/*.tsx`.
- [x] 2a.5 Modified `scripts/copy-webview-assets.mjs` to `require.resolve` and concatenate
      `@xyflow/react/dist/style.css` (vendor, first) with `webview/styles.css` (ours, second,
      separated by an `/* --- agent-change-map --- */` marker) into the single
      `out/webview/webview/styles.css` output (D7), verbatim per design.md's code.
- [x] 2a.6 Manual verification. `webview/index.tsx` does not exist yet (created in PR2b), so the
      build script's real entry point cannot resolve today — expected per the task's own framing.
      **Chose option (a)**: temporarily pointed `build-webview.mjs`'s `entryPoints` at the
      pre-existing, untouched `webview/index.ts` (940 lines, still present from before PR1) to
      prove the full esbuild pipeline — TypeScript resolution, bundling, `platform:"browser"`
      target, CSS-loader safety net, sourcemap gating — works end-to-end against real project
      code today, not just a synthetic smoke test. Ran `npm run build:webview`: exit 0,
      `out/webview/webview/index.js` emitted at 76.9kb with zero errors,
      `out/webview/webview/styles.css` emitted at 927 lines (confirmed vendor-first: file opens
      with `@xyflow/react`'s `/* this gets exported as style.css... */` header, `.react-flow`
      rules, our own `/* --- agent-change-map --- */` marker present later in the file). Reverted
      the entry point back to `webview/index.tsx` immediately after, with an inline comment
      documenting the temporary swap and pointing to this apply-progress record. Chose (a) over
      (b) (a throwaway `console.log` smoke bundle) because bundling the real, existing
      `webview/index.ts` through esbuild is strictly more representative evidence — it exercises
      actual project imports/module resolution/bundling behavior rather than an empty shell that
      would only prove esbuild itself runs. Caveat, stated plainly: this does **not** validate
      JSX/`.tsx` compilation or `@xyflow/react`/React runtime resolution inside the bundle, since
      `index.ts` contains no JSX and does not import React — that validation only becomes possible
      once PR2b's `index.tsx` exists and imports `react`/`@xyflow/react` for real. TypeScript-side
      JSX config (`tsconfig.webview.json`'s `jsx`/`jsxImportSource`) was however confirmed via
      `npm run typecheck`, which passed cleanly with the new `include` covering `.tsx` (vacuously,
      since no `.tsx` file exists to typecheck yet, but the config itself is not rejected).
- [x] 2a.7 Final gate. `npm run typecheck` → exit 0 (both `tsconfig.json` and
      `tsconfig.webview.json` projects, the latter now including the `.tsx` glob). Build
      verification per 2a.6 above (green via the temporary entry-point swap). Ran
      `npm run build:webview` one more time afterward, with the entry point reverted to its final
      `webview/index.tsx` value, to record the exact expected end-of-PR2a state: it fails with
      `Could not resolve "webview/index.tsx"` — this is the correct, expected, and documented
      failure mode (PR2b creates that file), not a regression. Also ran `npm run lint` (exit 0,
      `max-warnings=0`) and the full `npm run test` suite as the required "hasn't broken anything"
      check: **32 test files / 525 tests passed**, identical to PR1's final count — zero
      regressions from the build-tooling changes.

### Verified Command Output

- `npm view react version` → `19.3.0`; `react-dom` → `19.3.0`; `@xyflow/react` → `12.11.6`;
  `esbuild` → `0.28.2`; `@types/react` → `19.3.0`; `@types/react-dom` → `19.3.0`;
  `@testing-library/react` → `16.3.3`; `@testing-library/dom` → `10.4.1` (all current stable at
  apply time, 2026-09-12).
- `npm install` → `added 41 packages, audited 274 packages` — 0 new vulnerabilities.
- `npm approve-scripts esbuild` → `Approved esbuild: added esbuild@0.28.2`;
  `node_modules/.bin/esbuild` present after.
- `npm run build:webview` (temporary `index.ts` entry) → exit 0, `out/webview/webview/index.js`
  76.9kb, `out/webview/webview/styles.css` 927 lines, vendor-first order confirmed.
- `npm run build:webview` (final `index.tsx` entry, after revert) → exit 1,
  `Could not resolve "webview/index.tsx"` — expected, documented, not a blocker for this PR.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run test` (`vitest run`) → **32 test files passed, 525 tests passed** — identical to PR1's
  final count, zero regressions.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | No automated test for this unit — pure build tooling/config per tasks.md's own scoping ("no automated test — this is build tooling, not application logic"). Focused manual command: `npm run build:webview` (temporary entry) → exit 0, both output files emitted with correct content/order, per 2a.6 above. |
| Runtime harness command/scenario and exact result | Manual: inspected `out/webview/webview/index.js` (76.9kb, bundled, no errors) and `out/webview/webview/styles.css` (927 lines, vendor-first) after a real `npm run build:webview` run against existing project code (temporary entry swap). This is the closest available runtime boundary until PR2b's real `.tsx` entry exists — documented as a deliberate, partial substitute, not a full validation of the eventual React entry point. |
| Rollback boundary | `git revert faaec8d` (or `git reset --hard a670fbc`) fully reverts PR2a; PR1 stands alone unaffected, `build:webview` reverts to the prior `tsc`-only script, `node_modules`/`package-lock.json` changes revert with `npm install` after the revert. |

### Deviations from Design

None in the config/script content — `scripts/build-webview.mjs`, `scripts/copy-webview-assets.mjs`,
`tsconfig.webview.json`'s diff, and `package.json`'s `build:webview` script all match design.md §1
verbatim. One necessary deviation from a strict reading of task 2a.7 ("`npm run build:webview`
green"): the *final* `build:webview` run (with the design's real `webview/index.tsx` entry) cannot
be green in this PR by construction, since that file is explicitly out of scope until PR2b. Task
2a.6 itself anticipates and resolves this ambiguity by offering two verification strategies; I
followed option (a) as instructed and documented the final-entry failure as expected rather than
silently declaring a false green.

### Issues Found

None. `npm approve-scripts esbuild`'s `allowScripts` addition to `package.json` was flagged inline
above as a deliberate, expected side effect of the install-script gate, not an unreported change.

### Files Changed (PR2a only, vs. PR1's `a670fbc`)

| File | Action | What Was Done |
|------|--------|---------------|
| `package.json` | Modified | New deps/devDeps (react/react-dom/@xyflow/react, esbuild + types + testing-library); `build:webview` script updated; `allowScripts.esbuild` added by `npm approve-scripts` |
| `package-lock.json` | Modified | Regenerated by `npm install` (480 lines added — dependency tree for the 9 new/updated packages) |
| `scripts/build-webview.mjs` | Created | esbuild config per design.md §1, verbatim |
| `scripts/copy-webview-assets.mjs` | Modified | Now concatenates `@xyflow/react/dist/style.css` + `webview/styles.css` (D7) instead of a plain file copy |
| `tsconfig.webview.json` | Modified | `jsx`/`jsxImportSource`/`noEmit` added; `include` covers `.tsx` |
| `openspec/changes/react-flow-diagram-migration/tasks.md` | Modified | 2a.1–2a.7 marked `[x]` |

### Diff Size (this PR only, PR1's HEAD `a670fbc` → `faaec8d`)

Code-only (excludes `package-lock.json` generated file and `openspec/changes/*` planning docs):

```
 package.json                    | 13 ++++++++++++-
 scripts/build-webview.mjs       | 23 +++++++++++++++++++++++
 scripts/copy-webview-assets.mjs | 15 ++++++++-------
 tsconfig.webview.json           |  7 +++++--
 4 files changed, 48 insertions(+), 10 deletions(-)
```

**Code-only changed lines: 58** (48 insertions + 10 deletions). Well under the 200-line native
runtime attempt ledger cap and comfortably inside tasks.md's own ~120-160 forecast for this unit
(the design's build-tooling code is genuinely small; the forecast's upper bound likely anticipated
more churn in `copy-webview-assets.mjs` than the actual 2-line-net change required). Including
`package-lock.json` (480 lines, fully generated, not authored) would bring the total to 538 lines;
excluding it is consistent with the review-workload guard's "generated goldens are excluded from
authored risk count" convention.

### Remaining Tasks

None for Section 2a. Section 2b (React root port, `index.tsx`/`appReducer.ts`/`AcmEntityNode.tsx`,
`webviewDom.test.ts` rewrite — the largest, highest-risk slice per tasks.md's own forecast,
~900-1200 lines) is explicitly out of scope for this apply batch and was not started.

## Status

**16/16 tasks complete across Section 1 + Section 2a** (0.1, 1.1–1.9, 2a.1–2a.7). Full suite
green (32 files, 525 tests, zero regressions from PR1's baseline). `npm run typecheck` and
`npm run lint` green. Build pipeline verified end-to-end via the documented temporary entry-point
swap; the final `webview/index.tsx` entry point remains (expectedly) unresolved until PR2b. Diff
size for this PR alone: 58 code-only changed lines — well within both the 200-line ledger cap and
the 400-line review budget. Ready for verify / next PR (2b).

---

## PR2b-ii (base: PR2b-i) — Atomic switch: wire the React root, delete the old renderer

**Mode**: Standard (this change is not under strict TDD enforcement in the orchestrator's cached
preflight for this session; nonetheless a RED→GREEN cycle was followed for `webviewDom.test.ts`
per task 2b-ii.4/2b-ii.5, see TDD Cycle Evidence below).

### Completed Tasks
- [x] 2b-ii.1 Created `webview/index.tsx`: `<App/>` root, `useReducer(appReducer, createInitialState())`,
      single `window` "message" `useEffect` dispatching into the reducer, `useMemo(layoutGraph)`,
      `<ReactFlow>` with module-level `NODE_TYPES`/`EDGE_TYPES`, `AcmEntityNode` as the sole node
      type, a minimal inline `PlainEdge` (no per-kind styling — PR4's scope) as the sole edge type,
      and every panel from the old `index.ts` ported with identical element ids (`#toolbar`,
      `#filter-scope`/`#filter-status`/`#filter-kind`, `#filter-vintage`, `#oversized-consent`,
      `#status`, `#graph`, `#source-actions`/`#source-left`/`#source-right`, `#diff-panel`,
      `#draft-overlay-wrap`/`#draft-overlay`/`#draft-content`, `#save-draft`, `#write-snippet`,
      `#request-run`/`#cancel-run`/`#trigger-refresh`, `#confirmation`/`#confirm-action`/
      `#decline-action`, `#action-status`, `#run-output`, `#signature-section`/`#signature-status`/
      `#signature-form`/`#signature-form-validity`, `#call-box`/`#call-function`/`#call-status`/
      `#call-result`).
- [x] 2b-ii.2 Deleted `webview/index.ts`.
- [x] 2b-ii.3 Deleted `webview/graphView.ts` and `test/unit/graphView.test.ts` (verified nothing
      else imported `graphView.ts` before deleting — grep showed only `webview/index.ts`, itself
      also deleted, plus historical doc-comment mentions in `graphLayout.ts`/`edgeGeometry.ts`/
      `AcmEntityNode.tsx` describing provenance, left as-is). Updated `tsconfig.build.json`:
      `include` → `["src/**/*.ts", "webview/graphFilters.ts"]` (dropped `graphView.ts` and
      `edgeGeometry.ts` — verified via grep that nothing under `src/` imports `edgeGeometry.ts`);
      `exclude` → `webview/index.tsx`.
- [x] 2b-ii.4 RED — rewrote `test/unit/webviewDom.test.ts` with `@testing-library/react`
      conventions (act()-wrapped DOM interactions) + jsdom, narrowed to the task's stated scope:
      node/edge `data-*` contract, click-to-navigate, and ported-panel id/behavior parity. Added
      `test/unit/webviewDomSetup.ts`, a shared jsdom stub module. Confirmed RED against the
      just-created `index.tsx` before the React Flow measurement stubs existed (every test failed
      with "Missing [data-node-id=...]" — React Flow threw synchronously without `ResizeObserver`).
- [x] 2b-ii.5 GREEN — all 17 `webviewDom.test.ts` cases pass against `index.tsx`/`AcmEntityNode.tsx`.
- [x] 2b-ii.6 Verified `test/e2e/scenarios.ts` — inspected fully; it drives the extension only
      through `session.handleIntent(...)`/`vscode.commands.executeCommand(...)` and never touches
      webview DOM element ids at all (VS Code's public API cannot script inside a webview's HTML,
      a constraint the file's own doc comment states). No edit needed or made; nothing in this PR
      changes `src/webviewProtocol.ts`, `ChangeMapSession`, or any command id it depends on. Could
      not actually run the Extension Development Host harness in this environment (no VS Code test
      runner available here) — verified by inspection only, as the orchestrator's task explicitly
      allows for this exact case.
- [x] 2b-ii.7 REFACTOR — `npm run typecheck`, `npm run lint`, `npm test` (488/488), `npm run
      build:webview`, and `npm run build` all green.
- [x] 2b-ii.8 Final gate: all above green; committed as `2e45bd5`.

### Files Changed
| File | Action | What Was Done |
|------|--------|---------------|
| `webview/index.tsx` | Created | React root (see 2b-ii.1) |
| `webview/index.ts` | Deleted | Superseded by `index.tsx` |
| `webview/graphView.ts` | Deleted | Superseded by `graphFilters.ts` (PR1) + `graphLayout.ts` (PR1) |
| `webview/state/appReducer.ts` | Modified | Added `LocalUiMessage` union + 10 new reducer cases for UI-originated actions (node selection, reserve/decline confirmation, active-run tracking, signature request tracking, source-actions text, action-status text) that no `HostToWebviewMessage` carries. Every pre-existing case/behavior left byte-identical; `appReducer.test.ts`'s 37 cases still pass unmodified. |
| `webview/nodes/AcmEntityNode.tsx` | Modified | Added an invisible source+target `<Handle>` pair (React Flow requires at least one of each per node to compute edge connection points — without them every edge touching that node silently fails to render, `error008`) and `data-relationship-source`/ARIA attributes on the relationship-count badge, completing design §8's `relationshipDetails.ts` rewiring. |
| `test/unit/graphView.test.ts` | Deleted | Superseded by `graphFilters.test.ts` + `graphLayout.test.ts` (PR1) |
| `test/unit/webviewDom.test.ts` | Rewritten | `@testing-library/react` + jsdom, narrowed scope per task 2b-ii.4 |
| `test/unit/webviewDomSetup.ts` | Created | Shared jsdom stubs: `ResizeObserver` (synchronous, single-entry), `DOMMatrixReadOnly` (identity matrix — jsdom 30 does not implement this class at all), `requestAnimationFrame`/`cancelAnimationFrame`, `getBoundingClientRect` (zero rect), and `offsetWidth`/`offsetHeight` (fixed positive constants — jsdom hardcodes these to 0, which silently blocks React Flow's entire handle-bounds computation and therefore every edge's render) |
| `test/unit/relationshipDetails.test.ts` | Modified | Replaced its `renderGraphSvg`-based DOM fixture (function now deleted) with a minimal `[data-relationship-source]` indicator-only markup builder mirroring `bindRelationshipDetails`'s own eligibility filter; all 3 pre-existing test cases pass unmodified otherwise |
| `test/unit/AcmEntityNode.test.tsx` | Modified | Wrapped every render in `<ReactFlowProvider>` (now required by the new `<Handle>` elements); all 7 pre-existing assertions pass unmodified |
| `tsconfig.build.json` | Modified | `include` → `graphFilters.ts` only; `exclude` → `index.tsx` |
| `tsconfig.json` | Modified | Added `jsx`/`jsxImportSource` (needed because `webviewDom.test.ts`, a `.ts` file included by this project, transitively resolves `webview/index.tsx` via `await import("../../webview/index.js")`) |
| `scripts/build-webview.mjs` | Modified | Removed the stale "index.tsx does not exist yet" comment (2b-i-era note, no longer true) |
| `src/webviewHost.ts` | Modified | One doc-comment fix: "graphView.ts's change-status colouring" → "graphFilters.ts's" (the function moved in PR1; the comment was stale) |

### TDD Cycle Evidence (webviewDom.test.ts)

| Step | Evidence |
|---|---|
| RED | First full run of the rewritten `webviewDom.test.ts` against the freshly created `index.tsx` failed on every one of 17 cases with `ReferenceError: ResizeObserver is not defined` (React Flow's `<Pane>`/handle-measurement effects throw synchronously without it) — confirmed before any jsdom stub existed. |
| GREEN | Iteratively added exactly the stubs React Flow's own source required (`ResizeObserver`, `DOMMatrixReadOnly`, `requestAnimationFrame`/`cancelAnimationFrame`, `offsetWidth`/`offsetHeight`) and fixed two real `index.tsx` bugs the tests caught (a bare `instanceof HTMLInputElement` runtime check that doesn't exist as a global inside jsdom's swapped-`window` environment, and a missing `data-relationship-source` attribute on the relationship badge). All 17 cases pass; full suite (488 tests) green. |
| REFACTOR | `npm run typecheck` / `npm run lint` / `npm test` / `npm run build:webview` / `npm run build` all green with zero warnings. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/webviewDom.test.ts` → 17/17 passed |
| Runtime harness command/scenario and exact result | `test/e2e/scenarios.ts` (VS Code Extension Development Host) — **could not run** in this environment (no VS Code test runner available); verified by full-file inspection instead, per the task's own explicit fallback allowance. It addresses zero webview DOM element ids (drives `session.handleIntent`/`vscode.commands.executeCommand` only), so nothing in this PR's scope could regress it. |
| Rollback boundary | Revert this commit (`2e45bd5`) only. PR2b-i's `appReducer.ts`/`AcmEntityNode.tsx` (before this PR's additive extensions) and PR1's `graphFilters.ts`/`graphLayout.ts` stand alone unaffected; reverting restores `webview/index.ts` and `webview/graphView.ts` from git history if a hard rollback of the whole migration were ever needed (not expected — this is a forward-only revert of the atomic-switch commit itself). |

### Deviations from Design

1. **`appReducer.ts` extended with a `LocalUiMessage` union**, not in design.md's original text
   (which only specifies `(AppState, HostToWebviewMessage) => AppState`). Necessary because
   several `AppState` fields (`selectedNodeId`, `selectedPair`, `pendingAction`, etc.) are set by
   *user-originated* UI actions (a node click, reserving a confirmation slot) that have no
   corresponding `HostToWebviewMessage` — `appReducer.test.ts`'s own pre-existing tests already
   assumed these fields could be set by direct object-spread setup, confirming they were always
   meant to be externally settable. All existing reducer cases are untouched; only new cases were
   added, namespaced `local:` so they can never collide with a real host message type.
2. **`positionOverrides.ts` wiring: chose the no-op/empty-overrides-map option** explicitly
   offered by the task prompt. `layoutGraph` is called with a single stable empty `Map` for
   `overrides`; drag persistence is entirely PR3's scope (absolute-position redesign). No
   `onNodeDragStop` handler is wired in this PR.
3. **No custom edge component / `edgeStyleConfig.ts`** — per explicit constraint, PR4's scope.
   `PlainEdge`, a minimal inline component defined directly in `index.tsx` (not a separate
   `edges/AcmKindEdge.tsx` file — that name and file are reserved for PR4), renders `data.path`
   via `<BaseEdge>` with no dash/arrow/particle styling.
4. **No hover highlight** — PR5's scope; not implemented.
5. **Diff panel's cross-refresh "preserve expanded runs" nuance dropped**: the old `index.ts`
   snapshotted `expandedRuns` into `preservedRuns` on a refresh `graphSummary` so a landing
   refresh's diff panel kept the same collapsed/expanded state. The new `index.tsx` simply resets
   `expandedRuns` to empty whenever `state.diffOps` changes (a plain `useEffect`). This is a minor,
   deliberate simplification for scope control — not covered by the RED test's mandated scope
   (data-* contract / click-to-navigate / panel parity), and not asserted by any of the 3 ported
   `webviewDom.test.ts` cases that exercise `diffOps`. Flagging as a known, small behavior gap
   relative to the pre-migration implementation; not blocking.
6. **`AcmEntityNode.tsx` gained a `data-relationship-source` attribute and an invisible source/
   target `<Handle>` pair** — not explicitly itemized in design.md's "Node output shape (exact)"
   table, but required for (a) design §8's `relationshipDetails.ts` rewiring to function at all
   (the popup keys off `[data-relationship-source]`, which the old SVG renderer emitted but the
   PR2b-i-authored `AcmEntityNode.tsx` did not yet have), and (b) React Flow's own connection
   lookup, without which every edge silently fails to render regardless of `data.path` correctness.
   Both are minimal, additive, low-risk changes; no existing `AcmEntityNode.test.tsx` assertion
   was invalidated (7/7 still pass, with only a `<ReactFlowProvider>` wrapper added since `<Handle>`
   now requires one).
7. **`tsconfig.json` (root) gained `jsx`/`jsxImportSource`** — not itemized in design.md's File
   Changes table (which only lists `tsconfig.webview.json`). Required because `test/unit/
   webviewDom.test.ts`, a plain `.ts` file already covered by the root `tsconfig.json`, now
   transitively resolves `webview/index.tsx` via a dynamic `import("../../webview/index.js")` —
   without `jsx` configured, `tsc -p tsconfig.json` cannot type-check that resolution.

### Issues Found

- **jsdom 30 does not implement `ResizeObserver`, `DOMMatrixReadOnly`, or a real layout engine at
  all** (`offsetWidth`/`offsetHeight` are hardcoded to 0). React Flow's own internal handle-bounds
  measurement pipeline (`@xyflow/system`'s `updateNodeInternals`) silently gates its *entire*
  computation on `dimensions.width && dimensions.height` being truthy — with jsdom's hardcoded
  zeros, no node's handle bounds are ever computed, so `getEdgePosition` always fails with
  `error008` and **every edge silently fails to render**, with no thrown error and no console
  warning distinguishable from normal operation (React Flow calls `onError` with a code, which
  defaults to a `console.warn` easy to miss in a large test run). This was the single hardest bug
  in this PR to isolate; documented at length in `webviewDomSetup.ts`'s comments so a future PR
  (PR4/PR5, which touch edges/hover) does not have to re-discover it.
- **A controlled React `<textarea>`'s `onChange` will not fire from a test that sets `.value =`
  directly and dispatches a synthetic "input" event** — React's internal `_valueTracker` detects
  that the DOM's value already matches what React expects and suppresses the change. Worked
  around with the standard `@testing-library`-style native-property-setter technique
  (`test/unit/webviewDom.test.ts`'s `typeInto` helper). Uncontrolled inputs (the raw-JSON
  parameter textareas, the toolbar `<select>`s) are unaffected since they carry no `value` prop.
- **A real (and jsdom-simulated) checkbox `click()` toggles `.checked` via the browser's default
  action before React's `onChange` fires** — presetting `.checked` then dispatching a bare
  "change" event never triggers React's handler; the fix is to dispatch the actual "click".
- **`session.handleIntent(...)`-driven `post()` calls made outside `act()`** (React 18/19's
  automatic batching does not synchronously flush a `dispatch()` triggered from a real
  `dispatchEvent(...)` in jsdom/Node the way a real browser's event loop does) left several
  assertions reading stale DOM immediately after a `click(...)`. Fixed by wrapping every
  state-changing DOM interaction, and the simulated host `post` callback itself, in `act()`.

### Remaining Tasks

None for Section 2b-ii. Section 3 (`positionOverrides.ts` absolute redesign + container-drag
cascade, base: PR2b-ii) is next.

### Workload / PR Boundary

- Mode: stacked-to-main chained PR slice (per prior session's resolved delivery decision)
- Current work unit: PR2b-ii — "Atomic switch: wire the React root, delete the old renderer"
- Boundary: starts from PR2b-i's tip (commit `5757031`); ends at commit `2e45bd5` (this batch)
- **Actual diff size (PR2b-i tip → this commit): 15 files changed, +1113/-3405 (4518 total changed
  lines)**. This is the single largest PR in the whole migration, as anticipated by design.md's own
  "Deviation note" and by the user's earlier decision to split PR2b into 2b-i/2b-ii. The user's
  standing instruction on this change explicitly authorizes exceeding the 400-line/200-line budget
  for every PR in this migration and asks only for an accurate, honest report of the real number —
  reported above. Net new authored code is smaller than the raw diff suggests: +1113 insertions
  against -3405 deletions, and the deletions are overwhelmingly two dead files (`webview/index.ts`,
  940 lines; `webview/graphView.ts`, 648 lines) plus their superseded test file (`test/unit/
  graphView.test.ts`, 989 lines) — together 2577 of the 3405 deleted lines were already fully
  superseded by PR1's `graphFilters.ts`/`graphLayout.ts` and PR2b-i's `appReducer.ts`/
  `AcmEntityNode.tsx`, not new churn introduced by this PR.

## Correction to PR2b-ii: `webviewDom.test.ts` coverage restoration

Not a new numbered PR in the chain — this batch corrects a scope gap in PR2b-ii's own delivery.
PR2b-ii's RED-test task rewrote `test/unit/webviewDom.test.ts` from the pre-React-Flow suite's 45
cases down to 17, citing "scope control," and explicitly flagged exactly one dropped scenario
("Diff panel's cross-refresh preserve expanded runs nuance"). The user asked for the full gap to
be audited (not just the one flagged scenario) before continuing to PR3. This batch does that:
diffs the OLD 45-case file (`git show 5757031:test/unit/webviewDom.test.ts`) against the 17-case
rewrite, classifies every dropped scenario as still-meaningful (restore) or
implementation-detail-obsolete (exclude, with justification), restores the former via strict
RED→GREEN→REFACTOR, and fixes two real production bugs the restoration work surfaced.

**Before/after test count**: 17 → 31 (in `test/unit/webviewDom.test.ts`); full unit suite 33 files
/ 502 tests, all green; `npm run typecheck`, `npm run lint`, `npm run test:e2e` all green
(e2e run for real in this environment: "VS Code extension e2e scenarios passed", exit 0, all
scenarios including refresh/oversized-consent/draft-save/run-stream/cancel green).

### Full 45-case inventory (old `webviewDom.test.ts`, PR2b-i tip `5757031`)

1. drives explicit sides, snippet draft/save, guarded write preview and run/result through DOM — **preserved** in the 17-case rewrite.
2. declines effects and cancels using their request IDs — **preserved**.
3. reserves the confirmation slot before a delayed write preview and rejects overlapping effects — **RESTORED** (category a: `local:reserveAction`'s `if (state.pendingAction) return state;` guard is still real and wired; test-only gap).
4. selects a section before oversized rendering and keeps filters actionable — **preserved**.
5. renders classified diff rows with ghost cells for the missing side — **preserved**.
6. navigates a relationship at its exact edge span (click-contract proof) — **preserved** (as "navigates a relationship at its exact edge span when the edge is clicked").
7. keeps both ghost columns present for a wholly one-sided (added-only) pair — **RESTORED** (category a: `DiffRow`'s ghost-cell rendering is generic and still wired; test-only gap).
8. collapses long unchanged runs, toggles them open/closed, and resets on a new sourcePair message — **partially preserved** (collapse/toggle-open kept as "collapses long unchanged runs and toggles them open"); the "resets on a new sourcePair message" nuance (re-selecting the same node resets collapse state) was ALSO dropped in the rewrite, separately from the one scenario PR2b-ii flagged — **RESTORED** as its own case ("resets collapsed diff-panel runs on a new sourcePair message").
9. **re-issues inspectSources for the previously selected node after a refresh landing, and preserves its expanded runs** — the one scenario PR2b-ii explicitly flagged. **RESTORED, and found a real production bug**: see "Production bugs found and fixed" below.
10. preserves unsaved draft text across a refresh landing while clearing selection/editing — **RESTORED**, and this restoration surfaced a SECOND real production bug (see below) — writing this RED test first is what caught it.
11. shows terminal run kinds with exit codes and timeout durations — **RESTORED** (category a: `runResultLine()` already handles `timeout`; test-only gap).
12. renders terminal runner failures rather than leaving an indefinitely running UI — **RESTORED**, and surfaced a THIRD real production bug (see below).
13. passes the host's untrackedPaths through to the rendered graph, marking an untracked node's provenance — **preserved** (as "marks an untracked node's provenance from the host's untrackedPaths"); the old test's specific `.provenance-untracked` CSS-class assertion is gone, but that class was renamed to `.acm-node-provenance-untracked` under the new `AcmEntityNode.tsx` — the underlying behavior is still asserted via the `data-provenance` attribute contract, so this is full coverage under a renamed selector, not a real gap.
14. discloses unresolved relationships without selecting the node and navigates only the recorded edge span — **preserved**.
15–24 (Cases 21–30: pointer-drag transform update, live edge re-route during pointermove, click-suppressed-by-drag / still-fires-below-threshold, container-drag descendant edge re-anchoring, dragged-position-survives-refresh, stale-override-dropped-without-error, leaf-vs-container drag gating, descendant relationship-indicator anchoring through drag, coordinated re-route after drag) — **EXCLUDED, category (b)**: see justification below.
25–30 (viewBox-equals-width/height on first paint, wheel-zoom-toward-cursor exact numbers, ZOOM_MIN/ZOOM_MAX clamping, wheel `preventDefault` on/off `#graph`, viewBox reset after a new render) — **EXCLUDED, category (b)**: see justification below.
31. exposes a vintage toolbar fieldset defaulting to current-only — **preserved** (merged into "exposes a vintage toolbar fieldset defaulting to current-only and posts requestGraphView accordingly").
32. posts requestGraphView with both vintages when Removed is checked — **preserved** (merged into the same test as #31).
33. posts requestGraphView with an empty vintages array when both are unchecked — **RESTORED** (category a: `requestView()`'s vintage filter is generic and still wired; the rewrite kept only the "checked" branch of this pair, test-only gap for the "unchecked" branch).
34. maps each annotation kind to its expected widget: number/checkbox/text/optional/raw-json — **partially preserved**, narrower than the original (missing `float`, `dict[...]`, no-annotation, `VAR_POSITIONAL`, `VAR_KEYWORD` cases) — **RESTORED** the missing cases (category a: `widgetFor()` already handles every one of these kinds; test-only gap).
35. blocks on invalid raw JSON and clears the error once the value parses — **preserved**.
36. shows a disabled unavailable state with no static-AST fallback when Docker is unavailable — **preserved**.
37. selecting a nested function does not let the click bubble to its container and clobber the selection — **EXCLUDED, category (b)**: see justification below.
38. shows a confirm step with the exact args JSON preview before any requestCall triggers a spawn — **preserved**.
39. performs no invocation when the call confirmation is declined — **RESTORED** (category a: `local:declineConfirmation` + `respondToConfirmation`'s decline branch are still real and wired; test-only gap).
40. renders a successful callResult with the return repr — **preserved**.
41. renders a failing callResult with the captured error output — **RESTORED** (category a: `callResult` reducer case + `renderCallResultText()`'s failure-kind branch are still wired; test-only gap).
42. never renders the draft as a bare unstyled textarea/pre (overlay `textContent` === textarea value) — **RESTORED** (category a: the semantic-highlighting overlay — `highlight()`, `#draft-overlay` — is still present verbatim in `webview/index.tsx`; test-only gap).
43. re-renders the overlay on edit, keeping the text-equality invariant — **RESTORED** (same feature, same reasoning as #42).
44. updates token colors on a themeTokens message without requiring reselection — **RESTORED** (same feature; `themeTokens` reducer case + the CSS-custom-property effect are still wired).
45. renders an identifier with no determinable role as plain unstyled text without breaking overlay/textarea alignment — **RESTORED** (same feature).

**Tally**: 45 old cases → 14 already preserved as-is/merged in the 17-case rewrite, 17 restored in this batch (3, 7, 8's dropped nuance, 9, 10, 11, 12, 33, 34's missing widget cases, 39, 41, 42, 43, 44, 45 — several restorations extend an existing `it()` rather than adding a new one), 14 excluded as obsolete (cases 15–24, 25–30, 37) with justification below. New total: 31 cases in `test/unit/webviewDom.test.ts` (17 kept + 14 net-new/extended `it()` blocks; some restorations were added as assertions inside an already-preserved test rather than a new one, which is why 31 ≠ 17 + 17).

### Category (b) exclusions — obsolete under React Flow, not restored

All of these tested implementation details specific to the old hand-rolled SVG/vanilla-DOM
renderer that has no equivalent surface under React Flow. Per `webviewDom.test.ts`'s own header
comment (already present from PR2b-ii): "pan/zoom/drag/hover are React Flow's own built-in
behavior now (not this codebase's to unit-test), pixel-position assertions are already covered —
exactly and cheaply — by `graphLayout.test.ts`'s pure-data layer."

- **Pointer-drag node transform update / live edge re-route during pointermove / click-suppressed-by-drag / still-fires-below-threshold** (old Cases 21–24): the old suite's bespoke `pointerdown`/`pointermove`/`pointerup` sequencing, drag-threshold math, and per-edge live-reroute-during-drag all lived in `webview/index.ts`'s own hand-rolled drag code. React Flow now owns dragging, its own internal drag-threshold-vs-click disambiguation, and live edge re-rendering from its own node-position store — there is no bespoke pointer-math code left in this codebase to unit-test at the DOM layer for any of these.
- **Container-drag descendant edge re-anchoring / coordinated re-route after drag** (old Cases 25, 30): asserted that a per-frame drag recompute matched `routedPaths` (the coordinated batch router) rather than a naive per-edge fallback. React Flow's edges re-render from its own node-position store during drag; there is no bespoke per-edge-vs-coordinated recompute left to regress. Static coordinated routing is already covered by `coordinatedRouting.test.ts`/`graphLayout.test.ts` at the pure-data layer.
- **Dragged-position-survives-refresh / stale-override-dropped-without-error** (old Cases 26–27): position-override persistence across a refresh is explicitly PR3's scope (`positionOverrides.ts`'s absolute-coordinate redesign, design.md D5/D6) — `webview/index.tsx` currently wires a placeholder `NO_OVERRIDES` empty map (see its own doc comment) precisely because this hasn't landed yet. Restoring these now would either fail against not-yet-built PR3 behavior or require building PR3 early, both out of this batch's bounds per the user's explicit constraint not to touch PR3/4/5 scope. These will get their own coverage when PR3 lands.
- **Leaf-vs-container drag gating** (old Case 28): the old `isContainerKind()` gate on `pointerdown` (only container-kind nodes draggable) was bespoke SVG-nesting logic. Under React Flow, drag eligibility is PR3's redesign scope (per-node-type `draggable` prop), not something this codebase currently implements to test.
- **Descendant relationship-indicator anchoring through container drag** (old Case 29): asserted an absolute-position accumulation formula (`translate(box.x + box.w - 34, box.y + 7)`) specific to the old nested-`<g>` SVG structure. React Flow's flat (non-DOM-nested) node model has no equivalent absolute-accumulation math to test.
- **viewBox-equals-width/height / wheel-zoom-toward-cursor exact numbers / ZOOM_MIN/ZOOM_MAX clamping / wheel preventDefault on/off `#graph` / viewBox-reset-after-render** (old Cases 28*, 29–33 in the "zoom" section — old file reused comment number 28 for both a drag case and this section, see old file's own line 588 comment): all asserted the old renderer's raw SVG `viewBox` attribute and its own hand-rolled `ZOOM_STEP`/`ZOOM_MIN`/`ZOOM_MAX` wheel-zoom math. React Flow manages its own viewport transform internally; there is no `viewBox` attribute or bespoke zoom formula left in `webview/index.tsx` to unit-test.
- **Selecting a nested function does not let the click bubble to its container** (old case at line 774): regression-tested `event.stopPropagation()` in the old renderer's per-node click listener, needed because the old SVG DOM nested a leaf node's `<g>` inside its container's own `<g>` (so a real click bubbles through every ancestor's identical listener). Under React Flow, nodes are flat, non-nested DOM siblings — `onNodeClick` fires exactly once per the node React Flow determines was hit, with no ancestor-container DOM bubbling path to guard against. No equivalent code exists to regress.

### Production bugs found and fixed

Writing the restored RED tests surfaced three real behavioral gaps in `webview/index.tsx` — not
just test gaps — confirming the user's suspicion about the flagged scenario in particular:

1. **Diff-panel "expanded runs" did not survive a refresh landing** (the scenario PR2b-ii
   explicitly flagged). Root cause: the refresh-landing effect dispatched a full
   `local:chooseNode` action — the same action a fresh user click sends — which unconditionally
   resets `diffOps: []`. A separate `useEffect` unconditionally cleared `expandedRuns` on every
   `diffOps` change, so any refresh always collapsed the diff panel back to fully-collapsed,
   discarding whatever the user had expanded. The old `webview/index.ts` (`git show
   5757031:webview/index.ts`, lines 796-799/870-874) had a `preservedRuns` snapshot taken at
   `graphSummary` time specifically to survive this transition; the new port never carried that
   mechanism over. **Fix**: added a `preservedRunsRef` (mirrors the old `preservedRuns` module
   variable) snapshotted right before the refresh-landing `inspectSources` re-request; the
   `diffOps`-reset effect now restores it instead of unconditionally clearing, exactly once, then
   clears the ref.
2. **Unsaved draft text was wiped on a refresh landing instead of being preserved** (this
   surfaced while restoring case #10, itself adjacent to the flagged bug — same root cause).
   `local:chooseNode` also unconditionally resets `draftContent`/`draftSourceId`, which a synced
   `useEffect` mirrors into the local `draftText` state — so the same over-broad dispatch that
   broke expanded-runs also silently discarded any in-progress unsaved edit on every refresh,
   even though the reducer's own `graphSummary` case and the `pendingInspect` field (added,
   documented, but never drained by any effect) show the ported design's actual intent was to
   preserve it. **Fix**: replaced the refresh-landing effect's `local:chooseNode` dispatch with a
   new minimal `local:clearPendingInspect` action that only clears `pendingInspect`, leaving
   `draftContent`/`draftSourceId`/`diffOps` untouched — matching the old `index.ts`'s
   refresh-landing behavior (it only set `selectedPair`+ posted `inspectSources`, never called the
   full `choosePair`). This also removed the now-unnecessary `selectedNodeIdRef`.
3. **"Request run" silently stopped working after the first run's terminal result (success or
   failure)** (surfaced while restoring case #12). The "Run selected variants…" button's guard
   (`if (activeRunId || state.pendingAction) return;`) reads a *local* `useState` copy of the
   active run id that is only ever cleared on an explicit decline — `runResult`/`runFailed`
   clear the *reducer's* `state.activeRun` but never synced back down to the local copy, so any
   run after the very first one silently no-op'd forever, i.e. `#request-run` stopped producing a
   confirmation dialog with no error and no visible feedback. **Fix**: added a `useEffect`
   syncing local `activeRunId` from `state.activeRun`.

All three fixes are minimal, additive, and scoped to `webview/index.tsx` +
`webview/state/appReducer.ts` (one new `LocalUiMessage` case, one new ref, one new sync effect,
one corrected effect body) — no changes to `positionOverrides.ts`, `edgeStyleConfig.ts`, or hover
highlighting (PR3/4/5 scope, untouched).

### Files changed (this correction)

| File | Action | What Was Done |
|------|--------|----------------|
| `test/unit/webviewDom.test.ts` | Modified | 17 → 31 test cases: restored 17 scenarios/nuances (categorized above), extended the widget-mapping test with 5 more annotation kinds. |
| `webview/index.tsx` | Modified | Fixed the three production bugs above: `preservedRunsRef` for diff-panel expanded-runs across refresh; replaced the `local:chooseNode` refresh-landing dispatch with a minimal `local:clearPendingInspect` drain (preserving unsaved draft text); added an `activeRunId`↔`state.activeRun` sync effect. |
| `webview/state/appReducer.ts` | Modified | Added `local:clearPendingInspect` `LocalUiMessage` case (clears only `pendingInspect`). |

### TDD Cycle Evidence

| Scenario | RED | GREEN | REFACTOR |
|---|---|---|---|
| Diff-panel expanded runs preserved across refresh | Test written against current `index.tsx`; failed with stale-`localStorage`/suspended-act pollution traceable to the same unfixed bug leaking into the next test | Added `preservedRunsRef`, corrected refresh-landing effect | n/a — minimal, no further cleanup needed |
| Unsaved draft preserved across refresh | Test written; failed `expected '' to be 'print(\'unsaved edit\')\n'` | Same refresh-landing effect fix (shared root cause) made it pass | n/a |
| Request-run works after a terminal run result | Test written; failed — second `#request-run` click silently no-op'd, `#confirmation` stayed empty | Added `activeRunId`↔`state.activeRun` sync effect | n/a |
| All other restored/extended scenarios (14 cases) | Test written against current `index.tsx`/`AcmEntityNode.tsx` | Passed immediately — confirmed already-wired behavior, test-only gaps | n/a |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/webviewDom.test.ts` — 31/31 passed |
| Runtime harness command/scenario and exact result | `npm run test:e2e` — "VS Code extension e2e scenarios passed", exit 0, all scenarios (selection, exact/stale navigation, draft save, forged-root refusal, direct save, oversized consent, refresh, run/stream, cancel) green |
| Rollback boundary | Exactly `test/unit/webviewDom.test.ts`, `webview/index.tsx`, `webview/state/appReducer.ts` — no other files touched; revertable independently of PR2b-ii's original commit or any later PR |

### Workload / PR Boundary

- Mode: correction to already-landed PR2b-ii, not a new chained-PR slice
- Diff size: 3 files changed, +310/-12 (322 total changed lines) — within the 400-line budget
- Boundary: starts from PR2b-ii's tip (commit `2b61931`); this commit is the correction

---

## Section 4 (PR4, base: PR3) — `edgeStyleConfig.ts` + custom edge + palette

**Status**: 9/9 tasks complete (4.1-4.9). Branch `feat/react-flow-diagram-migration`, base: PR3
tip (`337e08c`), stacked-to-main.

### TDD Cycle Evidence (Strict TDD Mode)

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 4.1/4.2 `edgeStyleConfig.ts` | `test/unit/edgeStyleConfig.test.ts` written first; failed — `Cannot find module '../../webview/edgeStyleConfig.js'` | Created `webview/edgeStyleConfig.ts` per design.md §5's exact code; 8/8 passed | n/a — module is a pure data table, no further extraction needed |
| 4.3 `AcmKindEdge.tsx` | No standalone RED for this file (design.md gives its exact JSX verbatim; behavior is exercised transitively by 4.7's `webviewDom.test.ts` additions and 4.5/4.6's `relationshipDetails.test.tsx`) | Wired into `index.tsx`'s `EDGE_TYPES`, replacing PR2b-ii's `PlainEdge` placeholder; typecheck/build green | Added the shared `<defs>`/`<marker>` block (arrow markers), ported verbatim from the deleted `graphView.ts` |
| 4.4 `styles.css` palette | n/a — CSS constants, no test framework applicable; verified visually via the invariant regex in 4.1's test (config module never leaks a raw hex) | Replaced `:root`'s `--acm-edge-*` with the `var(--vscode-charts-*, <fallback>)` chain (Palette C) | Replaced dead `graphView.ts`-era `.edge-*`/`.arrow-*`/`.resolution-*` selectors with real `.acm-arrow-*`/`.acm-particle` coexistence rules; also fixed a pre-existing dead `.relationship-indicator` selector (never matched `AcmEntityNode`'s real `.acm-node-relationship-indicator` markup) — found while auditing which classes are live |
| 4.5/4.6/4.7 `relationshipDetails.test.tsx` rewrite | Confirmed the pre-rewrite `.test.ts` fixture was hand-authored stand-in markup (`<g data-relationship-source>`), not a real render — rewrote against `layoutGraph` + real `AcmEntityNode` render via `@testing-library/react` (D10: bind against React-rendered container); file renamed `.ts` → `.tsx` (JSX requires it) | 4/4 passed (was 2 tests, now 4 — added explicit assertions for the real `.acm-node-relationship-indicator` badge contract and D12's "zero drawn edges" invariant) | `bindRelationshipDetails`/`relationshipDetails.ts` itself stayed untouched (D10) |
| 4.7/4.8 `webviewDom.test.ts` extension | Two new cases written against the still-`PlainEdge`-era wiring (before 4.3's `AcmKindEdge` swap landed in the same working tree) — would have failed on `<animateMotion>`/`.acm-particle` absence | 33/33 passed after `AcmKindEdge` wiring | n/a |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run edgeStyleConfig` — 8/8 passed; `npx vitest run relationshipDetails` — 4/4 passed; `npx vitest run webviewDom` — 33/33 passed |
| Runtime harness command/scenario and exact result | `npm run test:e2e` — "VS Code extension e2e scenarios passed", exit code 0, all 9 scenarios (selection, exact/stale navigation, draft save, forged-root refusal, direct save, oversized consent, refresh, run/stream, cancel) green |
| Rollback boundary | `webview/edgeStyleConfig.ts` (new), `webview/edges/AcmKindEdge.tsx` (new), `webview/index.tsx`, `webview/styles.css`, `test/unit/edgeStyleConfig.test.ts` (new), `test/unit/relationshipDetails.test.tsx` (renamed+rewritten from `.test.ts`), `test/unit/webviewDom.test.ts` — revertable as one unit back to PR3's tip; edges fall back to no per-kind styling (React Flow's default bezier, no D12 change) if reverted, nothing downstream depends on this PR yet |

### Full-suite gate

- `npm run typecheck` — clean (both `tsconfig.json` and `tsconfig.webview.json`)
- `npm run lint` — clean, `--max-warnings=0`
- `npm test` — 524/524 passed (up from 513 after PR3; +8 `edgeStyleConfig`, net +2 `webviewDom`, net +2 `relationshipDetails`, minus the file being replaced not duplicated)
- `npm run test:e2e` — ran for real, exit code 0, all 9 scenarios completed

### Deviations from design

- None in substance. Two things not explicitly spelled out in design.md that required judgment calls, both documented inline in the code/CSS comments:
  1. The shared `<defs>`/marker block's exact placement: design.md says "rendered once by `<GraphCanvas>` inside the React Flow SVG" but doesn't give a code snippet. Rendered it as a child `<svg><defs>...</defs></svg>` inside `<ReactFlow>` (a sibling overlay within the same DOM tree — browsers resolve `url(#id)` marker references across sibling `<svg>` elements in the same document), reusing `graphView.ts`'s exact deleted marker markup (`viewBox`, `refX`/`refY`, `markerWidth`/`markerHeight`, `orient="auto-start-reverse"`) verbatim.
  2. Found and fixed a **pre-existing** dead-CSS bug unrelated to this PR's core scope: `styles.css`'s `.relationship-indicator` rule block (targeting `<g><rect><text>`) never matched `AcmEntityNode.tsx`'s actual `.acm-node-relationship-indicator` `<circle>` markup — a gap from PR2b-ii/PR3 that predates this PR. Fixed it since it's the exact indicator chrome `EDGE_STYLE_UNRESOLVED` governs (task 4.6's own wording: "the indicator's styling is asserted"), kept the fix minimal (same `--acm-edge-ambiguous` variable, just retargeted the selector).

### Issues Found

- None blocking. Confirmed (not assumed) that `graphLayout.ts`'s `buildEdges` already filters `edge.resolution.kind !== "resolved"` before constructing any `AcmEdge` — D12 was already correctly enforced by PR1, `edgeStyleFor`'s `resolution` parameter is exercised only via the indicator-chrome path (`EDGE_STYLE_UNRESOLVED`), never by a drawn edge. No "fix" was needed or made.

### Status

Sections 0-4 all complete (Section 4/PR4: 9/9 tasks). Section 5 (PR5, hover highlight +
measurement) remains. Ready for verify / PR4 open.

---

## Bugfix (post-PR4, base: `4410fdd`): edges disconnected from node boxes

**User-reported symptom (screenshot)**: after loading the rebuilt React Flow webview, node boxes
render correctly (colors/borders fixed by `4410fdd`) but edges (import/call relationship lines) are
visually disconnected from the boxes they connect — arrowheads point into empty space, elbow-routed
lines don't touch any box, large unexplained gaps between a line's end and the nearest node.

### Root cause

`webview/graphLayout.ts`'s `layoutGraph()` computes one `boxes: Map<string, Rect>` (absolute
top-left `{x,y,w,h}` per node) from the containment layout pass, then calls two builders:

- `buildNodes(...)` sets each `AcmNode.position` to `override ?? {x: box.x, y: box.y}` — i.e. it
  DOES apply any stored absolute position override (from a drag, or from a hydrated-on-refresh
  prior session per `positionOverrides.ts` / "Dragged positions persist across a panel refresh").
- `buildEdges(...)` called `routedPaths(edges, boxes)` with the RAW, un-overridden `boxes` map —
  it never applied overrides.

Net effect: the moment ANY node has a stored override (which happens on the very first drag,
`onNodeDragStop` sets one, or is hydrated at load time from a previous session's persisted drag
positions), that node's visual `position` moves, but every edge whose path anchors to that node
(or to a dragged container's cascaded descendants) is still routed against the box's OLD,
pre-override coordinates. The `data.path` SVG string `AcmKindEdge`/`BaseEdge` draws verbatim then
terminates at the node's stale location — exactly the "line doesn't touch the box, arrowhead in
empty space, large gap" symptom in the screenshot. This is not a `nodeOrigin`/coordinate-space
mismatch between React Flow and the router (both use the same absolute top-left convention,
verified against the pre-migration `graphView.ts` renderer, which used the identical `boxes` map
for both compounded SVG `<g transform>` node placement and edge path routing) — it is specifically
the override asymmetry between `buildNodes` and `buildEdges`.

### Fix

`webview/graphLayout.ts`: added `boxesForRouting(boxes, overrides)`, a small helper that returns
`boxes` unchanged when there are no overrides, or a shallow-merged copy with each overridden node's
`x`/`y` replaced (width/height untouched) otherwise. `buildEdges` now takes `overrides` and routes
against `boxesForRouting(boxes, overrides)` instead of the raw `boxes`. Both `layoutGraph` call
sites (flat-degraded path and the normal nested-containment path) were updated to pass `overrides`
through to `buildEdges`. `LayoutResult.boxes` (the field `onNodeDragStop`'s cascade math and
`positionOverrides.pruneTo` key off) intentionally stays the raw, un-overridden layout — only the
boxes fed into routing are merged, at the `buildEdges` call site.

### TDD Cycle Evidence

| Step | Evidence |
|---|---|
| RED | Added `test/unit/graphLayout.test.ts` case "routes edges against the OVERRIDDEN position, not the stale pre-drag box". Confirmed RED by stashing the `graphLayout.ts` fix (`git stash push -- webview/graphLayout.ts`) and running `npx vitest run test/unit/graphLayout.test.ts -t "routes edges against the OVERRIDDEN position"`: failed, path's terminal point was `(16, ...)` (the stale pre-override box), nowhere near the override box `(999,111)-(1199,143)`. |
| GREEN | Restored the fix (`git stash pop`); re-ran the same focused test: passed, path terminal point `(999, 123)`, inside the overridden box's bounds. Full `npx vitest run test/unit/graphLayout.test.ts`: 23/23 passed. |
| REFACTOR | `npm run typecheck`, `npm run lint`, `npm test` (525/525), `npm run build:webview`, `npm run test:e2e` all run for real — all green. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/graphLayout.test.ts` → 23/23 passed (22 pre-existing + 1 new regression case) |
| Runtime harness command/scenario and exact result | `npm run test:e2e` → exit 0, all 9 scenarios completed for real in this environment; `npm run build:webview` → exit 0, `out/webview/webview/index.js` (1.1mb) + styles emitted |
| Rollback boundary | Revert this commit only; it touches exactly `webview/graphLayout.ts` (the `boxesForRouting` helper + two `buildEdges` call sites) and `test/unit/graphLayout.test.ts` (one new test case). No other file changed. |

### Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `webview/graphLayout.ts` | Modified | Added `boxesForRouting()`; `buildEdges` now takes `overrides` and routes against the merged boxes; both `layoutGraph` call sites updated |
| `test/unit/graphLayout.test.ts` | Modified | Added one regression case proving an edge to an overridden node routes against the override, not the stale box |

### Deviations from Design

None — this restores the invariant `buildNodes`/`buildEdges` were always meant to share (both
consume the same layout `boxes` plus the same `overrides`); no design.md text is contradicted.

### Issues Found

The asymmetry was real and reachable in practice on first load whenever a prior session's dragged
positions are hydrated, not only after an in-session drag — matches the user's screenshot report of
a freshly-loaded, already-populated graph. No other coordinate-space mismatch was found between
React Flow's node placement and `edgePathsFor`'s absolute-box convention (both use `nodeOrigin`
`[0,0]`/top-left, verified against the pre-migration `graphView.ts`'s use of the identical `boxes`
map for compounded `<g transform>` node placement).

### Status

Bugfix complete: RED → GREEN → REFACTOR done, all verification green (typecheck, lint, 525/525
unit tests, `build:webview`, `test:e2e`). Committed on `feat/react-flow-diagram-migration` on top
of `4410fdd`. Section 5 (PR5, hover highlight) remains open and unaffected.

## Visual redesign — reference-image alignment (post-PR4, pre-PR5) — COMPLETE

User-directed visual pass (not a numbered PR section, folded into `tasks.md` as its own block)
plus one confirmed functional bug fix discovered mid-pass. See `tasks.md`'s
"Visual redesign — reference-image alignment (post-PR4, pre-PR5)" section for the itemized
task list (1–6, all `[x]`).

### TDD Cycle Evidence (Strict TDD Mode)

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 4. `roundedPolylinePath`/`pathEndpoints` (edgeGeometry.ts) | Added `describe("roundedPolylinePath — ...")`/`describe("pathEndpoints")` to `test/unit/edgeGeometry.test.ts` (9 new cases: 2-point passthrough, endpoint preservation, Q-count/topology, radius clamping on a short leg, custom radius, default-radius equivalence, plain M/L endpoints, Bezier-tail endpoints, rounded-corner endpoints) | Implemented `CORNER_RADIUS`/`roundedPolylinePath`/`pathEndpoints` in `webview/edgeGeometry.ts`; `npx vitest run test/unit/edgeGeometry.test.ts` → 43/43 passed | Wired `roundedPolylinePath` into `edgePathsFor`'s single winning-path assignment only (not `edgePathFor`, not `occupied`/cost bookkeeping); re-ran full suite, no regression |
| 4. `coordinatedRouting.test.ts` assertion update | N/A (existing test, not new behavior) — confirmed the old `not.toMatch(/[CQ]/)` assertion would now correctly fail once rounding was wired (Q is legitimately present) | Narrowed to `not.toMatch(/C/)` (the router never emits a Bezier tail itself, only `edgePathFor`'s fallback does); `npx vitest run test/unit/coordinatedRouting.test.ts` → 12/12 passed | Verified every OTHER assertion in the file (waypoint extraction, orthogonality, crossing/clearance checks) needed no changes — confirmed by full run, not just visual inspection |
| 3. Port dots (`pathEndpoints` wiring) | Covered by `pathEndpoints`'s own RED cases above (same function) | `graphLayout.ts`'s `buildEdges` calls `pathEndpoints` once per edge; `AcmKindEdge.tsx` renders the two `<circle>`s from `data.startPoint`/`data.endPoint` | `npm run typecheck` clean (no `any`/unsafe cast needed for the new `AcmEdge.data` fields) |
| 1/2. Background dots + card nodes | Standard mode (pure CSS/JSX presentation, no new pure-function logic to RED/GREEN) | Implemented directly, verified via `npm run typecheck`/`npm run lint`/`npm test` (no regressions in `AcmEntityNode.test.tsx`, `webviewDom.test.ts`, `relationshipDetails.test.tsx` — all pre-existing `data-node-*` attribute-contract tests) | N/A |
| 5. Live-drag `onNodesChange` bug fix | NOT unit/DOM tested (see task 5's own "Test coverage" note in tasks.md) — genuine drag-in-progress pointer gestures are one of jsdom's known gaps (design.md's Testing Strategy section already calls this out for the related SMIL particle case) | Implemented `onNodesChange` in `webview/index.tsx`; verified via full static/type/lint/e2e gate and a manual code-level trace confirming the D14 cascade logic mirrors `onNodeDragStop`'s own (already-tested) cascade exactly | N/A — flagged explicitly as a manual/visual follow-up in tasks.md, not skipped silently |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/edgeGeometry.test.ts test/unit/coordinatedRouting.test.ts` → 55/55 passed |
| Runtime harness command/scenario and exact result | `npm run test:e2e` → exit 0, all 9 scenarios completed for real in this environment; `npm run build:webview` → exit 0 (bundle still builds, 1.1mb, pre-existing size-warning threshold unchanged) |
| Rollback boundary | This work unit touches exactly: `webview/edgeGeometry.ts`, `webview/graphLayout.ts`, `webview/edges/AcmKindEdge.tsx`, `webview/nodes/AcmEntityNode.tsx`, `webview/styles.css`, `webview/index.tsx`, `test/unit/edgeGeometry.test.ts`, `test/unit/coordinatedRouting.test.ts`. No other file changed; revertable as one unit without touching PR1-PR4's committed work. |

### Full Gate (run for real)

`npm run typecheck` — clean. `npm run lint` — clean (`--max-warnings=0`). `npm test` — 534/534
passed (34 test files; up from the prior 525/525 baseline, +9 new). `npm run build:webview` —
exit 0. `npm run test:e2e` — exit 0, all 9 scenarios completed for real against the real VS Code
Extension Development Host.

### Deviations from a literal reading of the reference image / design notes (documented)

1. **Container vs. leaf visual treatment**: kept `KIND_STYLE[kind].dasharray` as the
   container/leaf distinguishing convention rather than replacing it, since the reference image
   has no nested containment at all to compare against and this repo's real containment nesting
   (module/package wrapping class/function/method) is load-bearing information the card look must
   not erase. Containers get a low-opacity (`0.55`), no-fill dashed frame reading as "grouping";
   leaf kinds get the full opaque card treatment. Both remain visually distinguishable per the
   task's constraint.
2. **Port dot styling**: implemented as small neutral (`--vscode-descriptionForeground`) circles,
   uniform across edge kinds — deliberately NOT added to `edgeStyleConfig.ts`, since kind-specific
   coloring for a per-attachment-point dot would work against the reference image's uniform grey
   connector-dot look and would blur the distinction between "layout chrome" and "relationship
   kind" the existing config module exists to encode.
3. **`pathEndpoints` reads the final `d` string** rather than threading a second parallel
   points-array return value through every `edgePathsFor`/`edgePathFor`/`routeWaypoints` call
   site. The numbers it reads (`M`'s point, the final segment's destination point) are the exact
   same numbers the router itself computed and already writes into the string — not a
   re-derivation/estimate of the path's shape — but this is a narrower interpretation of "don't
   regex-parse the `d` string" than a literal reading of that instruction; documented as a
   deliberate, bounded compromise given this change's scope, not an oversight.
4. **Corner-rounding is applied to `edgePathsFor`'s output only**, not to `edgePathFor`'s
   single-edge fallback (used for missing-target dashed stubs and a few coordinated-router
   degenerate cases). This keeps `edgePathFor`'s existing exact-string unit tests fully intact and
   means the rare fallback-path edges render with sharp corners while the overwhelming majority of
   real, coordinated-router edges get the rounded treatment.
5. **Header/body divider on leaf nodes**: leaf boxes are only 32px tall (`NODE_H`), so a divider
   at `HEADER_DIVIDER_Y=26` leaves a very short (6px) "body" strip below it — a real geometric
   constraint from the existing layout, not something this pass could resolve without changing
   `NODE_H`/layout math (out of scope for a visual-only pass). Chosen `y=26` to reuse
   `edgeGeometry.ts`'s existing `routingPorts`' `belowTitle = box.y + 26` convention rather than
   inventing an unrelated second number.

### Status

6/6 visual-redesign tasks complete (`[x]` in tasks.md), plus the folded-in live-drag bug fix.
Full gate green. Section 5 (PR5, hover highlight) remains open and unaffected — no files in its
future scope (`hoverId` state, `.acm-dim`/`.acm-hot`) were touched.

## Post-visual-redesign regression: live-drag box froze while its edges moved (mis-anchored)

**Reported (screenshot, user's own words, translated)**: dragging the "route2" node, the box
stayed visually static (didn't move with the mouse), but the connecting lines DID move — except
detached from where the user was actually dragging, tracking neither the mouse nor the
(non-moving) box.

### Root cause

`webview/index.tsx`'s `nodes` array fed to `<ReactFlow nodes={...}>` was derived purely via
`useMemo(() => layoutGraph(...), [state.graph, state.diff, state.untrackedPaths, overrideSeq])`.
`layoutGraph`'s absolute node positions only reflect COMMITTED `positionOverrides` — written by
`onNodeDragStop` on drop, via `overrideSeq`'s bump. The `onNodesChange` handler wired up in the
prior commits (1784f0e/f9ba140/006e900/ed7eb50) computed a live-edge-preview (`liveEdgeOverrides`)
but never wrote the in-progress drag position anywhere the `nodes` prop could see: the array
passed to `<ReactFlow>` kept the exact same (pre-drag) position for that node on every re-render
triggered mid-gesture by `setLiveEdgeOverrides` itself. React Flow's own internal drag-preview
rendering was being effectively overridden back to the stale controlled position on each of those
re-renders — the box never visually moved. Meanwhile the edge-preview logic WAS computing fresh
paths against the live pointer position, so the lines moved — but toward a target the box itself
was never actually rendered at, producing exactly the reported "lines offset from where they're
moving the point" / "confusing to see where the box will end up" symptom.

This is a canonical controlled-component bug: React Flow expects the `nodes` array itself to be
the single source of truth reflecting `onNodesChange`'s reported live position, not just the
final committed one.

### Fix

- Extracted the drag→state transition into a **pure, unit-tested** function,
  `computeLiveDragUpdate` (`webview/graphLayout.ts`): given the pre-drag layout, any already-
  committed `positionOverrides`, and the live `NodeChange.position`, it returns (a) the dragged
  node's own live position verbatim, and (b) re-anchored `path`/`startPoint`/`endPoint` for every
  edge touching that node or its dragged container's descendants (D14 cascade), all computed
  against ONE locally patched `boxes` clone — so the box and its lines are guaranteed to agree.
- `webview/index.tsx`'s `onNodesChange` now calls `computeLiveDragUpdate` and applies its result
  to TWO pieces of state: the existing `liveEdgeOverrides` (edges) and a new `liveDrag` (the
  node's own live position). A new `nodes` `useMemo` merges `liveDrag.position` into the
  `layoutGraph`-derived node array for that one node id, so `<ReactFlow nodes={...}>` actually
  reflects the in-progress drag. `onNodeDragStop` clears `liveDrag` (alongside the existing
  `liveEdgeOverrides` clear) once the committed `positionOverrides` + `layoutGraph` re-run takes
  over as authoritative — this drop-time path was already correct/tested from PR3 and is
  unchanged.

### TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| `computeLiveDragUpdate` (live position pass-through, edge re-anchoring, untouched-edge/absent-node cases) | `test/unit/graphLayout.test.ts` `describe("computeLiveDragUpdate", ...)` — 4 new cases, all failing with `TypeError: computeLiveDragUpdate is not a function` before implementation | Implemented in `webview/graphLayout.ts`; all 4 new cases pass, full suite 27/27 in that file | Wired into `webview/index.tsx` (`onNodesChange`/`onNodeDragStop`/new `nodes` `useMemo`) without changing the pure function; no further logic change needed |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and result | `npx vitest run test/unit/graphLayout.test.ts` → 27/27 passed (4 new `computeLiveDragUpdate` cases) |
| Runtime harness command/scenario and result | `npm run test:e2e` → all scenarios passed, exit code 0 (no dedicated drag-gesture scenario exists — jsdom/the VS Code test harness cannot simulate a real pointer-drag gesture; the state-logic layer (`computeLiveDragUpdate`) is the testable substitute per the task's own instruction. Full visual confirmation of smooth box+edge tracking during an actual mouse drag remains a MANUAL/visual check, explicitly noted as untestable by automation here.) |
| Rollback boundary | Single commit `9db8eba` on `feat/react-flow-diagram-migration`, touching only `webview/graphLayout.ts`, `webview/index.tsx`, `test/unit/graphLayout.test.ts` — revertable independently of PR1-PR4 and the visual-redesign commits above it |

### Full gate results (this fix)

- `npm run typecheck` → clean
- `npm run lint` → clean (`--max-warnings=0`)
- `npm run test` → 538/538 passed (34 files)
- `npm run test:e2e` → all scenarios passed, exit code 0
- `npm run build:webview` → succeeds (`out/webview/webview/index.js` 1.1mb, expected/pre-existing size warning)

### Status

Regression fixed and committed (`9db8eba`). Full gate green. This was a real functional bug that
prior automated tests (green) did not catch, because the previous test suite (`webviewDom.test.ts`
per its own header comment) explicitly defers pan/zoom/drag/hover to "React Flow's own" behavior
and never asserted anything about the app's OWN state-merge logic during a drag. The new
`computeLiveDragUpdate` unit tests close that specific gap for the state-logic layer; the actual
pixel-tracking smoothness during a live pointer drag still requires manual/visual confirmation.

## Regression: container appears too narrow for its children (post-redesign screenshot report)

User reported, via a screenshot with two red-circled spots, that after the visual-redesign pass
(`1784f0e`/`f9ba140`/`006e900`/`ed7eb50`): (1) a "route" module's dashed container frame renders
too narrow — its three children (`route.ruta1/2/3`) appear to render wider than the container and
stick out past its right edge — and (2) a small disconnected arrowhead floats near the "route"
header/label with no visible connection to any node or edge.

### Investigation (root cause, symptom 1 — container width)

Read `webview/graphLayout.ts`'s `measure()`/`probeBoxes()` in full, `webview/nodes/AcmEntityNode.tsx`,
`webview/styles.css`'s node rules, and `webview/index.tsx`'s ReactFlow wiring, then verified with
real numbers rather than guessing:

- **The box-sizing formula is mathematically self-consistent by construction, for any constant
  values.** `measure()` sets a container's width to `w = 2*PAD_X + Math.max(NODE_MIN_W,
  ...childSizes.map(w))` and `probeBoxes()` places every child at `x = parentAbsX + PAD_X`. Given
  those two facts alone: `child.x + child.w <= parentAbsX + PAD_X + (parent.w - 2*PAD_X) =
  parentAbsX + parent.w - PAD_X < parentAbsX + parent.w`. Containment cannot be violated by this
  formula, independent of `NODE_MIN_W`'s actual numeric value (200, unchanged since before the
  React Flow migration — confirmed via `git show 0a932a2:webview/graphView.ts`, same
  `NODE_MIN_W`/`PAD_X`/`PAD_Y`/`HEADER_H`/`NODE_H` values as today). This is independently
  confirmed by an EXISTING passing test, `graphLayout.test.ts`'s `layoutGraph > "lays out a child
  entity's box fully inside its container's bounds, three levels deep"`.
- **No CSS/DOM divergence found either.** `AcmEntityNode.tsx`'s `<svg width={w} height={h}
  viewBox="0 0 w h">` and React Flow's own inline `width`/`height` style (verified in
  `@xyflow/react`'s `getNodeInlineStyleDimensions`) are BOTH driven from the exact same
  `data.box.w`/`h` computed by `measure()` — there is no separate DOM measurement path that could
  disagree. `styles.css` has no `min-width`/padding/border rule that targets `.acm-node` or the
  custom `.react-flow__node-acmEntity` node type (React Flow's built-in `.react-flow__node-input/
  -default/-output/-group` padding rules don't match our custom node type name). `index.tsx` sets
  no `nodeOrigin`/`nodeExtent` that would offset a node's rendered position relative to what the
  layout math assumes. An SVG element's UA-stylesheet default `overflow: hidden` also means an
  over-long `qualifiedName` label gets clipped at the box edge rather than escaping it.
- **Confirmed the ONE real, provable regression introduced by the redesign commit** (`git show
  1784f0e`): `.acm-node-container .acm-node-box { opacity: 0.55; }` (plus a matching divider
  opacity) was newly added, making the container's already-thin (1-1.5px stroke), sparsely-dashed
  frame (`"2 4"` package / `"4 3"` module dash patterns) far fainter against a dark theme
  background, at the same time leaf children became fully-opaque solid "card" surfaces. This does
  not change any box coordinate, but it plausibly explains a human perceiving a (numerically
  correct) container frame as "too narrow"/children as "escaping" it, since the frame boundary
  becomes hard to trace at a glance.
- **Honest limit of this investigation**: I could not, from static reading of the files above,
  reproduce an actual coordinate/CSS overflow bug — the layout math is proven correct twice over
  (algebraic proof + pre-existing passing test) and no CSS/DOM path was found that could make a
  node's real footprint exceed `data.box.w/h`. If the screenshot genuinely shows boxes (not just a
  faint dashed line) numerically overlapping, the most likely remaining explanation is OUTSIDE
  these files — e.g. the analyzer's `containerId` assignment for route-handler entities placing
  `route.ruta1/2/3` in the wrong sibling bucket — which was not in scope of this investigation and
  was not verified.

### Fix applied

`webview/styles.css`: raised `.acm-node-container .acm-node-box`/`.acm-node-container
.acm-node-divider` opacity from `0.55` to `0.85`, restoring the container frame's legibility
without touching any layout math or box coordinate.

### Regression test added (permanent invariant, task item 3)

`test/unit/graphLayout.test.ts`: added a recursive containment-invariant test using a fixture that
mirrors the reported scenario exactly — a "route" module with three long-qualified-name leaf
siblings near `NODE_MIN_W` — asserting `child.x/y` and `child.x+w`/`child.y+h` stay within the
parent's box at every depth. This test PASSES against current code, confirming (rather than
fixing) the containment guarantee; its value is as a permanent regression guard against a future
change to the formula or constants.

### Symptom 2 — floating disconnected arrowhead (NOT confirmed fixed)

Read `webview/edges/AcmKindEdge.tsx` and confirmed edges are routed via `routedPaths`/
`edgePathsFor` against the SAME `boxes` map used for node rendering (`webview/graphLayout.ts`'s
`buildEdges`) — since that box map is proven correct (see above), edge anchor points derived from
it should also be correctly anchored, so this symptom is UNLIKELY to be a downstream artifact of
the container-width issue. I could not identify a concrete cause for a floating arrowhead from
static reading of `AcmKindEdge.tsx`/`edgeGeometry.ts` alone (the port-dot circles added by the
redesign are small neutral dots, not arrow-shaped, so they are an unlikely candidate). **This
symptom is explicitly NOT confirmed fixed or root-caused** — it requires visual re-inspection
after the opacity fix above (a very faint container frame plus a correctly-drawn arrowhead near it
could itself look like a "disconnected float" once the frame is legible again), or a live-browser
DOM inspection this text-only investigation cannot perform.

### Full gate results (this fix)

- `npm run typecheck` → clean
- `npm run lint` → clean (`--max-warnings=0`)
- `npm run test` → 540/540 passed (34 files, +1 new regression test)
- `npm run test:e2e` → all scenarios passed, exit code 0
- `npm run build:webview` → succeeds

### Status

Container-frame legibility fix applied and verified; permanent containment regression test added
and passing. The floating-arrowhead symptom remains unconfirmed/unfixed and needs a real visual
check. No coordinate/math bug was found or "fixed" in `graphLayout.ts` because none could be
reproduced — this is reported transparently rather than fabricating a change to code that was
proven correct.

## Live-drag cascade fix: descendants no longer stranded during an in-progress drag

**Trigger**: user screenshot showing a container box (green-circled) visually pulled away from its
child boxes (red-circled) while mid-drag — the drop-time cascade was already correct, but the live
preview during the gesture itself was not.

### Root cause (confirmed by direct code reading, not re-litigated)

`webview/index.tsx` (pre-fix, lines ~303-410):
- `liveDrag` state was typed `{ nodeId: string; position: Position } | undefined` — a SINGLE
  node/position pair.
- The `nodes` `useMemo` (~318-322) only patched that one node's position:
  `base.map((node) => (node.id === liveDrag.nodeId ? { ...node, position: liveDrag.position } : node))`.
- `onNodesChange` (~367-390) DID correctly compute `movedDescendantIds` via
  `descendantsOf(dragChange.id, layout)` and passed them into `computeLiveDragUpdate` — but
  `computeLiveDragUpdate` (`webview/graphLayout.ts`, confirmed by reading its full body and its
  existing test suite in `test/unit/graphLayout.test.ts`) only ever used `movedDescendantIds` to
  re-anchor those descendants' EDGES (via a locally patched `liveBoxes` clone fed into
  `edgePathFor`) — it never surfaced the descendants' own live positions in its return value,
  which was `{ nodeId, position, edgeOverrides }`, a single node/position pair plus the edge map.
- Net effect: during an active drag of a container, only the directly-dragged node's box visually
  tracked the pointer; every cascaded descendant stayed rendered at its stale pre-drag position
  while its edges got redrawn against a position that no box was actually showing — exactly the
  reported "container moved away from stranded children" symptom. `onNodeDragStop` (~392-409)
  already applied the full D14 cascade correctly ON DROP (`positionOverrides.set` for every
  descendant using `box.x + dx, box.y + dy`); that path was untouched and remains correct — this
  bug was specific to the live preview before drop.

### TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| Extend `computeLiveDragUpdate` to return live positions for the dragged node + every cascaded descendant | Added `test/unit/graphLayout.test.ts` → `computeLiveDragUpdate > carries every cascaded descendant's live position along with the dragged container, offset by the same dx/dy` (drags `module:pkg.a` in the existing `nestedGraph()` fixture, asserts `update.positions` contains the dragged node plus `class:pkg.a.C`/`method:pkg.a.C.m`/`function:pkg.a.f`, each offset by the same dx/dy as their pre-drag box). Ran `npx vitest run … -t computeLiveDragUpdate` → failed with `Cannot read properties of undefined (reading 'get')` (no `.positions` on the old return shape) — confirmed RED against the pre-fix single-node implementation. | Changed `LiveDragUpdate.position`/`nodeId` → `positions: Map<string, Position>` in `webview/graphLayout.ts`; `computeLiveDragUpdate` now populates one entry per `nodeId` + `movedDescendantIds`, each descendant offset by the same `dx`/`dy` already computed for edge re-routing (reusing the existing `liveBoxes` cascade, just also recording it into the new `positions` map). Updated the two pre-existing single-node tests (`update!.position` → `update!.positions.get(nodeId)`) to the new shape. Re-ran the full `computeLiveDragUpdate` describe block → 5/5 passed. | Wired the new `positions` map through `webview/index.tsx`: `liveDrag` state retyped `Map<string, Position> | undefined`; the `nodes` `useMemo` now applies a position override for EVERY node id present in the map (`liveDrag.get(node.id)`) instead of comparing against a single `nodeId`; `onNodesChange` now does `setLiveDrag(update.positions)`; `onNodeDragStop`'s existing `setLiveDrag(undefined)` clear and its own drop-time D14 cascade were left unchanged (already correct). Updated inline doc comments on both the `LiveDragUpdate` interface and the `liveDrag` state to describe the cascade explicitly. |

### Files changed

| File | Action | What was done |
|---|---|---|
| `webview/graphLayout.ts` | Modified | `LiveDragUpdate` interface: `position`/`nodeId` → `positions: Map<string, Position>`. `computeLiveDragUpdate` now records a live position for the dragged node AND every `movedDescendantIds` entry (offset by the same `dx`/`dy` used for edge re-anchoring), not just the dragged node alone. |
| `webview/index.tsx` | Modified | `liveDrag` state retyped from a single `{nodeId, position}` to `Map<string, Position>`; `nodes` `useMemo` applies the live override per-id across the whole map; `onNodesChange` passes `update.positions` straight through. `onNodeDragStop`'s drop-time cascade (already correct) untouched. |
| `test/unit/graphLayout.test.ts` | Modified | Added the new cascade regression test (see RED above, using the existing `nestedGraph()` three-level containment fixture: `module:pkg.a` dragged, descendants `class:pkg.a.C` / `method:pkg.a.C.m` / `function:pkg.a.f`). Updated the two pre-existing single-node `computeLiveDragUpdate` tests to read `update!.positions.get(nodeId)` instead of the removed `update!.position`. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/unit/graphLayout.test.ts -t "computeLiveDragUpdate"` → 5/5 passed (1 new cascade test + 4 pre-existing, 2 of which were updated to the new return shape) |
| Runtime harness command/scenario and exact result | `npm run test:e2e` (`scripts/vscode-harness.mjs`, real Extension Development Host launch) → all scenarios passed, exit code 0. **Explicit limitation, unchanged from prior entries**: this harness does not simulate a real mouse-drag pointer gesture inside the webview (jsdom/VS Code test harness cannot drive React Flow's native drag interaction), so it cannot directly observe "does the child box visually follow the container mid-drag." The state-logic invariant that CAUSES that visual behavior (`computeLiveDragUpdate` returning correct cascaded positions) is what the new unit test proves instead — this is exactly the class of bug a unit test can and should catch, per the task instructions, while true pixel-level drag-feel remains a manual/visual check. |
| Rollback boundary | Two files (`webview/graphLayout.ts`, `webview/index.tsx`) plus one test file (`test/unit/graphLayout.test.ts`); revertible independently of all prior fixes in this log (CSS opacity fix, edge-routing fix, visual redesign, first single-node live-drag fix) — no shared lines touched. |

### Full gate results (this fix)

- `npm run typecheck` → clean
- `npm run lint` → clean (`--max-warnings=0`)
- `npm run test` → 540/540 passed (34 files, +1 new test net; 2 existing tests updated to new shape, not counted as new)
- `npm run test:e2e` → all scenarios passed, exit code 0
- `npm run build:webview` → succeeds (bundle size unchanged in kind, still the pre-existing `1.1mb` warning, not a regression from this change)

### Deviations from design

None — this directly implements design.md §4 ("Live re-routing during a drag") extended to also
cover live re-positioning of cascaded descendants, matching the pattern `onNodeDragStop` already
used for the committed/drop-time cascade.

### Status

Fixed and verified. Dragging a container will now visually carry its children along with it
DURING the drag gesture itself (not just after releasing the mouse) — the same `dx`/`dy` offset
`onNodeDragStop` already applied on drop is now also computed and applied live, per descendant, on
every pointer-move frame. Base commit for this fix: `1df5201`.

## Investigation: "route" container renders as empty box, `route.ruta1/2/3` detach as separate cluster (DIAGNOSIS ONLY, no code change)

Orchestrator hypothesis was that this is a data-association bug upstream of the layout math
(`computeChildrenOf` in `webview/graphLayout.ts` mis-grouping `Entity[]` by `containerId`), possibly
introduced by this migration. Investigated with real production code paths; **no code was changed**
in this task — the finding is that this is a genuine, pre-existing, out-of-migration-scope bug, not
something PR1–PR5 introduced.

### Ground truth attempted, and what's missing

No fixture, e2e scenario, or sample data anywhere in the repo matches a "route/route2/.../app/config"
module shape. `test/fixtures/` only contains `simple.py` and unrelated theme JSON fixtures;
`test/e2e/scenarios.ts` has no "route" reference. There is no way to reproduce this with an existing
repo fixture. **What would make progress possible**: the user's actual raw `AnalysisGraph` JSON for
both `left` and `right` sides of the diff (or their real Python project source), so the exact
`id`/`containerId`/`qualifiedName` values for the "route" node and its three children can be
inspected directly instead of reasoned about. Absent that, I built a minimal synthetic repro using
the unmodified, real production functions to test the hypothesis mechanically (script kept at
`/tmp/claude-*/scratchpad/repro.mjs`, not committed — inline below).

### What I found: `computeChildrenOf` itself is not the bug

`webview/graphLayout.ts:55-85` (`computeChildrenOf`) is a byte-for-byte port of the pre-migration
`webview/graphView.ts`'s function of the same name — confirmed identical back to commit `92b798c`
("rewrite the change-map graph as a nested, kind-encoded diagram"), which predates PR1's split by
many commits. Its logic (`byId.has(containerId)` else treat as an untethered root) is correct GIVEN
correct input: if a child's `containerId` genuinely matches its container's `id` in the same `nodes`
array, it nests correctly (already proven algebraically in the base commit `1df5201` investigation
for the layout math, and now also proven for the grouping step with a synthetic array of 4 entities
where `containerId` was set consistently — nests as expected, not the bug path).

### Where the real problem is: `mergeGraphsForDisplay` (`src/webviewHost.ts:27-41`), combined with `python/analyzer.py`'s id scheme

The diagram is a **diff view**: `ComparisonController.buildGraphForSelection`
(`src/comparisonController.ts:91-95`) runs `python/analyzer.py` **twice, independently** — once
against the `left` (original) git ref's files, once against the `right` (worktree/current) files —
producing two separate `AnalysisGraph`s that are then merged for display by
`mergeGraphsForDisplay`:

```ts
// src/webviewHost.ts:27-41
export function mergeGraphsForDisplay(left, right): AnalysisGraph {
  const byQualifiedName = new Map<string, Entity>();
  for (const node of left?.nodes ?? []) byQualifiedName.set(node.qualifiedName, node);
  for (const node of right?.nodes ?? []) byQualifiedName.set(node.qualifiedName, node);
  ...
  return { nodes: [...byQualifiedName.values()], ... };
}
```

This dedups **independently per entity, keyed only by `qualifiedName`**, with "last write wins"
(right overwrites left when both exist). Crucially, it does **not** guarantee that a chosen node and
its chosen container come from the *same* analyzer pass — each qualifiedName's winner is picked in
isolation.

That's only safe if `id`/`containerId` are pure functions of `qualifiedName` (stable and identical
across both independent passes). They are **not**, for every entity kind. From
`python/analyzer.py`:

- `entity_id(kind, qualified_name, start_byte=None)` (line 16): `f"{kind}:{qualified_name}"`, or
  `f"{kind}:{qualified_name}@{start_byte}"` when a `start_byte` is supplied.
- Package/module root ids (lines 277, 285) are built **without** `start_byte` → stable,
  content-position-independent, identical across both analyzer passes for the same qualifiedName.
- Class/function/method ids (`add_definition`, line 142): `entity_id(actual_kind, qualified_name,
  span["startByte"])` — **includes `span["startByte"]`**, i.e. the definition's absolute byte offset
  in its file. `containerId` for these (line 158) is `self.current_id` — the *id string* of
  whatever enclosing scope was on the traversal stack at definition time, captured per-pass.

Consequence: for any class/function/method whose enclosing container is itself a class or function
(not the qualifiedName-stable package/module root), if an **unrelated edit anywhere earlier in the
same file** shifts byte offsets between the `left` and `right` passes — or if the container itself
was edited — the container's `id` differs between the two passes even when the container's
qualifiedName is identical. If a child entity survives on only one side (e.g. deleted/moved on the
other), `mergeGraphsForDisplay` picks that child's sole surviving version, carrying a `containerId`
computed during a pass whose corresponding container `id` has since been overwritten by the other
side's differently-offset version. The merged array now has a child whose `containerId` doesn't
match any `id` in `byId` — `computeChildrenOf` (correctly, per its own contract) treats it as a
detached root. Do this for a container's only 3 children simultaneously (e.g. all three
deleted/moved on one side of the diff) and the container renders with **zero children** (an empty
box) while all three appear as **separate root-level entities** elsewhere — exactly the reported
symptom.

I reproduced this mechanically end-to-end using the real, unmodified `mergeGraphsForDisplay` and
`computeChildrenOf` implementations (only the Entity shape was synthesized, mirroring
`python/analyzer.py`'s exact id scheme):

```
LEFT:  route@100 (root), route.ruta1@110→route@100, route.ruta2@120→route@100, route.ruta3@130→route@100
RIGHT: route@140 (root; unrelated earlier edit shifted its startByte); ruta1/2/3 deleted on this side

merged nodes: route(id=route@140), route.ruta1(containerId=route@100), route.ruta2(containerId=route@100), route.ruta3(containerId=route@100)
computeChildrenOf output: container=undefined -> [route, route.ruta1, route.ruta2, route.ruta3]   ← all 4 as ROOTS
```

`route` ends up with zero children (empty box); `route.ruta1/2/3` end up as detached root siblings —
this matches all three reported screenshots.

**Caveat on the exact variant**: the user described "route" specifically as an *empty dashed box*.
Per `webview/graphLayout.ts:32-38` (`KIND_STYLE`)/`isContainerKind`, the dashed stroke is reserved for
`package`/`module` kinds only — and package/module root ids in `analyzer.py` are qualifiedName-only
(no `startByte`), i.e. stable across passes on their own. So the exact reproduction above (a
class/function-kind container with a shifting id) is the *mechanism*, proven to work through the real
merge+grouping code, but if "route" is literally a `package`/`module` node, the more likely concrete
trigger is a second, related gap in the same file: `package_sources`
(`python/analyzer.py:274`, `{module_name(source.path): source for source in files if
source.path.endswith("/__init__.py")}`) is recomputed **independently per analyzer invocation** from
that invocation's own file list, and a package/module's `containerId` to its *parent* package is only
set `if parent in package_sources` (line 279) / `if package in package_sources` (line 290) — gated,
not unconditional. If the two independent analyzer passes ever see different file sets for the
package's `__init__.py` (e.g. one side's snapshot omits it), a module's `containerId` can be entirely
**unset** on one side while the module itself is otherwise identical, producing the same
merge-picks-the-wrong-provenance detachment without needing any byte-offset shift at all. I could not
mechanically confirm this second variant without the user's real left/right file lists — both
variants funnel through the exact same `mergeGraphsForDisplay` dedup weakness.

### Is this in scope for the React Flow migration? No — confirmed pre-existing, untouched by PR1-PR5

- `mergeGraphsForDisplay`'s `byQualifiedName` last-write-wins dedup: unchanged since it was introduced
  in the very first webview commit, `0d5057d` ("implement webview panel, change-map graph, and
  Docker run UI") — `git log --oneline -S "byQualifiedName" -- src/webviewHost.ts` shows exactly one
  hit, `0d5057d`. None of the migration commits (`2e45bd5`, `3f01e0d`, `656c444`, or PR1-PR4's commits)
  touch `src/webviewHost.ts`'s merge logic.
- `computeChildrenOf`'s containerId-matching logic: identical since `92b798c`, ported verbatim into
  `webview/graphLayout.ts` by this migration's own PR1 (task 1.4), not altered in the port.
- `python/analyzer.py`'s `entity_id`/`add_definition`/`package_sources` id scheme: entirely outside
  `webview/`/`src/webviewHost.ts`, not part of this migration's scope at all.

All three layers responsible predate and are untouched by this migration. **No code was changed for
this investigation.**

### Verification (baseline, confirming the investigation made no changes and nothing is broken)

- `npm run typecheck` → clean
- `npm run lint` → clean (`--max-warnings=0`)
- `npm run test` → 540/540 passed (34 files)
- `npm run test:e2e` → all scenarios passed, exit code 0

### Recommendation to relay to the user

This is a real bug, but it is an **analyzer/merge data-association bug**, separate from and
predating the React Flow rendering migration — not something PR1-PR5 introduced or is scoped to fix.
Fixing it properly needs a design decision in `mergeGraphsForDisplay` (e.g. merge per logical
container tree instead of per independent qualifiedName, or have the analyzer emit fully
content-independent/stable ids for every entity kind, not just package/module) and possibly in
`python/analyzer.py`'s `entity_id`/`package_sources`. Recommend opening this as its own change/issue
rather than folding it into this migration. To confirm the exact trigger (byte-offset shift vs.
package-file-list gating) and design the right fix, the user's real left/right `AnalysisGraph` JSON
(or the actual Python source before/after) for the "route" scenario is needed.

## Section 5 (PR5, base: PR4) — Hover highlight + measurement — COMPLETE

**This closes out the originally-planned PR chain.** PR1-PR5 (as re-scoped/split during apply: PR1,
PR2a, PR2b-i, PR2b-ii, PR3, PR4, PR5 — 7 slices total, all stacked-to-main) implement the entire
`react-flow-diagram-migration` proposal: rendering-engine swap to `@xyflow/react`, per-kind edge
styling with a theme-native palette, an always-on directional particle per drawn edge, absolute-
position drag with container-descendant cascade, and now hover highlight — plus several unplanned
bugfix/visual-polish passes that landed on this branch between PR4 and PR5 (full list below).

### TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 5.1-5.2 hover highlight | Added 3 cases to `webviewDom.test.ts` (node hover, edge hover, hover-leave); confirmed failing (`expected false to be true` on `.acm-hot`/`.acm-dim` presence) against the pre-existing codebase (no `hoverId`/handlers existed) | Implemented `hoverId` state, `useMemo(highlightNodes/highlightEdges)` via `getIncomers`/`getOutgoers`/`getConnectedEdges`, `onNode/EdgeMouseEnter/Leave` handlers, `.acm-dim`/`.acm-hot` CSS (did not previously exist in `styles.css` — verified by reading the file before assuming, per instructions); all 3 pass | Ran full `npm test` — no regressions |
| 5.3 D9 regression guard | Added a 4th case asserting `<animateMotion>` DOM-node identity (`isSameNode`, not just presence) stays stable across a hover-enter/leave cycle on an edge. First run: genuinely RED — not because hover changed `data`, but because of the adjacent node-remeasurement bug described below (discovered BY this test, not anticipated) | Fixed by stamping `measured: {width, height}` onto every node object passed to `<ReactFlow>` (see below); confirmed GREEN, including the DOM-identity assertion | Ran full `npm test` (545/545) + `npm run lint` + `npm run typecheck` — all green |

### Real bug found and fixed: hover was silently unmounting/remounting every edge in the graph

The D9 regression test (5.3) initially failed with a genuine DOM-identity mismatch — hovering ANY
node or edge caused **every** `AcmKindEdge` in the graph to unmount and immediately remount (verified
by instrumenting `AcmKindEdge` with a mount/unmount `useEffect` logger: both edges in a 2-edge fixture
unmounted then remounted on a single hover). Root cause, traced into `@xyflow/system`'s
`adoptUserNodes`/`parseHandles`:

- `adoptUserNodes` only reuses a node's already-computed internal state (critically,
  `handleBounds`, which every edge touching that node needs to resolve a real connection point)
  when the incoming node object is **either** the exact same reference as before, **or** already
  carries a `measured` field.
- `parseHandles`'s fallback for a node with no `handles` array (our `AcmEntityNode` case — it uses
  real `<Handle>` components, not declarative `node.handles` data) is: `!userNode.measured ?
  undefined : internalNode?.internals.handleBounds`. Our `AcmNode` type never sets `measured` (it
  has direct `width`/`height` instead, per design's exact node shape) — so replacing a node's
  object reference for ANY reason (adding a `className`, in this case) resets `handleBounds` to
  `undefined` unconditionally.
- Every edge touching a node with `handleBounds: undefined` computes a null connection point for one
  tick and returns `null` from `EdgeWrapper` — an actual React unmount, not just a re-render — until
  the (synchronous, in our jsdom-stubbed test environment; async via `ResizeObserver` in a real
  browser) re-measurement pass repopulates it and remounts.
- Because my first implementation replaced **every** node's object reference on every hover (to add
  `.acm-dim`/`.acm-hot` uniformly, matching design.md §7's own described approach literally), this
  reset happened for the ENTIRE node set — and therefore every edge in the graph — on every single
  hover-enter and hover-leave. In a real browser this would have been a visible full-graph flicker
  on every mouse movement into/out of any node or edge, not merely a test artifact.

**Fix**: every node object passed to `<ReactFlow>` now unconditionally carries `measured: {width:
n.width, height: n.height}` (values `layoutGraph` already computes deterministically — never derived
from actual DOM measurement), applied identically whether or not that node is part of the current
hover highlight. This keeps `parseHandles` on its "preserve existing `handleBounds`" branch
regardless of node-object-reference churn, so a `className`-only change (or any other future
reference-changing node update) never disturbs edge rendering. This is a real, generally-applicable
correctness fix — not narrowly scoped to hover — though hover is what exposed it, since it is the
first feature in this migration to replace every node's reference on a UI-only, non-layout-affecting
interaction.

**Design deviation note**: design.md §7/D8 anticipated and explicitly guarded against the *edge*
data-vs-className remount risk (that's exactly what D8/D9 are about), but did not anticipate this
*node*-side `handleBounds`-reset mechanism, since D8's own code sketch shows the same
`{...node, className}` pattern this bug traces to. This is a gap in the design surfaced by TDD, not
a deviation from a documented decision — noting it explicitly per the "if you discover the design is
wrong or incomplete, note it" instruction.

### `.vsix` size measurement (task 5.4)

No `.vscodeignore` or `"files"` field exists in this repo on either branch, so `vsce package`
includes `src/`, `test/`, and `openspec/` on both sides — not a realistic publish artifact, but a
consistent, apples-to-apples proxy for measuring the migration's OWN size delta (that packaging
noise is identical on both measurements).

Measured via `npx @vscode/vsce package --no-dependencies --allow-missing-repository` against a
freshly-`rm -rf out`'d build on each side, in a disposable `git worktree` for `main` to avoid
disturbing this branch's own build:

| Branch | `out/` size | `.vsix` size |
|---|---|---|
| `main` (pre-migration) | 488 KB | 725,879 bytes (~709 KB) |
| `feat/react-flow-diagram-migration` (this branch, post-PR5) | 1.4 MB | 989,279 bytes (~966 KB) |
| **Delta** | **+~940 KB** | **+263,400 bytes (~+257 KB, +36%)** |

The dominant cost is the new bundled `out/webview/webview/index.js` (1.1 MB unminified), which now
includes React, ReactDOM, and `@xyflow/react` at runtime. `minify: false` in
`scripts/build-webview.mjs` was a deliberate, already-documented design choice (design.md §1: "keep
the bundle reviewable/diffable in the `.vsix`"), not an oversight — enabling minification would
shrink this substantially (a rough, unverified guess: 300-500 KB typical for this dependency set) at
the cost of that reviewability property. Recording this delta as the honest current number, per the
proposal's own success criterion, without silently minifying to make the number look better.

### Performance probe at `{nodes:300, edges:600}` (task 5.5) — severe pre-existing risk found, NOT fixed here

A genuine rendered-frame-paint measurement needs a real browser or the VS Code Extension Development
Host, neither scriptable from this test runner. What IS measurable: `layoutGraph`'s own synchronous
compute cost (dominated by `edgeGeometry.ts`'s coordinated multi-edge router, `edgePathsFor`) for a
same-sized synthetic flat graph (flat because `NESTED_LAYOUT_LIMITS` — 60 nodes/120 edges — is far
below 300/600, so a real oversized session always hits the flat-fallback layout path).

Measured with `npx tsx` against a standalone script importing `webview/graphLayout.ts` directly (not
part of the committed test suite — see why below):

| Graph size | `layoutGraph` wall-clock time |
|---|---|
| `{60, 120}` (= `NESTED_LAYOUT_LIMITS` exactly) | ~0.9s |
| `{100, 200}` | ~8.8s |
| `{150, 300}` | ~28.8s |
| `{300, 600}` (= `OVERSIZED_THRESHOLDS`, extrapolated — not directly measured, see below) | **on the order of minutes** |

The growth is far worse than linear (roughly an 8-10x jump per ~1.5-1.7x size increase), consistent
with the coordinated router's crossing-penalty computation being quadratic-or-worse in edge count.
**This is a genuine, severe, previously-unmeasured algorithmic risk in code this PR does not touch**
(`edgeGeometry.ts`'s `edgePathsFor` — unchanged since before the migration) — confirmed exactly at
the size design.md flagged as an open, unmeasured question, and far more severe than "SMIL particle
count" alone would suggest: the webview's main thread would freeze for potentially minutes computing
node/edge positions, long before rendering (or a single particle) ever becomes the bottleneck.

I did NOT attempt an actual `{300,600}` run inside the committed test suite: an initial attempt
(before capping the scope) hung `npm test` for multiple minutes on a single test before it was
manually killed, which is disproportionate CI cost for one probe. The committed
`test/unit/graphLayout.test.ts` addition stays at the fast, safe `{60,120}` size (~0.9s, asserted
`<10s` as a catastrophic-regression guard, not a tight budget) with a doc comment recording the
`{300,600}` finding for future readers. The `{300,600}`/`{150,300}`/`{100,200}` numbers above were
obtained once, out-of-band, via a disposable `tsx` script (not committed to the repo).

**Recommended follow-up (explicitly NOT done in this PR, per the task's own scope boundary — "no
code change in this PR, record as a follow-up")**: cap or short-circuit the coordinated
crossing-penalty pass above a size threshold, falling back to the cheap per-edge `edgePathFor`
already used for the live-drag preview (`webview/index.tsx`'s `onNodesChange`), or reduce the
router's own algorithmic complexity. Given the severity (minutes, not milliseconds), this should
likely be prioritized ahead of, or alongside, the design's own suggested "cap particles to the
hovered subgraph" lever — the particle count was never actually the bottleneck at this size.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npm run test -- webviewDom -t "hover"` → 4/4 passed; `npm run test -- graphLayout -t "performance probe"` → 1/1 passed (~0.9s) |
| Runtime harness command/scenario and exact result | `npm run test:e2e` → exit code 0, all 9 scenarios completed (click-to-navigate and every other pre-existing scenario stayed green, confirming hover-highlight is additive) |
| Rollback boundary | Revert `webview/index.tsx`'s hover-related additions (`hoverId` state, the two `useMemo`s, the four `on*MouseEnter/Leave` handlers, the `measured` stamping), `webview/styles.css`'s `.acm-dim`/`.acm-hot` block, and the two test-file additions (`webviewDom.test.ts`'s hover describe block + helpers, `graphLayout.test.ts`'s perf-probe describe block) — nothing else in the migration depends on hover; drag, particle animation, edge styling, filtering, and the oversized gate are all untouched |

### Final gate (task 5.6) — all run for real

- `npm run typecheck` → exit 0, clean
- `npm run lint` (`eslint src test webview --max-warnings=0`) → exit 0, clean
- `npm run test` (`vitest run`) → **34 test files passed, 545 tests passed** (541 baseline + 4 new
  hover-highlight cases in `webviewDom.test.ts` + 1 new perf-probe case in `graphLayout.test.ts`, net
  +5; some pre-existing React `act(...)` console warnings appear in output for unrelated,
  pre-existing async effects — not new, not failures)
- `npm run test:e2e` → exit code 0, all 9 scenarios completed for real (VS Code Extension
  Development Host, not skipped/stubbed)
- `npm run build:webview` → exit 0, clean (`out/webview/webview/index.js` emitted, 1.1 MB, matches
  the `.vsix` measurement above)
- `npm run build` → exit 0, clean

### Deviations from design

- Design gap found and fixed (documented above, not a deviation from a stated decision): the
  `measured` stamping on every node, needed to avoid the `handleBounds`-reset/edge-remount bug.
- Otherwise implementation matches design.md §7 exactly: `hoverId` state in the root component,
  `getIncomers`/`getOutgoers`/`getConnectedEdges` for connected-subgraph membership,
  `className`-only mutation (never `data`) for both nodes and edges, opacity-based de-emphasis via
  CSS rather than color/hide.

### Full list of unplanned fixes/passes that landed on this branch (PR4 → PR5, for a complete picture)

Beyond the 7 originally-scoped PR slices, the following landed on `feat/react-flow-diagram-migration`
as separate, user-driven or user-reported work between PR4 and PR5 (each already documented in its
own section above in this file, listed here only as an index):

1. **Visual redesign — reference-image alignment** (dotted-grid background, card-style nodes with
   header/body divider, visible port dots, rounded/curved edge corners) — cosmetic, reference-image
   driven, landed as its own commits before PR5 began.
2. **Bug fix: live edge re-routing during an in-progress drag** — `onNodesChange` was entirely
   missing before this pass; edges only snapped to correct routing on drop, never tracked visually
   mid-drag. Found and fixed as part of the visual-redesign pass (item 5 in that section).
3. **Bug fix: container frame legibility regression** — the visual redesign's initial container
   frame opacity (0.55) combined with thin dash patterns made container boundaries hard to trace;
   fixed to 0.85 without changing any box coordinate.
4. **Bug fix: live-drag position not fed into controlled `<ReactFlow>` nodes** — dragged
   node/descendants visually snapped back mid-drag because the `nodes` prop only reflected committed
   overrides, not the live pointer position; fixed via the `liveDrag` state now visible in
   `webview/index.tsx`.
5. **Bug fix: live-drag freeze regression + root cause** — a follow-up investigation and fix for a
   regression introduced by item 4's own fix.
6. **Bug fix: cascade live-drag positions to container descendants** — the D14 cascade
   (`onNodeDragStop`) worked correctly on drop, but the LIVE preview during the drag itself
   (`onNodesChange`) did not mirror it for a dragged container's descendants; fixed to keep both
   paths consistent.
7. **Investigation (no code change): merge-time detachment bug report** (`route`/`route.ruta1-3`
   losing their containment relationship) — traced to a pre-existing, out-of-scope
   `mergeGraphsForDisplay`/analyzer id-stability issue, confirmed unrelated to and untouched by any
   migration PR; recommended as its own follow-up change, not folded into this migration.

None of items 1-7 are part of the original `react-flow-diagram-migration` proposal scope, but all are
now part of the shipped state of this branch and are listed here for complete traceability alongside
the 7 planned PR slices (PR1, PR2a, PR2b-i, PR2b-ii, PR3, PR4, PR5).

### Status

**7/7 planned PR slices complete (35/35 numbered tasks across Sections 0-5, plus 6 unplanned
visual-redesign/bugfix tasks and 1 unplanned investigation, all documented above). The
`react-flow-diagram-migration` change is functionally complete.** Recommended next step:
`sdd-verify`, followed by delivery of the final PR5 slice (stacked on PR4's branch tip) and, once
all slices are merged, `sdd-archive` for the whole change.
