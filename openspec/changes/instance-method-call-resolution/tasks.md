# Tasks: Resolve Instance Method Calls

Delivery: **single PR**, per design's own recommendation (§ "PR slicing
recommendation") — the visitor (`local_bindings`), the fold (`variable_classes`),
and the resolution `elif` branch are non-functional in isolation (bindings
collected but never consumed, or a consumer with no data). Splitting would ship
dead code with no test able to prove it.

Base branch: branch this tracker off the current default/main integration
branch (`feat/agent-change-map-mvp`), following this repo's established
per-change tracker convention (e.g. `feat/graph-relationship-filtering-suppression`).
Suggested tracker name: `feat/instance-method-call-resolution`.

Strict TDD: every behavior item below is RED (write failing test, confirm it
fails) → GREEN (minimal implementation) → REFACTOR (only if needed, keeping
tests green). Do not implement ahead of a written, failing test.

All test cases and titles below are copied verbatim from design.md §4 "Test
surface" — do not invent different titles or sources. All new tests live in
`test/unit/pythonAnalyzer.test.ts` (the sole test surface per design §4
"Harness relationship"). Use the `callAt(line)` helper from design.md to select
the `.method()` edge by `span.startLine` (not by `kind === "call"`, which would
grab the constructor edge).

---

## 0. Setup

- [ ] 0.1 Confirm current branch and branch the tracker from
      `feat/agent-change-map-mvp` (or the repo's current default integration
      branch, verified via `git branch --show-current` / `git log`) as
      `feat/instance-method-call-resolution`.

---

## 1. `_lexical_candidates` extraction (behavior-preserving refactor of `_resolve_lexical`)

Spec link: design.md §2 "Decision: `_resolve_lexical` must be reused, via a
small extracted helper"; supports every scenario in
`specs/python-structure-analysis/spec.md` indirectly, since `_resolve_lexical`
backs all existing direct-call (`ast.Name`) resolution and must remain
unchanged in behavior.

- [ ] 1.1 **RED** — Add a regression test proving `_resolve_lexical`'s existing
      behavior is unchanged by the extraction. Reuse the existing test file's
      `analyze()` helper; assert a direct-name call still resolves exactly as
      before (e.g. a same-scope function call resolving to `resolved`, and an
      unresolved dynamic call — mirroring the existing `obj.dynamic()` and
      `duplicate()` assertions already in
      `test/unit/pythonAnalyzer.test.ts`). This test must be written and run
      against the **pre-extraction** code to prove it currently passes (it is a
      characterization test, not a new-behavior test — confirm it passes before
      refactoring, then confirm it still passes after). Note in the task log
      that this is a characterization/regression guard, not a RED test in the
      usual "fails first" sense, since no behavior is changing.
- [ ] 1.2 **GREEN/REFACTOR** — Extract `_lexical_candidates(name, scope, module,
      symbols, aliases) -> list[str]` from `_resolve_lexical` exactly per
      design.md §2 code block; reduce `_resolve_lexical` to
      `return _resolution(_lexical_candidates(...))`. Run the full existing
      `pythonAnalyzer.test.ts` suite plus the 1.1 regression test — all green,
      zero behavior change.

---

## 2. `visit_Assign` — bind `var = ClassName(...)` per scope

Spec link: proposal.md "Approach" step 1; design.md §1; spec.md scenario
"Resolve a call through a locally constructed instance" (binding half) and the
negative-shape scenarios ("self-attribute", "non-constructor expression",
"chained/returned-instance" — these depend on `visit_Assign`'s strict 4-condition
match rejecting them).

This section's test cases only become independently provable together with
sections 3 and 4 (design's explicit warning: visitor → fold → resolution branch
are non-functional in isolation). Tasks 2.x write the RED tests first; GREEN for
each requires 2, 3, and 4 code landing together, then each RED test is run to
confirm it passes.

- [ ] 2.1 **RED** — Add test case 1: `"resolves a call through a locally
      constructed instance variable"` (design.md §4, case 1 exact source).
      Assert `callAt(6)?.resolution` equals
      `{ kind: "resolved", target: <id of local.Route.get_info> }`. Run and
      confirm it fails (currently `unresolved`, since `ast.Attribute` calls are
      never resolved).
