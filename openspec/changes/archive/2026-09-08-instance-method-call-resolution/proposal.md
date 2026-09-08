# Proposal: Resolve Instance Method Calls

## Intent

`python/analyzer.py` resolves a call only when `call.func` is an `ast.Name`. A
call through an instance variable (`Route4_instance.get_info()`) is an
`ast.Attribute` and silently keeps the default `{"kind": "unresolved"}`.
Confirmed against this repo's own `test/app.py` fixture: `Main.run` builds
`Route4_instance = Route4()` and `route3 = Route3()`, then calls `.get_info()`
on both — the most common Python call shape produces zero call edges, so the
change map under-reports real coupling.

## Scope

### In Scope

- Exploration **Approach 1** only: assignment-shaped constructor binding —
  `x = ClassName(...)` followed by `x.method()` in the **same lexical scope**.
- New `visit_Assign` in `FileVisitor` recording `(scope, var, ClassName)`.
- New resolution branch for `ast.Attribute` over an `ast.Name` value, reusing
  `by_qualified_name` and `_resolution()`.
- **Branch reassignment (decided)**: when a variable is reassigned to a
  different class across branches (`if: x = A()` / `else: x = B()`), accumulate
  BOTH classes as candidates; `_resolution()` then yields `ambiguous` with
  candidates from both classes' matching methods. Bindings are not dropped.

### Out of Scope

- `self.attr` propagation across methods; function parameters; chained or
  returned instances (`get_route().method()`).
- Non-constructor RHS (`x = factory()`, `x = other_var`), walrus (`ast.NamedExpr`),
  tuple/multi/chained assignment, `for`-loop variables, bare annotations with no
  assignment.
- **Approach 2** (annotation-based typing, `AnnAssign` / `arg.annotation`) —
  deferred follow-up.
- **Approach 3** (full data-flow / points-to analysis) — not planned.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `python-structure-analysis`: calls through a locally constructed instance
  variable must resolve to the class method (or `ambiguous` across branch
  reassignments) instead of always `unresolved`.

## Approach

1. `FileVisitor.visit_Assign` matches strictly
   `Assign(targets=[Name(id=var)], value=Call(func=Name(id=ClassName)))` and
   appends to `self.local_bindings`, scoped by `current_qualified_name` —
   mirroring `import_aliases` exactly.
2. `analyze()` folds bindings into `variable_classes` keyed `f"{scope}.{var}"` →
   list of class qualified names (multiple entries accumulate).
3. At the resolution bottleneck add
   `elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)`:
   look up the variable's bound class(es) for the call's scope, then resolve
   `f"{Class}.{attr}"` through `_resolution()`. Multi-candidate → `ambiguous`,
   no match → `unresolved`. Zero new ambiguity code.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `python/analyzer.py` | Modified | `visit_Assign`, `local_bindings`, `variable_classes`, attribute branch |
| `test/unit/pythonAnalyzer.test.ts` | Modified | Cases for resolved, ambiguous, and unresolved instance calls |
| `src/protocol.ts` | None | `resolved`/`ambiguous`/`unresolved` already sufficient |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Scope creep into annotation typing (Approach 2) | Med | Out-of-scope list is explicit; spec covers assignment shape only |
| `visit_Assign` mis-binds tuple/starred/attribute targets | Med | Strict single-`Name`-target + `Call(func=Name)` match; negative tests |
| False edges from shadowed/reused variable names | Low | Per-scope keying, no cross-scope lookup |

## Rollback Plan

Revert `python/analyzer.py` and its tests. The change is purely additive (one
visitor method, one dict, one `elif`); reverting restores `unresolved` output
with no schema or persisted-state migration.

## Dependencies

- None.

## Success Criteria

- [ ] `x = ClassName(); x.method()` in one scope emits a `resolved` call edge.
- [ ] Branch reassignment to two classes emits `ambiguous` with both candidates.
- [ ] Unknown class or missing method still emits `unresolved` — no new failures.
- [ ] `test/app.py` fixture produces call edges for `Route4_instance.get_info()`
      and `route3.get_info()`.
- [ ] No regression in existing lexical-resolution tests.
