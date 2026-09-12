# Proposal: Extended Instance Method Call Resolution

## Intent

The prior `instance-method-call-resolution` change resolves only `x = ClassName(...)` followed by `x.method()` **in the same scope**. Three broader shapes stay `unresolved` (exploration §2–4):

1. **Annotations** — `x: Route4` / `def f(r: Route4)`; no `visit_AnnAssign` or `ast.arg.annotation` handling exists.
2. **`self.attr`** — `self.route = Route4()` in `__init__`, called as `self.route.method()` in another method; requires cross-method, class-scoped binding.
3. **Chained/returned instances** — `get_route().method()`, where the receiver is an `ast.Call`, not a `Name`.

Existing spec scenarios explicitly encode 2 and 3 as unresolved; this change replaces that boundary.

## Scope

### In Scope (three sequenced slices, one change)

1. **Annotations** — bare `ast.Name` annotations on `AnnAssign` targets (with or without a value) and on function parameters. *Architectural prerequisite*: slices 2 and 3 both reuse its "annotation name → class" resolution.
2. **`self.attr`** — class-scoped binding pass for `self.attr = ClassName(...)`, resolved at any call site inside the same class.
3. **Chained/returned calls** — explicit `-> ClassName` annotations **and full return-statement-body inference** (`return Route4(...)`, `return self.attr`), recursive with cycle guards; multi-return unions → `ambiguous`.

### Out of Scope

- Quoted forward refs (`"Route4"`), generics/unions (`Optional[Route4]`, `Route4 | None`).
- Any receiver-identity detection beyond the **literal parameter name `self`**.
- Anything beyond the above (no cross-module dataflow, no reassignment tracking, no non-`self` attribute chains).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `python-structure-analysis`: `self.attr` and chained/returned calls become resolvable; annotation-derived bindings added.

## Approach

- Extend the existing `variable_classes: dict[str, list[str]]` shape (unchanged shape, new population sources) for slices 1–2, keyed class-qualified for `self.attr`.
- New **enclosing-class** helper — distinct from `_lexical_candidates`, which skips *over* class scopes; this one stops *at* them.
- New `function_return_classes: dict[str, list[str]]` for slice 3, populated from annotations and recursive body inference; undecidable expressions no-op inertly.
- `_resolution()` reused **unchanged** — no new ambiguity logic anywhere (mirrors prior change's ADR).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `python/analyzer.py` | Modified | New visitors, folds, helper, resolution branches |
| `test/unit/pythonAnalyzer.test.ts` | Modified | Synthetic cases per slice |
| `openspec/specs/python-structure-analysis/spec.md` | Modified | Delta replacing two "remains unresolved" scenarios |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **No real-fixture validation.** All 6 files in `/home/pedro/Documentos/Projects/test/*.py` were read in full; **none** exercise any of the three cases. Every test is synthetic. This is asymmetric versus the prior change, which validated against two live unresolved calls in that same fixture. | High | State plainly; keep each slice independently revertible |
| Slice 3 body inference (recursion, cycles, undecidable exprs) is materially higher-risk than 1–2 | Med | Cycle guard + defined inert fallback; last slice |
| `self` literal-name heuristic misses renamed receivers | Med | Named, documented simplification |
| Scope creep — surface is larger than prior change | Med | Sequenced slices; explicit out-of-scope list |

## Rollback Plan

Each slice is a separate commit/PR touching only `python/analyzer.py` plus its tests. Revert the offending slice; earlier slices stand alone. Full rollback restores prior-change behavior (`unresolved` for all three shapes).

## Dependencies

- Prior change `instance-method-call-resolution` (merged) — supplies `variable_classes`, `_lexical_candidates`, `_resolution()`.

## Success Criteria

- [ ] `x: Route4` and `def f(r: Route4)` receivers resolve to `class:` ids
- [ ] `self.attr = ClassName()` resolves at cross-method call sites in the same class
- [ ] `get_route().method()` resolves via both `-> ClassName` and inferred return bodies
- [ ] Multi-binding/multi-return → `ambiguous`; unresolvable/undecidable → `unresolved`, never a crash
- [ ] `_resolution()` unmodified; no regressions in existing analyzer tests
