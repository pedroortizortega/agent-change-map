# Exploration: extended-instance-resolution

## Current State

`python/analyzer.py` (281 lines, read in full) implements a 3-stage pipeline established by the prior `instance-method-call-resolution` change:

1. **Per-file AST walk** (`FileVisitor`): `visit_Assign` matches only `Assign(targets=[Name], value=Call(func=Name))` and appends `(scope, var, ClassName)` to `self.local_bindings`. No `visit_AnnAssign`, no `visit_arg`/annotation handling, no attribute-target (`self.x = ...`) handling, no return-type inference exists anywhere in the file.
2. **Global fold in `analyze()`**: `variable_classes: dict[str, list[str]]` keyed `f"{scope}.{var}"` → list of qualified class names, built by resolving each raw constructor name through `_lexical_candidates` and filtering to `class:`-prefixed ids.
3. **Resolution pass**: `elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name): candidates = variable_classes.get(...)`; unions candidates across bound classes and calls `_resolution()`.

Key mechanics confirmed by full read:
- `_lexical_candidates(name, scope, module, symbols, aliases)` walks outward, explicitly **skipping over** a scope if it is `class:`-prefixed. This is reusable machinery for detecting "this scope is a class", but it currently walks PAST class scopes rather than STOPPING at them — case 2 needs the opposite.
- **No existing special-casing of the `self` parameter name anywhere** in the file. Any `self`-awareness for case 2 is new.
- `_resolution(candidates)` is confirmed reusable as-is for all three new cases — no new ambiguity logic needed.
- The scope key convention `f"{scope}.{var}"` is uniform; extending it to a class-qualified key for case 2 is a key-shape change, not a new concept.

## Affected Areas

- `python/analyzer.py` — new `visit_AnnAssign`, new parameter/return-annotation handling, extended/new visitor for `self.attr =`, new fold(s) in `analyze()`, extended resolution branch.
- `test/unit/pythonAnalyzer.test.ts` — new synthetic test cases per sub-case (see real-world validation below — none of the three cases are exercised by the real fixture).
- `/home/pedro/Documentos/Projects/test/*.py` — read in full; **does not exercise any of the three new cases**.

## Investigation Findings by Case

### 1. Data structures

`variable_classes`'s shape (`dict[str, list[str]]`) is directly reusable and should be the single target structure cases 1 and 2 populate — only WHERE entries come from changes (annotation vs. constructor-call), not the shape. Case 3 (return types) is different in kind — needs a separate `function_return_classes: dict[str, list[str]]` (qualified function name → class names), consulted when `call.func.value` is itself an `ast.Call`.

### 2. Annotations (case 1)

- `ast.AnnAssign(target, annotation, value, simple)`: `value` is `None` for a bare `x: Route4` declaration — `visit_AnnAssign` must bind on the annotation alone, independent of whether a value is present.
- `ast.arg.annotation`: needs new traversal inside `visit_FunctionDef`, inspecting `node.args.args` directly (no dedicated `ast.NodeVisitor` dispatch exists for `ast.arg`).
- Annotation shapes: bare `ast.Name` (`Route4`) is trivial, reuses today's constructor-name resolution. String-quoted forward refs (`"Route4"`) and generics (`Optional[Route4]`, `Route4 | None`) are real scope creep (require re-parsing strings / unwrapping typing constructs).
- **Real fixture check**: zero custom-class type annotations anywhere in `/home/pedro/Documentos/Projects/test/*.py`. Only builtin-type annotations exist (`x: str`, `x: int`). **Scoping to bare-`Name` only, deferring quoted/generic, is honest AND validated as sufficient for this fixture** — but any validation of case 1 requires a synthetic example, not the user's own code.

### 3. `self.attr` (case 2) — the highest real-world value, but still unvalidated

- Requires cross-method binding collection: bindings must be recorded under the CLASS's qualified name (not the assigning method's), and looked up under "the enclosing class of the current call site."
- "Enclosing class" derivation needs a NEW helper — `_lexical_candidates`'s existing skip-over-class logic does the opposite of what's needed (skip vs. stop-at). Small new function, but real new logic, not pure reuse.
- `self` recognition: **no existing special-casing exists**, must be introduced. Recommendation: trust the literal parameter name `self` on a method's first positional parameter — simpler and matches 99.9%+ of real code, versus "any first param regardless of name" which adds complexity for negligible gain. Must be stated as an explicit, named heuristic in the design.
- **Real fixture check**: `route3.py`/`route4.py` assign `self.name`/`self.description` in `__init__`, but those are strings, never later called as `self.attr.method()` resolving to a user class. `app.py`'s `Main.__init__` sets `self.x`/`self.y` from env/param, not from a constructor call. **No real occurrence of `self.attr = ClassName()` followed by cross-method `self.attr.method()` exists in the fixture** — despite being described as the most compelling case, it isn't actually present in the user's reported repro either. Validation needs a synthetic example.

### 4. Chained/returned instances (case 3) — highest cost, most divergent risk