- [ ] 2.2 **RED** — Add test case 3: `"keeps repeated assignment of the same
      class resolved rather than ambiguous"` (dedup guard; design.md §4, case
      3 exact source). Assert `callAt(8)?.resolution.kind` is `"resolved"`. Run
      and confirm it fails.
- [ ] 2.3 **RED** — Add test case 4: `"leaves instance calls unresolved when
      the constructor class is unknown"` (design.md §4, case 4 exact source).
      Assert `callAt(3)?.resolution` equals `{ kind: "unresolved" }`. This
      already passes today by coincidence (no resolution branch exists yet) —
      run it now only to establish the pre-change baseline; re-assert after
      GREEN in 4.x that it still passes for the *correct* reason (miss in
      `variable_classes`, not "no branch exists").
- [ ] 2.4 **RED** — Add test case 5: `"leaves instance calls unresolved when
      the bound class has no matching method"` (design.md §4, case 5 exact
      source). Assert `callAt(6)?.resolution` equals `{ kind: "unresolved" }`.
      Same baseline note as 2.3.
- [ ] 2.5 **RED** — Add test case 6: `"leaves unsupported instance-binding
      shapes unresolved"` (design.md §4, case 6 exact source — covers
      `self.attr` propagation, chained/returned instances, tuple targets,
      non-constructor RHS, chained assignment). Assert all five `.get_info()`
      lines (11, 14, 18, 23, 27) resolve to `{ kind: "unresolved" }`. Baseline
      note as 2.3/2.4.
- [ ] 2.6 **RED** — Add test case 7: `"scopes instance bindings to the
      assignment's own scope"` (design.md §4, case 7 exact source). Assert
      `callAt(8)?.resolution` equals `{ kind: "unresolved" }`. Baseline note as
      2.3/2.4.
- [ ] 2.7 **GREEN** — Implement `visit_Assign` in `FileVisitor` exactly per
      design.md §1 code block: declare `self.local_bindings:
      list[tuple[str, str, str]] = []` in `__init__` immediately after
      `self.import_aliases`; add `visit_Assign` between `visit_ImportFrom`/
      `_from_import_base` and `visit_Call`, with the strict 4-condition match
      and **unconditional** `self.generic_visit(node)` (D7 — mandatory, not
      optional, per design's explicit warning that omitting it silently drops
      the constructor call edge and nested calls in any assignment RHS). Do
      not yet make tests 2.1/2.2 pass — that requires sections 3 and 4. Run the
      full suite; confirm no existing test regresses (constructor-call edges
      like `x = Route4()` unaffected) and that the 2.3–2.6 baseline tests still
      pass for the "no branch exists" reason.

---

## 3. `variable_classes` fold in `analyze()`

Spec link: design.md §2 "The fold"; proposal.md "Approach" step 2; spec.md
scenario "Instance variable reassigned to different classes across branches"
(dedup requirement, D5).

- [ ] 3.1 **RED** — Add test case 2: `"reports ambiguous candidates when an
      instance variable is reassigned across branches"` (design.md §4, case 2
      exact source). Assert `callAt(12)?.resolution` equals
      `{ kind: "ambiguous", candidates: [<local.A.go>, <local.B.go>].sort() }`.
      Run and confirm it fails.
- [ ] 3.2 **RED** — Add test case 8: `"resolves instance calls to a class
      bound by a from-import"` (design.md §4, case 8 exact source — three
      files: `pkg/__init__.py`, `pkg/routes.py`, `pkg/app.py`). Assert the
      `pkg/app.py` line-6 call edge resolves to `pkg.routes.Route4.get_info`.
      Run and confirm it fails.
- [ ] 3.3 **GREEN** — Implement the fold exactly per design.md §2: add
      `qualified_by_id: dict[str, str] = {node["id"]: node["qualifiedName"] for
      node in nodes}` after the `by_qualified_name` build; add the
      `variable_classes: dict[str, list[str]] = {}` loop as a **separate loop
      placed after** the `alias_targets` loop has fully completed (D2/(a) —
      reading a partially built alias map is a real bug class, not a style
      preference). Apply both dedup barriers exactly as specified (D5 —
      `if name not in class_names` per binding, `if name not in bound` across
      bindings) and the `class:` prefix filter (D4). Tests 3.1 and 3.2 still
      fail at this point — no consumer exists yet (section 4). Run the suite;
      confirm no regression.

