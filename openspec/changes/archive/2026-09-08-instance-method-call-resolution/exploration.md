# Exploration: instance-method-call-resolution

## Current State

`python/analyzer.py` is a single-file, single-pass-plus-two-pass-resolution AST walker with **no general data-flow analysis**.

- `FileVisitor` walks the tree once via `ast.NodeVisitor`. It maintains a scope stack `self.stack`, pushed/popped only in `add_definition` (called from `visit_ClassDef`/`visit_FunctionDef`/`visit_AsyncFunctionDef`). `current_qualified_name` is simply `self.stack[-1][1]`.
- `visit_Call` does **not** attempt any resolution during the walk — it just records `(current_id, current_qualified_name, node)` into `self.calls` and recurses.
- There is **no `visit_Assign`** anywhere in the file. Assignments (`x = Foo()`) are not tracked at all today — a `Call` on the RHS is still recorded via `generic_visit`, but no variable→type binding is ever recorded.
- `import_aliases: list[tuple[scope, local_name, target_qualified_name]]` is the closest existing precedent for exactly the data structure this feature needs — scoped by `self.current_qualified_name` at the point of the statement. After the visitor pass, `analyze()` folds it into `alias_targets: dict[str, list[str]]` keyed by `f"{scope}.{local_name}"`, mirroring `by_qualified_name`'s shape so `_resolve_lexical` can query both uniformly.
- `by_qualified_name` is built once, globally, from every node's `qualifiedName` — the single source of truth for "what does this dotted name resolve to," including ambiguity (multiple nodes sharing a qualified name).
- The two-pass edge-resolution loop: pass 1 resolves `from_imports` edges and builds `alias_targets`; pass 2 resolves every recorded call. **The bottleneck**: `if isinstance(call.func, ast.Name): resolution = _resolve_lexical(...)`. Anything else (`ast.Attribute`, `ast.Subscript`, etc.) silently keeps the default `{"kind": "unresolved"}`.
- `_resolve_lexical` walks `scope` outward: try `f"{current}.{name}"` in both `symbols` and `aliases`; if found, return via `_resolution` (handles `resolved`/`ambiguous`/`unresolved` uniformly by candidate-list length); else strip the last dotted segment and retry, stopping at `module` — with an explicit skip-over for class scopes (`self.attr`/`self.method()` inside a method body is deliberately NOT a lexical lookup into class-body names — this is documented existing behavior, not a bug).

## Real-world confirmation (`/home/pedro/Documentos/Projects/test/`)

`app.py`, method `Main.run` (scope `test.app.Main.run`):
```python
Route4_instance = Route4()
print(Route4_instance.get_info())   # call.func = Attribute(value=Name('Route4_instance'), attr='get_info')
...
route3 = Route3()
print(route3.get_info())            # same shape
```
Both are the exact minimal case: a bare-name variable assigned a direct constructor call (`ClassName(...)`, imported at module scope) in the **same** lexical scope where the `.method()` call site lives. No intervening branches complicate the binding itself. This is precisely the case Approach 1 targets and would fully resolve.

## Approaches

### 1. Assignment-shaped constructor binding, same-scope only (minimal viable)

During the existing visitor pass, add a narrow `visit_Assign` that recognizes only `Assign(targets=[Name(id=var)], value=Call(func=Name(id=ClassName)))` (single bare-name target, RHS a direct call to a bare name) and records `(scope, var, ClassName)` into a new list, scoped by `self.current_qualified_name` exactly like `import_aliases`.

In `analyze()`, fold this into a `variable_classes` dict keyed by `f"{scope}.{var}"` → resolved class qualified name(s) (resolving `ClassName` the same way `_resolve_lexical` would). At the resolution bottleneck, add an `elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)` branch: look up the variable in `variable_classes` at the call's own scope, get the class, then look up `f"{class}.{attr}"` in `by_qualified_name` via `_resolution()` — same ambiguous/unresolved fallback machinery, zero duplication.

- **Pros**: small, additive, isolated diff; reuses 100% of existing resolution/ambiguity primitives; directly fixes the reported case; no new AST traversal pass needed; testable in isolation.
- **Cons**: narrow — misses `self.attr` bindings set in `__init__`, cross-scope propagation, reassignment-across-branches ambiguity, and any indirection (returned instances, chained calls).
- **Effort**: Low.

### 2. Also honor type annotations (`x: Route4 = ...`, annotated parameters)

Extends Approach 1 by also reading `AnnAssign.annotation` and `arg.annotation` into the same map, independent of whether a constructor call is present.

