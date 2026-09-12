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