---

## 4. Resolution branch for `ast.Attribute` over `ast.Name`

Spec link: design.md §3; proposal.md "Approach" step 3; spec.md scenarios
"Resolve a call through a locally constructed instance", "Instance variable
reassigned to different classes across branches", "Instance call to an
unresolvable constructor class", "Instance call with no matching method",
"Call through self-attribute access remains unresolved", "Call through a
variable bound from a non-constructor expression remains unresolved", "Chained
or returned-instance call remains unresolved".

- [ ] 4.1 **GREEN** — Add the `elif isinstance(call.func, ast.Attribute) and
      isinstance(call.func.value, ast.Name)` branch exactly per design.md §3
      code block, replacing current lines 181–186. Union semantics: one flat
      `candidates` list, extended once per bound class via
      `by_qualified_name.get(f"{class_name}.{call.func.attr}", [])`, passed
      once to `_resolution()`.
- [ ] 4.2 **GREEN (confirm)** — Re-run all RED tests from sections 2 and 3
      (cases 1–8) plus the section-1 regression guard. All must now pass:
      - case 1 (2.1) → `resolved`
      - case 2 (3.1) → `ambiguous`, both candidates sorted
      - case 3 (2.2) → `resolved` (dedup)
      - case 4 (2.3) → `unresolved`, now for the correct reason (miss in
        `variable_classes`)
      - case 5 (2.4) → `unresolved` (no matching method)
      - case 6 (2.5) → `unresolved` for all five negative shapes
      - case 7 (2.6) → `unresolved` (scope isolation, no outward walk — D8)
      - case 8 (3.2) → `resolved` to `pkg.routes.Route4.get_info` (alias +
        class-scope-skip interaction)
- [ ] 4.3 **REFACTOR** — Re-read the full diff against design.md §1–§3 code
      blocks for exact match (variable names, condition order, dedup guards,
      unconditional `generic_visit`). No behavior change expected; this is a
      structural-fidelity pass, not new logic.

---

## 5. Full verification gate

- [ ] 5.1 Run `npm run lint && npm run typecheck && npx vitest run test/unit
      test/integration`. All must be green before opening the PR. Do not open
      the PR against the tracker branch until this gate passes.
- [ ] 5.2 Confirm the existing regression guard (design.md §4 "Regression
      guard" — `obj.dynamic()` in the first test, line 17) still resolves
      `unresolved`: `obj` is never bound, so it misses `variable_classes` and
      the `ast.Name` branch also misses it; no existing assertion should have
      required a change.
- [ ] 5.3 Open the single PR against the tracker branch
      (`feat/instance-method-call-resolution` → `feat/agent-change-map-mvp`),
      referencing `openspec/changes/instance-method-call-resolution/proposal.md`,
      `design.md`, and this `tasks.md`.

---

## Review Workload Forecast

Per design.md "PR slicing recommendation":

| File | Added | Removed |
|------|-------|---------|
| `python/analyzer.py` — `local_bindings` init | 1 | 0 |
| `python/analyzer.py` — `visit_Assign` | 5 | 0 |
| `python/analyzer.py` — `qualified_by_id` | 1 | 0 |
| `python/analyzer.py` — `variable_classes` fold | 13 | 0 |
| `python/analyzer.py` — resolution `elif` | 5 | 0 |
| `python/analyzer.py` — `_lexical_candidates` extraction | ~14 | ~12 |
| `test/unit/pythonAnalyzer.test.ts` — 8 new cases + 1 regression guard | ~70 | 0 |
| **Total** | **~109** | **~12** |

Estimated total: **~120 changed lines**, comfortably under this repo's 400-line
single-review budget. **No chaining is needed** — the entire change ships as one
PR, reviewed as one unit, per design's explicit recommendation that splitting
would ship dead/unproven code (visitor, fold, and resolution branch are a single
non-functional-until-complete unit).