- **Pros**: closes "declared but not directly constructed" and "typed parameter" gaps — parameters are exactly where Approach 1 is otherwise blind.
- **Cons**: adds another AST node type to special-case (including deferred/quoted string annotations, generic types like `Optional[Route4]`); leaves the same reassignment/branch-ambiguity questions as Approach 1; annotation trust isn't "verified" the way a constructor call is.
- **Effort**: Medium.

### 3. Full data-flow / points-to analysis

Proper type inference: reassignment per-branch, `self.attr` propagation across methods, return-type inference for `get_route().method()`, parameter types from call-site argument analysis.

- **Pros**: resolves the fuller class of currently-unresolved edges.
- **Cons**: this analyzer has zero existing data-flow infrastructure — no CFG, no SSA, no branch-merge logic, no interprocedural summaries. A multi-week effort disproportionate to a static structural/call-graph mapping tool.
- **Effort**: High — explicitly out of proportion for this project's stated scope.

## Recommendation

**Approach 1** for a minimal first version — directly fixes the reported case with a small, well-isolated diff reusing all existing machinery. Approach 2 is a reasonable **follow-up**, explicitly out of scope for v1. Approach 3 is not planned.

## Explicitly out of scope for the minimal version

- `self.attr` attribute access inside a method (requires cross-method propagation into the class's instance-attribute namespace).
- A variable reassigned to a different class conditionally (`if`/`else`) — see open design question below.
- A variable passed as a function parameter (genuinely unknown type without call-site analysis; Approach 2 partially covers this).
- A chained/returned instance (`get_route().method()`) — `call.func.value` isn't an `ast.Name`.
- A variable assigned from a non-constructor expression (`x = some_factory()`, `x = other_var`).
- Walrus assignment (`x := ClassName()`) — different AST node (`ast.NamedExpr`).
- Tuple/multiple assignment (`a, b = ClassName(), OtherClass()`, `x = y = ClassName()`).
- `for` loop variables — no constructor call to inspect.
- Class attribute type annotations with no assignment (`x: Route4`) — Approach 2 only.

## Where the binding data lives

Per-scope, keyed by `self.current_qualified_name` at the point of the assignment — exactly mirroring `import_aliases`. Collected during the **same** visitor pass (add `visit_Assign` to `FileVisitor`, populate `self.local_bindings`, same 3-tuple shape as `import_aliases`), not a new pass. Per-scope keying is mandatory so a variable named the same in two different functions never collides.

## Interaction with ambiguity/unresolved semantics

- **Class can't be determined**: don't record a binding; falls through to the existing `unresolved` default — no new failure mode.
- **Class found, but no such method**: `_resolution([])` already returns `unresolved` — free, reuses the existing code path.
- **Variable reassigned to two different classes across branches**: explicitly an **open design question** for the proposal — either (a) drop/invalidate the binding entirely on a second, different-class assignment to the same `(scope, var)` key (safest, "don't guess"), or (b) accumulate multiple class candidates and let `_resolution` naturally produce `ambiguous` when resolving `<Class>.<attr>` against multiple classes (barely more code, reuses `_resolution`'s existing ambiguity contract). Must be confirmed explicitly, not silently picked during implementation.

## Affected Areas

- `python/analyzer.py` — `FileVisitor` (add `visit_Assign`, new `self.local_bindings`), `analyze()` (fold into `variable_classes`; extend the resolution bottleneck with an `elif` for `ast.Attribute`).
- `test/unit/pythonAnalyzer.test.ts` — new test case(s) mirroring the existing "resolves direct calls only through Python lexical scopes" test, for `x = ClassName(); x.method()`.
- `src/protocol.ts` — no change needed; `resolved`/`ambiguous`/`unresolved` already cover every outcome.
- No `webview/`, `src/analysis/pythonAnalyzer.ts`, or other TS surface needs to change.

## Risks

- The branch-reassignment ambiguity-semantics decision is a real design fork needing explicit confirmation in the proposal.
- Approach 2 (annotations) is a natural "while we're in there" temptation; scope discipline needed to keep v1 to Approach 1 only.
- `visit_Assign` must remain narrow (single `Name` target, RHS exactly `Call(func=Name(...))`) to avoid silently mis-binding tuple/starred/attribute-target assignments.

## Ready for Proposal

Yes, pending one clarifying decision: for a variable reassigned to two different classes across branches, should the binding be dropped (report unresolved) or accumulated as ambiguous candidates?
