# Tasks: Extended Instance Method Call Resolution

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice 1 ~65 / Slice 2 ~59 / Slice 3 ~118-123 (design's ~108 + ~10-15 for `return_locals`/its fold loop/its test) / Aggregate ~242-247 |
| 400-line budget risk | Low per slice, Medium if merged into one PR |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Slice 1: Annotations) → PR 2 (Slice 2: self.attr) → PR 3 (Slice 3: Chained/returned, incl. N10 amendment) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No (design already settled chaining per §"PR slicing recommendation"; cached under ask-on-risk preflight)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Low per slice, Medium if merged into one PR

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Annotation-derived bindings (`AnnAssign`, param annotations) resolve | PR 1 (base: `feat/extended-instance-resolution`) | `npm test -- pythonAnalyzer -t "annotat"` | N/A — pure AST unit tests via `test/unit/pythonAnalyzer.test.ts`'s `analyze()`/`callAt()` harness, no live subprocess scenario needed | Revert PR 1; slices 2-3 do not exist yet, no other file depends on `_bind_target`/`_class_names` outside `python/analyzer.py` |
| 2 | `self.attr` cross-method class-scoped bindings resolve | PR 2 (base: PR 1's branch) | `npm test -- pythonAnalyzer -t "self-attribute"` | N/A — same synthetic-source unit harness | Revert PR 2 only; PR 1's annotation behavior stands alone, restores `self.attr` to `unresolved` |
| 3 | Chained/returned-call resolution (annotation + body inference incl. `return local_var`) resolves | PR 3 (base: PR 2's branch) | `npm test -- pythonAnalyzer -t "chained"` plus the explicit cycle-guard test (test 19) | N/A — synthetic-source unit harness; test 19 embeds its own 5s wall-clock guard as the closest thing to a runtime harness here | Revert PR 3 only; PRs 1-2 stand alone, restores chained/returned calls to `unresolved` |

---

## Section 0: Setup

- [ ] 0.1 Create tracker branch `feat/extended-instance-resolution` off `feat/agent-change-map-mvp`.

## Section 1 (PR 1, base: tracker) — Slice 1: Annotations

Spec link: "Resolve a call through an annotated variable", "Resolve a call through an annotated function parameter", "Annotation naming an unresolvable or quoted/generic class remains unresolved" scenarios.

- [ ] 1.1 Extract `_class_names`/`_extend` (design §"Architecture") from the current `variable_classes` fold, verbatim body lift from lines 193-199. Behavior-preserving — same treatment as the prior change's `_lexical_candidates` extraction. Write a regression test first proving current constructor-binding resolution (`x = ClassName()` / `x.method()`) is unchanged before the extraction, confirm it still passes after.
- [ ] 1.2 Extract `_bind_target` router from `visit_Assign` (design §1.2), preserving only the existing `if isinstance(target, ast.Name)` branch — no `elif` yet, that arrives in PR 2. Confirm existing constructor-binding tests unaffected.
- [ ] 1.3 RED — write test 1 `"resolves a call through a bare annotated variable"` (design §"Slice 1 — new cases", case 1). Confirm it fails.
- [ ] 1.4 RED — write test 2 `"resolves a call through an annotated variable with an assigned value"` (case 2), asserting both the annotation-driven resolution AND that the RHS constructor call edge still exists. Confirm it fails.
- [ ] 1.5 RED — write test 3 `"resolves a call through an annotated function parameter"` (case 3). Confirm it fails.
- [ ] 1.6 RED — write test 4 `"leaves quoted, generic, and unknown annotations unresolved"` (case 4). Confirm it fails.
- [ ] 1.7 RED — write test 5 `"does not bind starred or keyword-collector parameter annotations"` (case 5). Confirm it fails.
- [ ] 1.8 GREEN — implement §1.1-1.3 in full: `visit_AnnAssign` (design's exact code block, §1.1) with the **mandatory unconditional `generic_visit`** call outside the `if` — omitting it silently drops the RHS call edge of `x: T = Route()` (N7, the D7 trap recurring verbatim); `_bind_signature` for parameter annotations (design's exact code block, §1.3), binding `posonlyargs + args + kwonlyargs` only (excluding `vararg`/`kwarg` per E4/N4, excluding the receiver `self` per E5), called BEFORE `add_definition` in both `visit_FunctionDef` and `visit_AsyncFunctionDef` — ordering is load-bearing (§1.3) so `self.current_qualified_name` is still the enclosing scope. Zero fold changes beyond substituting `_class_names` (§1.4).
- [ ] 1.9 REFACTOR — confirm tests 1-5 plus the 1.1 regression test all green; confirm full existing suite unaffected.
- [ ] 1.10 Final gate: lint + typecheck + full `test/unit/pythonAnalyzer.test.ts` suite green before opening PR 1.

## Section 2 (PR 2, base: PR 1's branch) — Slice 2: self.attr

Spec link: "Resolve a call through a class-scoped self-attribute binding", "Self-attribute bound to different classes resolves as ambiguous", "Non-`self`-named receiver parameter is not treated as a self-attribute binding" scenarios.

- [ ] 2.1 Add `self_scopes: set[str]` and bare `staticmethod`/`classmethod` decorator-name detection (design §2.1) inside `_bind_signature`, gated on `stack[-1][2] == "class"`, first-param literally `self`, and no matching bare decorator name (E8/N12 — dotted/aliased decorators are an accepted, documented gap, not detected).
- [ ] 2.2 Add `attribute_bindings: list[tuple[str, str, str]]` visitor state and `_bind_target`'s new `elif` branch (design §1.2/§2.1 code) routing `self.attr = ClassName(...)` into `attribute_bindings`, gated on `target.value.id == "self"` and `current_qualified_name in self_scopes`. Explicitly NOT `local_bindings` — call out N1: folding into `variable_classes` would collide a class-body assignment's key (`class A: x = Route()`) with a same-named `self.x = Other()` binding, producing a false `ambiguous`.
- [ ] 2.3 Add the `attribute_classes` fold (design §2.3 code), keyed `f"{scope.rpartition('.')[0]}.{attribute}"` — explicitly call out E6/N2: this is a single-step derivation off `self_scopes` membership, NOT an outward walk; an outward walk false-positives on a nested function's own `self` inside a method (design §2.2 example).
- [ ] 2.4 Add the resolution branch's new `self.attr` `elif` (design's combined branch, the `receiver: Attribute over self.attr` arm only — the `Call` arm arrives in PR 3). Widen `isinstance(call.func, ast.Attribute)` per the full branch shape but implement only the `Name` and `self.attr` receiver arms this PR.
- [ ] 2.5 **MANDATORY** — edit the existing test `"leaves unsupported instance-binding shapes unresolved"` (`test/unit/pythonAnalyzer.test.ts:132`): remove line `11` from the asserted-unresolved list, since slice 2 makes `self.route.get_info()` resolved (N3). Keep `[14, 18, 23, 27]` intact — line 14 stays until slice 3.
- [ ] 2.6 RED — write test 6 `"resolves a self-attribute call assigned in another method of the same class"` (design §"Slice 2 — new cases", case 6). Confirm it fails.
- [ ] 2.7 RED — write test 7 `"resolves a self-attribute call bound by an attribute annotation"` (case 7). Confirm it fails.
- [ ] 2.8 RED — write test 8 `"reports ambiguous candidates for a self-attribute bound to different classes"` (case 8). Confirm it fails.
- [ ] 2.9 RED — write test 9 `"keeps a self-attribute assigned the same class in two methods resolved"` (case 9, the D5-equivalent dedup guard). Confirm it fails.
- [ ] 2.10 RED — write test 10 `"leaves attribute calls unresolved for a receiver not named self"` (case 10). Confirm it fails.
- [ ] 2.11 RED — write test 11 `"leaves self-attribute calls unresolved in staticmethods and nested functions"` (case 11, the N2 guard). Confirm it fails.
- [ ] 2.12 RED — write test 12 `"does not merge a class-body variable with a same-named self attribute"` (case 12, the N1 collision guard). Confirm it fails.
- [ ] 2.13 GREEN — implement 2.1-2.4 in full per design's exact code blocks. Confirm tests 6-12 pass.
- [ ] 2.14 REFACTOR — confirm all slice 1 + slice 2 tests plus the edited test 132 green; confirm full existing suite unaffected.
- [ ] 2.15 Final gate: lint + typecheck + full `test/unit/pythonAnalyzer.test.ts` suite green before opening PR 2.

## Section 3 (PR 3, base: PR 2's branch) — Slice 3: Chained/returned calls (including the N10 amendment)

Spec link: "Resolve a chained call through an explicit return-type annotation", "Resolve a chained call through an inferred return-body class", "Resolve a chained call through a returned local variable" (N10 amendment), "Chained call with multiple return types resolves as ambiguous", "Chained call with no discernible return type resolves as unresolved without crashing or looping".

- [x] 3.1 Add `_own_returns` bounded traversal (design §3.3 exact code), seeded from `node.body`, explicitly excluding descent into nested `FunctionDef`/`AsyncFunctionDef`/`ClassDef`/`Lambda`. Call out N5 explicitly: naive `ast.walk` would misattribute a nested definition's own `return` statements to the outer function — the direct analogue of the prior change's `generic_visit` trap in a different guise.
- [x] 3.2 Add `_bind_signature`'s return-collection block (design §3.2 exact code): `return_annotations`, `return_names`, `return_attributes`, AND `return_locals` — all four, not three (the N10 amendment adds `return_locals`, collected via its own `elif isinstance(statement.value, ast.Name)` branch, kept as a separate list from `return_names`/`return_attributes` because it resolves through `variable_classes`, not `_class_names`).
- [x] 3.3 Add the `function_return_classes` + `return_dependencies` folds in the exact order design §3.4 specifies: `variable_classes` → `attribute_classes` → `function_return_classes`, with the `return_locals` loop reading `variable_classes` at key `f"{scope}.{var}"` — no new fold-order edge per the amendment (§3.4 "Ordering, unaffected").
- [x] 3.4 Implement the annotation-precedence rule (E11/N6): when `node.returns` is a present `ast.Name`, skip body inference entirely for that scope (`annotated_returns` set gate) — union would falsely report `ambiguous` for `def f() -> Base: return Derived()`.
- [x] 3.5 Implement the fixed-point cycle guard exactly per design §3.5: `for _ in range(len(return_dependencies) + 1)`, monotone accumulation via `_extend`, early `break` on no change. Task must reference both termination proofs in the commit/PR description: (1) monotonicity — pairs only added, never removed, bounded by `|scopes| x |classes|`; (2) structural bound — `range(len(return_dependencies) + 1)` caps the loop unconditionally regardless of inner-logic correctness.
- [x] 3.6 Add the resolution branch's final `Call`-receiver `elif` (design "The full combined resolution branch" exact code), completing the three-arm branch (`Name` / `self.attr` / `Call`). Add an inline code comment documenting the N8 aliasing hazard — `class_names` is a reference into a fold's stored list in the first two arms but a fresh list mutated by the third; branches are mutually exclusive today, but any future `_extend` after the first two arms would corrupt shared fold state across call sites. This is a required inline comment, not only a design-doc footnote.
- [x] 3.7 **MANDATORY** — edit `"leaves unsupported instance-binding shapes unresolved"` (`test/unit/pythonAnalyzer.test.ts:132`) a SECOND time: remove line `14` too, since slice 3 makes `factory().get_info()`-shaped calls resolved via body inference. Final asserted-unresolved list: `[18, 23, 27]`.
- [x] 3.8 RED — write test 13 `"resolves a chained call through an explicit return annotation"` (design §"Slice 3 — new cases", case 13). Confirm it fails.
- [x] 3.9 RED — write test 14 `"resolves a chained call through an inferred constructor return"` (case 14). Confirm it fails.
- [x] 3.10 RED — write test 15 `"resolves a chained call through a returned self attribute"` (case 15). Confirm it fails.
- [x] 3.11 RED — write test 15b `"resolves a chained call through a returned local variable"` (the N10 amendment case, spec scenario "Resolve a chained call through a returned local variable"). Do not skip — confirmed in-scope. Confirm it fails.
- [x] 3.12 RED — write test 16 `"reports ambiguous candidates for a function returning different classes"` (case 16). Confirm it fails.
- [x] 3.13 RED — write test 17 `"prefers an explicit return annotation over an inferred return body"` (case 17, the N6 guard). Confirm it fails.
- [x] 3.14 RED — write test 18 `"ignores returns owned by a nested definition"` (case 18, the N5/`_own_returns` guard). Confirm it fails.
- [x] 3.15 RED — write test 19 `"terminates on mutually recursive returns with no base case"` (design's exact TS snippet, case 19 — the cycle-guard/termination test). Given its correctness-criticality per the design's own emphasis, this task must copy the wall-clock `< 5000ms` assertion and the `callAt(11)` unresolved assertion verbatim. Confirm it fails before the guard exists (or times out/hangs without it — do not run against unguarded code beyond a bounded attempt).
- [x] 3.16 RED — write test 20 `"propagates a return class through a chain of forwarding functions"` (case 20 — the fixed point's positive/forwarding-chain case). Given its correctness-criticality, verify it exercises the 3-deep chain (`c` → `b` → `a`) exactly as specified. Confirm it fails.
- [x] 3.17 RED — write test 21 `"leaves chained calls unresolved for undecidable return expressions"` (case 21). Confirm it fails.
- [x] 3.18 GREEN — implement 3.1-3.6 in full per design's exact code blocks. Confirm tests 13, 14, 15, 15b, 16, 17, 18, 19, 20, 21 all pass.
- [x] 3.19 REFACTOR — confirm all slice 1 + slice 2 + slice 3 tests plus both edits to test 132 green; confirm full existing suite unaffected; confirm `_resolution()` remains unmodified (E14).
- [x] 3.20 Final gate: lint + typecheck + full `test/unit/pythonAnalyzer.test.ts` suite green before opening PR 3.
