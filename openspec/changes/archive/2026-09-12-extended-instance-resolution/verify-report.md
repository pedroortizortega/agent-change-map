# Verify Report: extended-instance-resolution

**Change**: `extended-instance-resolution`
**Mode**: Hybrid (OpenSpec files + Engram)
**Verified against**: `feat/agent-change-map-mvp`, fast-forwarded past PR #45's merge (commit `95c3bfa`) — authoritative post-merge state, all 3 slices present.
**Verified at**: 2026-09-12

> **SUPERSEDES** the prior verify-report (Engram `sdd/extended-instance-resolution/verify-report`, observation #760), which returned **FAIL** because Section 3 (chained/returned-call resolution) was entirely unimplemented. That gap has been closed by PR #45. This is a fresh, complete re-verification of the whole change (slices 1, 2, and 3), not a delta.

## Overall Verdict: **PASS**

All three slices (annotations, `self.attr`, chained/returned calls) are implemented, tested, and spec-compliant. Full suite green, typecheck clean, lint clean. No CRITICAL issues. Two pre-existing/minor WARNINGs (task-checkbox hygiene for Sections 0–2; a stale TODO.md rationale sentence) and one SUGGESTION carried forward.

## Task Completion (`tasks.md`)

| Section | Tasks | Checkbox state | Actual code state |
|---|---|---|---|
| 0 — Setup | 1 | unchecked (`[ ]`) | done — tracker branch existed, all 3 PRs based off it / its descendants |
| 1 — Annotations (PR 1, #29) | 10 | unchecked (`[ ]`) | **done** — verified in source and tests |
| 2 — `self.attr` (PR 2, #30) | 15 | unchecked (`[ ]`) | **done** — verified in source and tests |
| 3 — Chained/returned (PR 3, #45) | 20 | **checked (`[x]`)** | **done** — verified in source and tests |

Spot-checks re-confirmed for slices 1–2 (not just trusted from the prior report), independent of slice 3's addition:
- `visit_AnnAssign` (analyzer.py:241-245) binds `x: ClassName` via `_bind_target`, with the mandatory unconditional `generic_visit` call outside the `if` (preserves the RHS constructor-call edge for `x: T = Route()`). Confirmed present.
- `_bind_signature` (analyzer.py:175-193) binds parameter annotations from `posonlyargs+args+kwonlyargs` only, called before `add_definition` in both `visit_FunctionDef`/`visit_AsyncFunctionDef`. Confirmed present, ordering unchanged.
- `self_scopes` gating (`stack[-1][2]=="class"`, first param literally `self`, no bare `staticmethod`/`classmethod` decorator) at analyzer.py:179-181. Confirmed unchanged by slice 3's edits.
- `attribute_bindings`/`attribute_classes` (N1/N2 guards) at analyzer.py:238-239, 330-336. Confirmed still a separate map from `variable_classes`/`local_bindings`, single-step class derivation (`scope.rpartition('.')[0]`), not an outward walk.
- Test 132 (`"leaves unsupported instance-binding shapes unresolved"`) reflects **both** edits (line 11 removed by PR #30, line 14 removed by PR #45): final asserted-unresolved list is exactly `[18, 23, 27]` — confirmed by reading `test/unit/pythonAnalyzer.test.ts:139-145` directly.

**Nothing regressed in slices 1–2 when slice 3 landed on top.**

### Persisting hygiene defect (carried forward from prior FAIL report, not a new regression)

Sections 0–2's checkboxes in `tasks.md` remain unchecked (`[ ]`) even though their work is objectively complete and merged. This predates PR #45 — PRs #29/#30 never touched `tasks.md` (confirmed via `git show <merge-commit> --stat` for both: `analyzer.py` + test file only, no `tasks.md`). PR #45's single commit (`9374fb1`) DID update `tasks.md`, but only its own Section 3 lines (checked `git diff`: 40 changed lines in `tasks.md`, all within Section 3's block). Sections 0–2 were never retroactively checked. **WARNING**, not CRITICAL — this is a tracking-artifact defect, independent of code correctness, and was already flagged (and left unresolved) in the prior verify pass. Recommend the archive step normalize these checkboxes for artifact hygiene before closing the change.

## Test Suite

- `npx vitest run`: **481/481 passed**, 30/30 test files passed. Independently re-run in this session (not just trusted from apply-progress).
- `test/unit/pythonAnalyzer.test.ts`: **47/47 passed** (37 pre-slice-3 baseline + 10 new: tests 13, 14, 15, 15b, 16, 17, 18, 19, 20, 21). Confirmed by name-grepping the file — all 10 new `it(...)` blocks present and match the design's case list.
- `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit`): **exit 0**, no output.
- `npm run lint` (`eslint src test webview --max-warnings=0`): **exit 0**, no output.
- Test 19 (`"terminates on mutually recursive returns with no base case"`) timed in isolation: **27ms**, far under the mandated 5000ms bound.

## Spec Compliance Matrix (`specs/python-structure-analysis/spec.md`, requirement "Represent call uncertainty" — 18 scenarios)

| # | Scenario | Slice | Status | Covering test |
|---|---|---|---|---|
| 1 | Resolve a direct call | pre-existing | PASS | `resolves direct calls only through Python lexical scopes` |
| 2 | Analyze a dynamic call | pre-existing | PASS | existing ambiguous/unresolved coverage |
| 3 | Resolve a call through a locally constructed instance | pre-existing | PASS | `resolves a call through a locally constructed instance variable` |
| 4 | Instance variable reassigned to different classes across branches | pre-existing | PASS | `reports ambiguous candidates when an instance variable is reassigned across branches` |
| 5 | Instance call to an unresolvable constructor class | pre-existing | PASS | `leaves instance calls unresolved when the constructor class is unknown` |
| 6 | Instance call with no matching method on the resolved class | pre-existing | PASS | `leaves instance calls unresolved when the bound class has no matching method` |
| 7 | Call through a variable bound from a non-constructor expression remains unresolved | pre-existing | PASS | `leaves unsupported instance-binding shapes unresolved` |
| 8 | Resolve a call through an annotated variable | Slice 1 | PASS | `resolves a call through a bare annotated variable`, `...with an assigned value` |
| 9 | Resolve a call through an annotated function parameter | Slice 1 | PASS | `resolves a call through an annotated function parameter` |
| 10 | Annotation naming an unresolvable or quoted/generic class remains unresolved | Slice 1 | PASS | `leaves quoted, generic, and unknown annotations unresolved` |
| 11 | Resolve a call through a class-scoped self-attribute binding | Slice 2 | PASS | `resolves a self-attribute call assigned in another method of the same class`, `...bound by an attribute annotation` |
| 12 | Self-attribute bound to different classes resolves as ambiguous | Slice 2 | PASS | `reports ambiguous candidates for a self-attribute bound to different classes` |
| 13 | Non-`self`-named receiver parameter is not treated as a self-attribute binding | Slice 2 | PASS | `leaves attribute calls unresolved for a receiver not named self` |
| 14 | Resolve a chained call through an explicit return-type annotation | **Slice 3** | **PASS** | `resolves a chained call through an explicit return annotation` |
| 15 | Resolve a chained call through an inferred return-body class | **Slice 3** | **PASS** | `resolves a chained call through an inferred constructor return` |
| 16 | Resolve a chained call through a returned local variable | **Slice 3 (N10 amendment)** | **PASS** | `resolves a chained call through a returned local variable` (test 15b) |
| 17 | Chained call with multiple return types resolves as ambiguous | **Slice 3** | **PASS** | `reports ambiguous candidates for a function returning different classes` |
| 18 | Chained call with no discernible return type resolves as unresolved without crashing or looping | **Slice 3** | **PASS** | `leaves chained calls unresolved for undecidable return expressions`, `terminates on mutually recursive returns with no base case` |

All 18 scenarios: **PASS**. (Note: the spec text also implicitly covers "returned self attribute" via scenario 15's inferred-return-body wording; covered by test `resolves a chained call through a returned self attribute`.)

## Requested Re-Derivations (hand-verified, not trusted from apply-progress narrative)

1. **`_own_returns` N5 guard** (analyzer.py:252-263): traversal is seeded from `node.body`, and any `ast.FunctionDef`/`ast.AsyncFunctionDef`/`ast.ClassDef`/`ast.Lambda` encountered is explicitly `continue`d — never expanded via `ast.iter_child_nodes`, so a nested definition's own `return`s are never collected. **Confirmed by direct code read AND an ad hoc scratch run**: `outer()` containing `def inner(): return Route()` and its own `return 1`, called as `outer().go()`, resolves `unresolved` (verified via a one-off `python3 python/analyzer.py` invocation in this session) — proving the nested `Route()` return is correctly NOT misattributed to `outer`.
2. **Cycle guard bound**: line 362 reads exactly `for _ in range(len(return_dependencies) + 1):`, with monotone `_extend` accumulation and an early `break` when a full pass makes no change (lines 363-371). This is a hard structural cap independent of the inner accumulation logic's correctness — confirmed by direct read, matching task 3.5's mandated code shape exactly.
   - Re-examined the apply-progress honest caveat (test 19 could not be empirically forced to hang without the `range()` bound for its specific fixture): this is **accurate and not concerning**. The inner loop's `changed`-flag early-break, on its own, is already guaranteed to terminate for any finite domain (each pass either adds at least one new class-name-per-scope pair, strictly bounded by `|scopes| x |classes|`, or the loop breaks) — so mutual recursion with zero resolvable classes anywhere (test 19's fixture: `a()`/`b()` never bottom out in a constructor call) reaches a no-op fixed point on the very first pass regardless of the outer `range` cap. The `range()` bound is a genuine second, independent, structural safety net for hypothetically pathological cases (not provably reachable by this exact fixture) — exactly as the design intended it to be described (belt-and-suspenders, not "this is the only thing preventing a hang"). No gap; the characterization is honest and correct.
3. **`return_locals` is a genuine fourth, separate list**: analyzer.py:69 declares it independently (`self.return_locals: list[tuple[str, str]] = []`), populated by its own `elif isinstance(statement.value, ast.Name): self.return_locals.append(...)` branch at line 192-193 (distinct from `return_names`'s `ast.Call`-branch at 188-189 and `return_attributes`'s `ast.Attribute`-branch at 190-191), and folded separately at analyzer.py:357-360 by reading `variable_classes.get(f"{scope}.{var}", [])` — NOT `_class_names`, and NOT merged into `return_names`. Confirmed genuinely separate, per the N10 amendment.
4. **N8 aliasing-hazard comment**: present verbatim in the `Call`-receiver resolution arm at analyzer.py:386-392, explaining that the first two arms rebind `class_names` to a fold's stored list reference while the third arm mutates a fresh list, and warning against ever adding a shared-list mutation after the first two arms. Confirmed present exactly where task 3.6 requires it.
5. **Test 15's fixture reasoning**: re-examined the actual resolution branch's `isinstance` checks (analyzer.py:378-395). The `Call`-receiver arm (`elif isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name)`) is reached only when the call's receiver expression is itself a call (e.g. `get_route()`); a direct `self.attr.method()` receiver is an `ast.Attribute`, which is caught earlier by the second arm (`self.attr`, slice 2's own machinery) and never reaches the `Call` arm at all. The apply agent's claim — that a naive fixture written as a direct `self.attr.method()` call would not exercise the new slice-3 return-inference path — is **technically accurate**. The actual test 15 fixture (`test/unit/pythonAnalyzer.test.ts:269-274`) instead calls `get_route().go()` at class-body scope, where `get_route` returns `self.route`; this correctly routes through `return_attributes` → `attribute_classes` → `function_return_classes` → the `Call`-receiver arm's `_lexical_candidates`/`function_return_classes` lookup — genuinely exercising the new slice-3 machinery, not merely re-testing slice 2. **This is a sound design-fixture deviation, not a cover for a gap.**
6. **Test 19 timing**: re-run in isolation this session — **27ms**, well under the mandated `< 5000ms` bound.

## Test 132 Final State

`"leaves unsupported instance-binding shapes unresolved"` (`test/unit/pythonAnalyzer.test.ts:139-145`): asserted-unresolved list is exactly `[18, 23, 27]` — confirmed by direct read. Matches both slice-2's removal of line 11 and slice-3's removal of line 14; nothing double-removed or missed.

## PR Chain Integrity

| PR | Title | Base | Head | Additions | Deletions | State | Merged At |
|---|---|---|---|---|---|---|---|
| #29 | feat(analyzer): resolve instance method calls through type annotations | `feat/extended-instance-resolution` | `feat/extended-instance-resolution-annotations` | 87 | 11 | MERGED | 2026-09-12T06:29:16Z |
| #30 | feat(analyzer): resolve self.attr instance calls across methods of the same class | `feat/extended-instance-resolution` | `feat/extended-instance-resolution-self-attr` | 74 | 6 | MERGED | 2026-09-12T06:29:31Z |
| #45 | feat(analyzer): resolve chained and returned instance calls | `feat/agent-change-map-mvp` | `feat/extended-instance-resolution-chained-calls` | 173 | 21 | MERGED | 2026-09-12T06:55:55Z |

All 3 PRs confirmed **MERGED** via `gh pr view --json`.

Independently recomputed line diffs (not trusted from PR bodies):
- PR #29: `git diff --shortstat 9b721f2 830ed6d` → `2 files changed, 87 insertions(+), 11 deletions(-)` — **exact match** to `gh`'s reported 87/11.
- PR #30: `git diff --shortstat 830ed6d 945348b` → `2 files changed, 74 insertions(+), 6 deletions(-)` — **exact match** to `gh`'s reported 74/6.
- PR #45: single-commit PR (`9374fb1`); `git show 9374fb1 --stat` → `3 files changed, 173 insertions(+), 21 deletions(-)` (`tasks.md` +19/-21, `analyzer.py` +73/-0, `test/unit/pythonAnalyzer.test.ts` +81/-0) — **exact match** to `gh`'s reported 173/21. (A raw `git diff --shortstat 945348b 95c3bfa` shows 6550 lines across 66 files because unrelated later work — the `extended-snippet-draft-3b` change and others — landed on `main` between PR #30 and PR #45; that range is not PR #45's actual diff. Using the single-commit diff avoids this false signal.)

No discrepancies found in any of the three PRs' reported vs. actual line counts. All three PRs individually stay well within the 400-line review-workload budget.

## `super()` Gap — Confirmed Still Open, Not Silently Claimed Fixed

`TODO.md` still lists: *"`super()` calls (`super().method()`) always resolve as `unresolved` ... has no case for an `ast.Call` receiver, only `ast.Name` and `self.attr`."*

Re-verified empirically this session: a synthetic `super().go()` call still resolves `{"kind": "unresolved"}` after all 3 slices (confirmed via direct `python/analyzer.py` invocation). The **conclusion** (super() stays unresolved) remains fully accurate and correctly tracked as an open gap — this change does not fix it and never claimed to.

**SUGGESTION (minor, non-blocking)**: TODO.md's stated *rationale* is now stale wording — slice 3 added a genuine `ast.Call`-receiver arm (analyzer.py:385), so "only `ast.Name` and `self.attr`" is no longer literally true of the branch shape. The conclusion still holds because `super` is a builtin, not a resolvable class/function symbol via `_lexical_candidates`, so the new `Call` arm's lookup correctly yields nothing. Recommend updating TODO.md's explanation (not its verdict) in a follow-up docs touch — not a blocker for this change's archive.

## Discrepancies Found

1. **WARNING (carried forward, not new)** — `tasks.md` Sections 0–2 (26 tasks) remain unchecked despite being objectively complete; only Section 3 was checked off, by PR #45's own commit. Recommend normalizing before/during archive.
2. **SUGGESTION** — TODO.md's `super()` entry has a stale rationale sentence (see above); verdict is still correct.
3. **INFO** — Slice 3's actual changed-lines (194 total: 73 analyzer.py + 81 test + 40 tasks.md) exceeds the design's ~118-123 forecast (which excluded tasks.md updates); still well within the 400-line PR budget, no action needed.

No CRITICAL issues found in this pass.

## Recommendation

**Ready for `sdd-archive`.** All three slices are implemented, all 18 spec scenarios pass with covering runtime tests, the full suite (481/481), typecheck, and lint are clean, and no code-level regressions were found across slices 1–3. The lone carried-forward WARNING (tasks.md checkbox hygiene for Sections 0–2) and the TODO.md wording SUGGESTION are both cosmetic/documentation items that do not block archival; recommend folding a normalization touch into the archive step.