- **(a) Explicit `-> ClassName` return annotation**: cheap, reuses the same bare-`Name` annotation machinery as case 1. At the call site, when the inner `.value` is itself an `ast.Call`, resolve the inner callee's return class(es), then resolve the outer `.method()` against those. Bounded, mechanical, genuinely new control flow but small.
- **(b) Return-statement-body inference** (`return Route4(...)`, `return self.attr`): materially harder — walk every `ast.Return`, type each returned expression recursively (using cases 1+2+3's own machinery), handle recursion/cycle guards, multiple `return`s of different types (union → ambiguous), and `return` with no value or too-complex expressions (must inertly no-op). A genuinely different order of complexity — interprocedural and potentially recursive, unlike the other two which are pure structural pattern matches.
- **Real fixture check**: **no function or method anywhere in the fixture returns an instance of a project-defined class**. `ruta1`/`ruta2`/`ruta3` return `str`, `funcion2` returns `int`, `get_info` methods return `dict` literals. **Case 3 has zero real-world footprint in the reported repro at all** — neither the explicit-annotation nor body-inference slice would resolve anything in the user's actual code. This is the strongest signal from this exploration: case 3 is speculative relative to the concrete bug report, unlike the original change, which was validated against a live real repro.

### 5. Ambiguity/failure semantics

Extending `_resolution()` unchanged is directly sufficient for all three cases, as long as each case's fold funnels into the same "flat candidate list → `_resolution()`" shape:
- Unresolvable annotation class name → zero candidates → key not created → `unresolved`.
- `self.attr` bound to different classes across methods/branches → same class-qualified-name key accumulates multiple names (reuses the existing accumulation-not-replacement decision) → `ambiguous`.
- Function with multiple `return`s of different types (only relevant if body-inference is in scope) → union into `function_return_classes[fn]` → `ambiguous`.
- All three cases should state "no new ambiguity code, `_resolution()` reused as-is" as an explicit ADR, mirroring the prior design's discipline.

### 6. Real-world validation summary (all 6 fixture files read in full)

| Case | Exercised by `/home/pedro/Documentos/Projects/test/*.py`? |
|---|---|
| 1. Annotations | **No** — only builtin-type annotations exist, never custom-class |
| 2. `self.attr` | **No** — attributes assigned are strings/env values, never `ClassName()` instances |
| 3. Chained/returned | **No** — no function returns a project-class instance |

All three cases need synthetic fixtures for validation; none can be demonstrated against the user's own reported repro. This contrasts with the prior change, whose entire motivation and validation traced to two concrete unresolved calls visible in this exact fixture.

## Approaches

### 1. All three cases as one change, one PR

- Pros: single coherent design; avoids re-deriving the shared "enclosing class" helper across multiple changes.
- Cons: case 3's body-inference component is materially riskier and could bloat review of the two cheaper, more validated cases; risks exceeding this repo's 400-line PR budget; zero of the three cases are validated against the real fixture, so shipping all three together maximizes unvalidated logic landing at once.
- Effort: High.

### 2. Three sequential slices within one change (annotations → self.attr → full chained incl. body-inference)

- Pros: annotations is a genuine prerequisite building block for cases 2 and 3's "resolve a name to a class" sub-step, so sequencing it first is architecturally correct; each slice independently testable/mergeable (chained PRs).
- Cons: three PRs/reviews instead of one; still commits to delivering body-inference, the highest-risk, least-validated component.
- Effort: Medium-High aggregate.

### 3. Deliver annotations + self.attr + ONLY explicit-return-annotation chained calls now; explicitly defer return-body-inference as a follow-up

- Pros: delivers 2 of 3 cases with concrete architecture value plus the cheap half of case 3, while explicitly deferring the one component that is an order of magnitude more complex (recursive, cycle guards, multi-return union, undecidable-expression fallback) AND has zero footprint in the real fixture — no concrete validated need right now, only speculative future value. Mirrors the prior change's own explicit-deferral discipline. Keeps risk proportionate to demonstrated value.
- Cons: narrower slice of "chained calls" than the user may expect from the original framing; requires being explicit that body-inference is deferred.
- Effort: Medium.

## Recommendation

**Approach 3**, delivered as sequenced slices within one change: annotations first (cheapest, genuine prerequisite), then self.attr (real cross-method work, no interprocedural inference), then chained calls restricted to explicit `-> ClassName` return annotations only — with return-statement-body inference explicitly named as an out-of-scope, deferred follow-up, mirroring how the prior change deferred self.attr and chained calls with an honest, stated boundary.

## Risks

- **All three cases lack real-fixture validation** — every test will be synthetic, unlike the prior change's live-repro validation. Increases risk that "works in the unit test" misses a real-world shape.
- `self` heuristic (literal parameter name) is a deliberate, named simplification — must be stated explicitly, not silently assumed.
- String-quoted and generic annotations are common in real Python (especially with `from __future__ import annotations`) — deferring them is reasonable for this fixture but a real, likely-to-be-hit limitation going forward; must be flagged, not silently dropped.
- Case 2's "enclosing class" helper is genuinely new code, not a pure reuse of `_lexical_candidates`'s existing skip logic.
- If body-inference is deferred (recommended), the proposal must say so explicitly and completely, to avoid the user later assuming "chained calls" was fully delivered.

## Ready for Proposal

Yes — but three things must be surfaced to the user before writing the proposal:
1. None of the three cases are exercised by their actual `test/app.py` fixture — validation will use synthetic examples for all three.
2. The recommended scope explicitly excludes return-statement-body type inference for chained calls (case 3's harder half) as a named follow-up, not a silent gap.
3. Delivery should be three sequenced, independently-reviewable slices within this one change, per the repo's 400-line review-workload guard.
