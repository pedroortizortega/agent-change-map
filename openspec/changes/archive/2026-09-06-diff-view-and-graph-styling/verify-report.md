# Verification Report: diff-view-and-graph-styling

**Mode**: full artifacts (proposal + specs + design + tasks all present)
**Verdict**: PASS

## Completeness

- Tasks: 34/34 checked `[x]` across Phases 1-8, all match current code state.
- Both chained PRs merged into `feat/diff-view-and-graph-styling`: PR #8 (diff panel), PR #9 (graph rewrite).

## Commands run and results

| Command | Result |
|---|---|
| `npm run lint` (`eslint src test webview --max-warnings=0`) | exit 0, no output |
| `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit`) | exit 0, no errors |
| `npx vitest run test/unit test/integration` | 17 files / 138 tests, all passed |
| `npm run test:e2e` (`node scripts/vscode-harness.mjs`) | FAILS — see Finding W1 below (pre-existing, unrelated to this change) |

## Spec compliance matrix

1 MODIFIED requirement (5 scenarios) + 7 ADDED requirements (11 scenarios) — every scenario has a covering, currently-passing test:

| Requirement | Scenario | Covering test |
|---|---|---|
| Expose affected differences (MODIFIED) | Inspect a modified node | `lineDiff.test.ts` (insertion/deletion/identical cases), `webviewDom.test.ts:109` |
| " | Inspect a one-sided entity | `lineDiff.test.ts:36,44`, `webviewHost.test.ts:98`, `webviewDom.test.ts:134` |
| " | Expand a collapsed unchanged run | `webviewDom.test.ts:146` |
| " | Collapse state resets on new source pair | `webviewDom.test.ts:146` |
| " | Diff computed without a DOM | `lineDiff.test.ts` (pure module, no DOM dependency) |
| Render entities nested inside container | Nested entity inside container | `graphView.test.ts:72,128` (3-level nesting) |
| " | Orphaned node, filtered-out container | `graphView.test.ts:170` |
| Encode kind via dash/stroke-width | Container/entity/kind styling | `graphView.test.ts:185` |
| Outline-only, change-status stroke | Unchanged node styling | `graphView.test.ts:98,210` |
| " | Modified node styling | `graphView.test.ts:98` |
| Directional import/call edges | Resolved import/call edges | `graphView.test.ts:223` |
| " | Containment draws no edge | `graphView.test.ts:236` |
| Ambiguous/unresolved edges | Ambiguous call rendering | `graphView.test.ts:86,223` |
| Degrade nested layout above threshold | Layout at/above nesting threshold | `graphView.test.ts:248` |
| Preserve data-* contract | Click-to-navigate unaffected | `graphView.test.ts:268`, `webviewDom.test.ts:122` |

## Design coherence spot-checks

- `src/diff/lineDiff.ts` header carries the real jsdiff BSD-3-Clause notice verbatim (copyright, 3 conditions, full disclaimer) — not MIT, not fabricated. Confirmed by direct file read.
- `DiffOp` union in code matches design.md's interface exactly (`unchanged`/`added`/`removed` variants with the documented fields).
- `NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 }` in `webview/graphView.ts` matches design.md verbatim, independent of `OVERSIZED_THRESHOLDS` (300/600).
- `KIND_STYLE` table (`strokeWidth`/`dasharray`/`rx` for package/module/class/function/method) matches design.md's kind-encoding table exactly.
- Elbow edge formula `my = tay > say ? (say+tay)/2 : say+ELBOW_DROP` and stub formula (`STUB_LEN=28`, `stroke-dasharray="4 3"`) match design.md verbatim.
- Edge colors in `webview/styles.css`: `.edge-import`/`.arrow-import` `#4f9cf9`, `.edge-call`/`.arrow-call` `#c586c0`, `.resolution-ambiguous`/`.resolution-unresolved` `#f0883e` — all match design.md.
- `.node-box.status-*` rules use `stroke:` (not `fill:`) with `.node-box { fill: none }` present — matches design's outline-only decision.
- `git diff` of `src/protocol.ts` against the commit before `8ef83f6` is empty (zero changes) — confirms the frozen data-* contract claim.
- `git diff` of `webview/index.ts` against the same base is confined to: new imports/constants, new diff-panel helper functions, and the `sourcePair` case body. The click-to-navigate wiring (`querySelectorAll("[data-node-id]")`/`("[data-edge-index]")`, `graph.edges[index]` lookups) is untouched — confirms the "zero edits" contract claim in both PRs is true, not merely self-reported.

## Findings

**W1 (WARNING, not blocking, pre-existing)**: `npm run test:e2e` fails at the "direct save" scenario (`test/e2e/scenarios.ts` line ~168): the last received message after a confirmed direct write is a `graph` message instead of the expected `directWriteResult`, indicating a message-ordering race unrelated to this change. Verified by running the identical e2e suite against the commit immediately before this change's planning artifacts (`8ef83f6~1`, i.e. before either PR started) — the same assertion fails identically there. This is a pre-existing defect in the write/session flow, outside the scope of this change (design.md explicitly states neither slice touches the analyzer, git capture, draft/write guard, or Docker paths). Diagram/navigation-specific e2e scenarios that did run (selection, exact navigation, stale navigation refusal, draft save) all passed, including the graph message assertion this change's rendering depends on. Full `test:e2e` pass could not be independently confirmed end-to-end due to this pre-existing unrelated failure; recommend filing separately, not reopening this change.

No CRITICAL or SUGGESTION findings.

## Verdict

**PASS** (0 CRITICAL, 1 WARNING pre-existing/out-of-scope, 0 SUGGESTION). All 34 tasks complete and match code. All 16 spec scenarios have passing covering tests. Design decisions (DiffOp shape, BSD-3-Clause header, NESTED_LAYOUT_LIMITS, kind-encoding table, edge formulas/colors, frozen data-* contract) verified against actual source, no drift found.
