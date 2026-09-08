# Verification Report: instance-method-call-resolution

**Date**: 2026-09-08
**Branch verified**: `feat/agent-change-map-mvp` @ `46000bd` (merge of PR #28, includes `eaf6ae9`)
**Mode**: Full artifacts (proposal, spec, design, tasks all present)

## Completeness (tasks.md)

- 22 of 23 checkboxes checked.
- `5.3` ("Open the single PR against the tracker branch") is unchecked in the file, but PR #28 (`feat/instance-method-call-resolution` → `feat/agent-change-map-mvp`) was in fact opened and merged as commit `46000bd`. This is a documentation-hygiene gap only (the checkbox was never ticked post-merge), not a functional gap. **WARNING**, not CRITICAL.
- All other tasks (0.1, 1.1–1.2, 2.1–2.7, 3.1–3.3, 4.1–4.3, 5.1–5.2) verified checked and, per source inspection below, genuinely reflected in code.

## Spec Compliance Matrix (`specs/python-structure-analysis/spec.md`)

| # | Scenario | Covering test (file: `test/unit/pythonAnalyzer.test.ts`) | Result |
|---|----------|------------------------------------------------------------|--------|
| 1 | Resolve a direct call | `"resolves direct calls only through Python lexical scopes"` (L33) | PASS |
| 2 | Analyze a dynamic call | `"extracts nested entities, imports, calls, and exact UTF-8 spans"` (L14, `obj.dynamic()` assertion) | PASS |
| 3 | Resolve a call through a locally constructed instance | `"resolves a call through a locally constructed instance variable"` (L99) | PASS |
| 4 | Instance variable reassigned to different classes across branches | `"reports ambiguous candidates when an instance variable is reassigned across branches"` (L106) | PASS |
| 5 | Instance call to an unresolvable constructor class | `"leaves instance calls unresolved when the constructor class is unknown"` (L120) | PASS |
| 6 | Instance call with no matching method on the resolved class | `"leaves instance calls unresolved when the bound class has no matching method"` (L126) | PASS |
| 7 | Call through self-attribute access remains unresolved | `"leaves unsupported instance-binding shapes unresolved"` (L132, line-18 assertion — `self.route.get_info()`) | PASS |
| 8 | Call through a variable bound from a non-constructor expression remains unresolved | `"leaves unsupported instance-binding shapes unresolved"` (L132, line-23/27 assertions — `s = r` / `p = q = Route()`) | PASS |
| 9 | Chained or returned-instance call remains unresolved | `"leaves unsupported instance-binding shapes unresolved"` (L132, line-11/14 assertions — `factory()`/`chained()`) | PASS |

Additional covered but not spec-numbered:
- Dedup (repeated same-class assignment stays `resolved`, not `ambiguous`): `"keeps repeated assignment of the same class resolved rather than ambiguous"` (L114).
- Scope isolation (no outward walk to bind across function scopes): `"scopes instance bindings to the assignment's own scope"` (L140).
- Alias interaction (from-import + instance binding): `"resolves instance calls to a class bound by a from-import"` (L146).
- `_resolve_lexical` extraction characterization guard: `"resolves direct-name calls unchanged by the _lexical_candidates extraction (characterization guard)"` (L92).

All 9 spec scenarios have a passing, runtime-executed covering test. No UNTESTED or FAILING scenarios found.

## Design Fidelity — Source Inspection (`python/analyzer.py`)

- **D7** — `visit_Assign` (line 128) calls `self.generic_visit(node)` **unconditionally**, outside the `if` guard. Confirmed: constructor-call sub-expressions and nested calls in any assignment RHS are never dropped.
- **D5** — `variable_classes` fold (lines 190–203) has both required dedup barriers:
  - Per-binding: `if name not in class_names` (line 198), guarding against a single binding resolving to the same class twice.
  - Cross-binding: `for name in class_names if name not in bound` (line 203), guarding against repeated assignment (e.g. `x = Route(); x = Route()`) producing duplicate candidates.
- **D4** — `class:` prefix filter present: `if not identifier.startswith("class:"): continue` (line 195), excluding non-class matches (e.g. functions with the same name) from binding candidates.
- **D2/(a)** — `variable_classes` fold is a separate `for visitor in visitors:` loop (line 191) placed strictly after the `alias_targets` loop (lines 184–188) has fully completed within its own separate loop — confirmed alias map is fully built before being read.
- **`_lexical_candidates` extraction** — genuinely extracted (lines 220–232); `_resolve_lexical` (lines 235–236) is reduced to the one-line wrapper `return _resolution(_lexical_candidates(name, scope, module, symbols, aliases))`. Confirmed no residual duplicated logic.
- **Resolution branch** (lines 210–214) — `elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)`, unioning one flat `candidates` list across all bound classes via `by_qualified_name.get(f"{class_name}.{call.func.attr}", [])`, passed once to `_resolution()`. Matches design.md §3 exactly.

All source-level design decisions (D2/(a), D4, D5, D7) and the `_lexical_candidates` extraction independently verified by direct code reading, not inferred from tests alone.

## Test/Build Evidence (independently re-run this session)

```
npm run lint            → exit 0 (eslint src test webview --max-warnings=0, zero warnings)
npm run typecheck       → exit 0 (tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit)
npx vitest run test/unit test/integration → exit 0
  Test Files  24 passed (24)
  Tests       311 passed (311)
  (test/unit/pythonAnalyzer.test.ts: 19 tests, all passed)
```

## Real-World Validation

Ran `python3 python/analyzer.py` directly (bypassing unit tests) against the user's originally reported repro repo at
`/home/pedro/Documentos/Projects/test/` (`app.py`, `route.py`, `route2.py`, `route3.py`, `route4.py`, `config.py`),
constructing the same JSON `analyze` request shape the extension host sends.

Results for the exact calls originally reported as unresolved:

| Call site | `app.py` line | Resolution before fix (known) | Resolution now |
|---|---|---|---|
| `Route4_instance.get_info()` | 15, col 18 | `unresolved` | `resolved` → `method:route4.Route4.get_info@172` |
| `route3.get_info()` | 27, col 18 | `unresolved` | `resolved` → `method:route3.Route3.get_info@183` |

(Column 12 on both lines is the unrelated `print(...)` builtin call, correctly still `unresolved` — builtins are out of scope for this change and expected to remain so.)

The constructor call itself (`Route4()` at line 14) also resolves correctly to `class:route4.Route4@25`, confirming the binding fold captured the local variable before the method-call resolution branch consumed it.

This confirms the change fixes the exact real-world scenario that motivated it, not just the synthetic unit-test fixtures.

## Issues

- **WARNING**: `tasks.md` item 5.3 is unchecked despite the PR having been opened and merged (`46000bd`). Recommend ticking the box before archive for documentation accuracy; does not block functional correctness.
- No CRITICAL issues found.
- No SUGGESTION-level issues found.

## Verdict

**PASS**

All 9 spec scenarios have passing, runtime-verified covering tests. All source-level design decisions (D2/(a), D4, D5, D7, `_lexical_candidates` extraction) independently confirmed by direct code reading. Full independent re-run of lint/typecheck/tests is green (311/311 tests, 24/24 files). Real-world validation against the user's original repro confirms the specific previously-unresolved calls (`Route4_instance.get_info()`, `route3.get_info()`) now resolve correctly. Only issue is a cosmetic unchecked task box that does not reflect actual completion state — recommend fixing before archive but does not block it.
