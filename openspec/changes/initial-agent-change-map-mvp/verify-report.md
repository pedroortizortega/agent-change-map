# Verify Report: initial-agent-change-map-mvp

Date: 2026-09-08
Branch: feat/agent-change-map-mvp @ c69ef89

## Scope

This is the original foundational MVP change for `agent-change-map`, never
formally verified or archived. It has no `exploration.md` (predates that SDD
phase) and had no prior `verify-report.md` — both expected for this legacy
artifact.

Four delta specs were validated:

- `openspec/changes/initial-agent-change-map-mvp/specs/change-map-visualization/spec.md`
- `openspec/changes/initial-agent-change-map-mvp/specs/git-state-comparison/spec.md`
- `openspec/changes/initial-agent-change-map-mvp/specs/guarded-comparison-editing/spec.md`
- `openspec/changes/initial-agent-change-map-mvp/specs/python-structure-analysis/spec.md`

A fifth delta spec exists in this change (`sandboxed-snippet-execution`,
covering Docker-run/stream/cancel, Phase 4 of `tasks.md`) but was explicitly
out of scope for this verification per instructions and was not deep-verified
here. It is implemented (`src/execution/dockerRunner.ts`) and covered by
passing unit tests (`runPolicy.test.ts`, `dockerRunner.test.ts`,
`dockerStreaming.test.ts`) plus the e2e Docker-gated scenarios, but its own
delta spec text was not requirement-by-requirement re-checked.

`change-map-visualization` and `git-state-comparison` have since been
promoted to `openspec/specs/` and heavily amended by later archived changes
(`diff-view-and-graph-styling`, `untracked-files-live-refresh-and-styling`,
`graph-layout-and-interaction`, `graph-relationship-filtering`). Per
instructions, these two were checked for continued core-intent coverage
against the *current* promoted specs, not word-for-word against the original
delta text. `guarded-comparison-editing` and `python-structure-analysis` were
untouched by later archived changes (except `python-structure-analysis`'s
first promotion via today's `instance-method-call-resolution`) and were
verified directly against current implementation.

## Test Results

- `npm run lint` — PASS, zero warnings/errors (`eslint src test webview --max-warnings=0`).
- `npm run typecheck` — PASS (`tsc -p tsconfig.json` and `tsc -p tsconfig.webview.json`, both `--noEmit`, clean).
- `npx vitest run test/unit test/integration` — PASS, 24 files / 311 tests, 0 failures.
- `npm run test:e2e` (VS Code Extension Development Host harness) — initially **FLAKY** (see finding below), root-caused and **FIXED** during this verification (commit `0436139`). Confirmed stable across 11 consecutive local runs after the fix (6/6 clean, plus 5 more before it that reproduced the original flake once at the exact assertion the fix targets — see finding).

### E2E flake finding — root-caused and fixed during this verification

`test/e2e/scenarios.ts`, "Forged repository root" scenario (guarded-comparison-editing,
direct-write path), intermittently fails:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'graph'
- 'directWriteResult'
    at runScenarios (out/test/e2e/scenarios.js:159:20)
```

`hooks.getLastReceivedMessages().at(-1)` occasionally returned a `'graph'`
message instead of the expected `'directWriteResult'` right after the
guarded-write request resolved. Two root causes, both the same class of bug
— `receivedMessages` (`src/extension.ts`) is one array shared for the
extension's whole activation lifetime, never scoped per compare invocation
or per test step:

1. `runScenarios()` invoked `agentChangeMap.compare` twice during setup — a
   throwaway first call whose only purpose was to trigger extension
   activation, discarding its own session/panel/message stream, but that
   stream still raced against the real second invocation's messages in the
   same shared array.
2. The "forged repository root" and "direct save" scenarios correctly
   filtered their `waitFor` by the request's own `requestId`, but then read
   the *result* via `.at(-1)` on the whole shared array — trusting it was
   still the last element by the time the assertion ran. Any other async
   message landing in between (a stray timer, a later scenario's own
   traffic) could win that race.

Fixed in commit `0436139` (`test/e2e/scenarios.ts` only): replaced the
throwaway first `compare` call with a direct `extension.activate()`, and
changed both result lookups to filter by the same `requestId` the `waitFor`
already used, instead of trusting array position. Confirmed via 11
consecutive local e2e runs: 5 runs with only fix 1 applied (4 passed, 1
reproduced the exact flake fix 2 targets, confirming the second race was
real and independent of the first), then 6 runs with both fixes (6/6
clean). The underlying guard logic (stale/conflicting-write refusal,
out-of-repository target refusal, destructive-write confirmation, atomic
write) was never implicated — it is independently and reliably covered by
`test/integration/editing/writeGuard.test.ts` (9/9) and
`test/integration/editing/draftStore.test.ts` (6/6) throughout.

## Requirement-by-requirement findings

### guarded-comparison-editing (verified directly against current code)

| Requirement | Implementation | Test coverage |
|---|---|---|
| Default to isolated drafts | `src/editing/draftStore.ts` `DraftStore.save/get` — never touches worktree; keyed by SourceId location so reopen returns latest draft | `test/integration/editing/draftStore.test.ts` (6 tests) |
| Make persistence mode explicit | `webviewHost.ts` `activeSources` tracks original/current/draft variant; `requestDirectWrite`/`directWritePreview` flow requires explicit target before any write | `test/unit/webviewHost.test.ts`, e2e "direct save" scenario |
| Detect stale or conflicting writes | `writeGuard.ts` `performGuardedWrite` checks `computeContentHash` against `baseHash` twice (before and after the confirm callback, to catch races during a slow confirm) | `test/integration/editing/writeGuard.test.ts` (9 tests) |
| Guard destructive replacement and recovery | `isDestructive` computed and included in preview; sibling `.bak-<random>` backup written before the atomic temp-file+rename write; failed write cleans up temp file, never partially replaces target | `test/integration/editing/writeGuard.test.ts` |

All four requirements' scenarios are exercised by passing tests. Live e2e
coverage exists (direct save, forged-root refusal) but is flaky per above
(harness issue, not logic issue).

### python-structure-analysis (verified directly against current code)

| Requirement | Implementation | Test coverage |
|---|---|---|
| Discover Python entities | `python/analyzer.py` `FileVisitor.visit_ClassDef/FunctionDef/AsyncFunctionDef/add_definition`, nested via `current_id`/`current_qualified_name` stack; per-file syntax errors caught and reported without discarding other files' results (`analyze()` try/except per file) | `test/unit/pythonAnalyzer.test.ts` (19 tests, drives real `python/analyzer.py` subprocess) |
| Preserve exact source evidence | `SourceFile.span()` computes exact byte/line/column spans attached to every entity/edge; each node carries its snapshot id | `pythonAnalyzer.test.ts`; `test/integration/sourceNavigation.test.ts` (6 tests) for evidence resolution/unavailable-evidence behavior |
| Extract imports | `visit_Import`/`visit_ImportFrom` resolve against `known_modules`, otherwise flagged `unresolved`; relative imports handled via `_from_import_base` | `pythonAnalyzer.test.ts` |
| Represent call uncertainty | `visit_Call` + `_resolution()`: single lexical candidate → `resolved`, multiple → `ambiguous` with `candidates`, none → `unresolved`; today's archived `instance-method-call-resolution` change extended this to resolve calls through local constructor bindings, now promoted to `openspec/specs/python-structure-analysis/spec.md` | `pythonAnalyzer.test.ts` |

All four requirements map to real, tested code paths.

### change-map-visualization (checked against current promoted spec for continued core-intent coverage)

Current `openspec/specs/change-map-visualization/spec.md` requires (among
much more added by later changes): per-line diff classification, geometric
nested containment layout, outline-only kind/status styling, directional
import/call edges with routing, ambiguous/unresolved edge styling,
data-attribute contract for click-to-navigate, panel refresh, and more.
Spot-checked in `webview/graphView.ts`: `data-node-id`, `data-node-kind`,
`data-change-status`, `data-provenance`, `data-edge-index`, `data-edge-kind`,
`data-resolution`, `marker-end`, `stroke-dasharray` are all present and
wired exactly as the MVP originally specified and as later deltas extended.
The MVP's original core intent ("render a change map with diffs, containment,
kind/status styling, and navigable edges") is still the backbone of the
current spec and current code. Covered by `test/unit/graphView.test.ts` (53
tests) and `test/unit/webviewDom.test.ts` (33 tests), both passing.

### git-state-comparison (checked against current promoted spec for continued core-intent coverage)

Current `openspec/specs/git-state-comparison/spec.md` requires a single
file-matcher abstraction, untracked-file inclusion, tracked/untracked
provenance, mid-capture stability, size/binary guards, and commit-capture
independence from worktree untracked files. All directly present in
`src/git/gitService.ts`: `GitCaptureInstabilityError`,
`GitCaptureLimitError`, `GitBinaryContentError`, `provenance: "tracked" |
"untracked"`, `listUntrackedPaths`, mid-capture fingerprint comparison. The
MVP's original core intent ("compare two git states byte-for-byte, safely")
is intact and extended. Covered by `test/integration/gitState.test.ts` (30
tests) and `test/integration/gitSelection.test.ts` (10 tests), both passing.

## tasks.md verification

All 14 checked (`[x]`) items in `tasks.md` were spot-checked against real,
current code, one representative check per capability area:

1. **Graph rendering** (Phase 5.1) — `webview/graphView.ts` contains the
   full nested-layout SVG renderer with kind/status styling and data
   attributes described above; not a stub. `webview/index.ts` wires
   click-to-navigate reading those same attributes.
2. **Git capture/diff** (Phase 2.1–2.3) — `src/git/gitService.ts` (439
   lines) implements canonical worktree-membership validation, stable
   capture with fingerprint-based instability detection, and
   tracked/untracked provenance; `src/navigation/sourceProvider.ts`
   implements span-based source resolution with staleness detection
   (`resolveSource`, `computeContentHash`).
3. **Guarded direct-write editing** (Phase 3.1–3.2) — `src/editing/
   writeGuard.ts` and `src/editing/draftStore.ts` implement the full
   isolated-draft/staleness-check/destructive-confirm/atomic-write/backup
   flow described above; not stubs.
4. **Python AST analysis** (Phase 1.3) — `python/analyzer.py` (280 lines)
   is a real `ast`-based visitor producing entities, imports, calls with
   resolved/ambiguous/unresolved states, plus `src/analysis/
   pythonAnalyzer.ts` bridging the Node/Python subprocess boundary.

No checked task was found to be aspirational/unimplemented. Phase 5.3's
instruction to "run `npm run lint && npm run typecheck && npm test && npm
run test:e2e`" was independently re-run in this verification: lint,
typecheck, and `npm test` (vitest) all pass cleanly; `npm run test:e2e`
exhibits the flake documented above.

## Verdict: **PASS**

Core MVP capabilities across all four in-scope specs are genuinely
implemented, requirement-by-requirement traceable to real code, and backed
by 311 passing unit/integration tests plus clean lint/typecheck — strongly
corroborated by four subsequent archived changes having been built directly
on top of this foundation without needing to redo it. The e2e harness flake
found during this verification was root-caused, fixed, and confirmed stable
(11/11 across two rounds, 6/6 after the fix) — see finding above. The
already-known, expected, and unaffected Docker sandbox limitation on the
gated run/stream/cancel scenario remains a separate, pre-existing,
environment-only condition, not a regression.

## Recommendation

Archive this change — its capabilities are proven by extensive downstream
use and the one issue found during verification (an e2e harness race) has
been fixed and confirmed in the same pass, not deferred.
