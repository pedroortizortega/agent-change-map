# Design: Extended Instance Method Call Resolution

## Scope of this design

Exactly the proposal's three slices. All line references are against
`python/analyzer.py` **as it stands today** (281 lines, post-merge of
`instance-method-call-resolution`), re-read in full for this design — not against
the prior design's baseline.

This design deliberately exceeds the 800-word phase budget: the orchestrator
required full combined code blocks, per-slice exactness, and prior-design-level
correctness scrutiny. Size is justified by the proposal's own risk table
(three slices, one of them materially riskier than the entire prior change).

## Architecture

Same three-stage pipeline, same **structural mirroring** discipline the prior
change established. Every new datum has the same 2/3-tuple raw-name staging shape
as `import_aliases` / `local_bindings`, and every fold produces a
`dict[str, list[str]]` of qualified class names.

| Stage | Existing | Slice 1 | Slice 2 | Slice 3 |
|---|---|---|---|---|
| 1. `FileVisitor` | `local_bindings` | `visit_AnnAssign`, `_bind_signature` params | `self_scopes`, `attribute_bindings` | `return_annotations`, `return_names`, `return_attributes` |
| 2. Fold in `analyze()` | `variable_classes` | (same map, new sources) | `attribute_classes` | `function_return_classes` + fixed point |
| 3. Resolution | `Attribute` over `Name` | (unchanged) | `Attribute` over `self.attr` | `Attribute` over `Call` |

Two shared extractions serve all three slices (both behavior-preserving, same
justification as the prior change's `_lexical_candidates` extraction):

```python
def _extend(target: list[str], names: list[str]) -> None:
    target.extend(name for name in names if name not in target)


def _class_names(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]], qualified_by_id: dict[str, str]) -> list[str]:
    """Resolve a raw source name to the deduplicated qualified names of the classes it can denote."""
    names: list[str] = []
    for identifier in _lexical_candidates(name, scope, module, symbols, aliases):
        if identifier.startswith("class:"):
            _extend(names, [qualified_by_id[identifier]])
    return names
```

`_class_names` is the literal body of current lines 193–199, lifted verbatim. It
preserves the prior change's D4 (`class:` filter) and D5 (per-binding dedup)
guarantees at a single site now used by all three slices.

---

## Slice 1 — Annotations

### 1.1 `visit_AnnAssign`

`ast.AnnAssign(target, annotation, value, simple)`. `value` is `None` for a bare
`x: Route4`; the annotation alone establishes the binding, so **the match must not
test `value` at all**.

```python
    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        """Bind `x: ClassName` from the annotation alone, whether or not a value is assigned."""
        if isinstance(node.annotation, ast.Name):
            self._bind_target(node.target, node.annotation.id)
        self.generic_visit(node)
```

Bare `ast.Name` only. `x: "Route4"` is `ast.Constant`, `x: Optional[Route4]` is
`ast.Subscript`, `x: Route4 | None` is `ast.BinOp` — all excluded by construction,
satisfying the spec's quoted/generic-remains-unresolved scenario without a
negative test in the code.

**`generic_visit` is MANDATORY here for the same reason as D7.** Defining
`visit_AnnAssign` removes `ast.NodeVisitor`'s automatic `generic_visit` fallback
for `AnnAssign` nodes; omitting it would silently drop the call edge for the RHS
of `x: Route4 = Route4()` and every nested call in any annotated assignment. It
must be unconditional, outside the `if`.

**Deliberate asymmetry**: for `x: A = B()` only `A` is bound. `AnnAssign` is not
`ast.Assign`, so `visit_Assign` never sees the RHS. The annotation is
authoritative; unioning both would manufacture a false `ambiguous` from
perfectly explicit code.

### 1.2 `_bind_target` — shared target router

`visit_Assign`'s current inline append is replaced by a router so slice 2 can add
one `elif` without touching `visit_Assign` or `visit_AnnAssign` again:

```python
    def visit_Assign(self, node: ast.Assign) -> None:
        """Bind `var = ClassName(...)` for the current scope; every other assignment shape is ignored."""
        if len(node.targets) == 1 and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
            self._bind_target(node.targets[0], node.value.func.id)
        self.generic_visit(node)

    def _bind_target(self, target: ast.expr, class_name: str) -> None:
        """Route a plain-name target to the lexical binding table and a `self.attr` target to its class's table."""
        if isinstance(target, ast.Name):
            self.local_bindings.append((self.current_qualified_name, target.id, class_name))
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self" and self.current_qualified_name in self.self_scopes:
            self.attribute_bindings.append((self.current_qualified_name, target.attr, class_name))
```

(The `elif` arrives with slice 2; slice 1 ships only the `if`.) The
`isinstance(node.targets[0], ast.Name)` guard moves out of `visit_Assign` into
`_bind_target` — behavior-preserving for slice 1, and exactly the hook slice 2
needs.

### 1.3 Parameter annotations — `_bind_signature`

**Confirmed Python semantic**: `ast.NodeVisitor` dispatches on
`"visit_" + node.__class__.__name__`. `ast.arg` nodes are only reached via
`generic_visit` recursion, and a `visit_arg` method would have **no access to the
owning function's scope** — the scope stack is pushed inside `add_definition`
around `generic_visit`, so by the time an `arg` is visited the stack top is the
function itself, but `arg` nodes are children of `node.args`, which
`add_definition`'s `generic_visit` *does* traverse. Even so, `visit_arg` cannot
distinguish the receiver parameter from the rest and cannot see decorators.
Direct inspection in `visit_FunctionDef` is the only correct site.

```python
    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._bind_signature(node)
        self.add_definition(node, "function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._bind_signature(node)
        self.add_definition(node, "function")

    def _bind_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        """Record the receiver, parameter annotations, and return sources for the scope this definition opens."""
        scope = f"{self.current_qualified_name}.{node.name}"
        parameters = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        if self.stack[-1][2] == "class" and parameters and parameters[0].arg == "self" and not any(isinstance(decorator, ast.Name) and decorator.id in {"staticmethod", "classmethod"} for decorator in node.decorator_list):
            self.self_scopes.add(scope)
            parameters = parameters[1:]
        for parameter in parameters:
            if isinstance(parameter.annotation, ast.Name):
                self.local_bindings.append((scope, parameter.arg, parameter.annotation.id))
```

Ordering is load-bearing: `_bind_signature` runs **before** `add_definition`, so
`self.current_qualified_name` is still the *enclosing* scope (used to compute
`scope`, and in slice 2/3 it *is* the class qualified name), and
`self.self_scopes` is populated before the body's `visit_Assign` runs.

| Decision | Choice | Why |
|---|---|---|
| Which parameter lists | `posonlyargs + args + kwonlyargs` | All are plain named parameters bound to one value |
| `vararg` / `kwarg` | **Excluded** | `*args: Route4` types the *elements*; `args` is a `tuple`. Binding it to `Route4` would be flatly wrong |
| `self` | **Excluded** (and only when it is the receiver) | Slice 2 owns the receiver. Binding it would also make `self.method()` newly resolve, changing behavior the prior design's matrix pins as unchanged and that no spec scenario requests |
| Annotation resolution scope | the function's own `scope` | `_lexical_candidates` walks outward, so the defining scope is reached on the next hop; its class-skip correctly prevents a class attribute from shadowing |

### 1.4 Fold — no new structure

`local_bindings` now carries annotation-derived tuples in the identical
`(scope, name, raw_class_name)` shape. The existing `variable_classes` fold
(current lines 190–203) resolves them identically — an annotation name and a
constructor name are both "a bare source name that should denote a class".
**Zero fold changes in slice 1** beyond substituting `_class_names`.

Failure semantics reuse D6 verbatim: `x: UnknownClass` → `_lexical_candidates`
returns `[]` (or only non-`class:` ids, filtered out) → `class_names` empty →
`continue` → key never created → `.get(key, [])` → `_resolution([])` →
`{"kind": "unresolved"}`.

---

## Slice 2 — `self.attr`

### 2.1 Receiver detection

`FileVisitor` tracks scope kind in `self.stack[-1][2]` (`"module"` / `"class"` /
`"function"` / `"method"`) — the same test `add_definition` uses at line 73.
Decorators are **not** tracked today; this design starts checking
`node.decorator_list` for bare `staticmethod` / `classmethod` names inside
`_bind_signature` (the one-expression `not any(...)` clause above).

Accepted gap, named explicitly: `@builtins.staticmethod` or an aliased/custom
decorator (`ast.Attribute`, or `@my_static`) is not detected. A `@staticmethod`
whose first parameter is literally named `self` would then be mistaken for an
instance method. This is a vanishingly rare shape and the guard covers the
idiomatic form.

New visitor state:

```python
        self.attribute_bindings: list[tuple[str, str, str]] = []
        self.self_scopes: set[str] = set()
```

### 2.2 Enclosing class — no new outward-walking helper

**Decision: derive the class as `scope.rpartition(".")[0]`, gated on
`scope in self_scopes`.** Membership in `self_scopes` already proves the scope is
a genuine instance method whose *immediate* parent is a class, so the parent
segment *is* the class's qualified name. No `by_qualified_name` prefix probing,
no outward walk, no interaction with `_lexical_candidates` whatsoever — the
proposal's "new enclosing-class helper" collapses to a single-step derivation.

Rejected: the sketched outward walk (`scope.rpartition(".")[0]` repeatedly until
an id starts with `class:`). It is strictly worse and **produces a real false
positive**:

```python
class A:
    def m(self):
        def inner(self):        # a nested function with its own unrelated `self`
            self.attr = Route()  # would be attributed to class A
```

An outward walk reaches `mod.A` and binds `mod.A.attr`. The single-step rule
rejects it because `mod.A.m.inner`'s parent `mod.A.m` is not a class. This mirrors
the prior change's D8 ("no outward scope walk for bindings") exactly.

Accepted consequence: a *closure* over the outer `self` inside a nested function
(legal Python, `def inner(): return self.attr.go()`) stays `unresolved`. Under-
reporting, consistent with the analyzer's existing conservatism.

### 2.3 Binding table and key shape

Bindings stage as the same 3-tuple `(method_scope, attr, class_name)` — the
method scope, **not** the class, because the raw class name must be resolved from
the scope where it was *written*. Passing the class scope instead would make
`_lexical_candidates` first probe `f"{class}.{Route4}"`, i.e. a class attribute —
wrong. The class key is derived in the fold.

```python
    attribute_classes: dict[str, list[str]] = {}
    for visitor in visitors:
        for scope, attribute, raw in visitor.attribute_bindings:
            class_names = _class_names(raw, scope, visitor.module, by_qualified_name, alias_targets, qualified_by_id)
            if not class_names:
                continue
            _extend(attribute_classes.setdefault(f"{scope.rpartition('.')[0]}.{attribute}", []), class_names)
```

**Collision safety — confirmed.** `scope.rpartition(".")[0]` is a fully dotted
qualified name (`pkg.app.Holder`), never a bare class name, so `pkg.a.Holder.route`
and `pkg.b.Holder.route` are distinct keys. Two classes sharing an attribute name
cannot collide.

**A real collision does exist, and it is why this is a separate map.** Had
`self.attr` bindings been folded into `variable_classes` (the proposal's initial
"same map" framing), the class-scoped key `pkg.m.A.x` would collide with a
class-body assignment's own binding key:

```python
class A:
    x = Route()          # variable_classes key "pkg.m.A.x" (scope = the class body)
    def m(self):
        self.x = Other()  # would write the SAME key
    def run(self):
        return self.x.go()  # falsely ambiguous(Route.go, Other.go)
```

A separate `attribute_classes` map removes the collision by construction. This is
a new finding not present in the exploration or proposal.

### 2.4 Dedup — same two-level discipline as D5, required

`_resolution` still sorts without deduplicating, so the discipline is mandatory
here too. Worked example from the brief:

```python
class Holder:
    def __init__(self):
        self.route = Route4()   # binding 1
    def reset(self):
        self.route = Route4()   # binding 2, same class
    def run(self):
        return self.route.go()  # MUST be resolved, not ambiguous
```

- *Within one binding*: `_class_names`'s internal `_extend` collapses a class
  qualified name defined twice in the file to one name.
- *Across bindings*: `_extend(attribute_classes.setdefault(...), class_names)`
  collapses binding 2 into binding 1 — one name → one method id → `resolved`. ✓

Multi-class case (`self.attr = A()` / `self.attr = B()`) accumulates two names →
union of both `go` ids → `ambiguous`. Accumulation-not-replacement reused verbatim.

---

## Slice 3 — Chained / returned calls

### 3.1 New structures

```python
        self.return_annotations: list[tuple[str, str]] = []   # (function_scope, annotation_name)
        self.return_names: list[tuple[str, str]] = []          # (function_scope, returned_callee_name)
        self.return_attributes: list[tuple[str, str]] = []     # (function_scope, "Class.attr" key)
        self.return_locals: list[tuple[str, str]] = []          # (function_scope, returned_local_var_name)
```

**Amendment, confirmed with the user before `sdd-tasks`**: N10 (`return local_var`)
is IN scope for this slice, not deferred. `def f(): r = Route(); return r` is the
single most idiomatic return shape and the answer is already sitting in
`variable_classes` under the exact key the returning scope would use — deferring
it would leave the change's most likely-to-be-expected case unresolved for no
real cost saving.

```python
    function_return_classes: dict[str, list[str]] = {}   # function qualified name -> class qualified names
    return_dependencies: dict[str, list[str]] = {}       # function qualified name -> function qualified names
```

### 3.2 `-> ClassName` and body collection, in `_bind_signature`

Appended to `_bind_signature` (same scope variable, same pre-push ordering, so
`self.current_qualified_name` is the enclosing class for the `self.attr` case):

```python
        if isinstance(node.returns, ast.Name):
            self.return_annotations.append((scope, node.returns.id))
        for statement in _own_returns(node):
            if isinstance(statement.value, ast.Call) and isinstance(statement.value.func, ast.Name):
                self.return_names.append((scope, statement.value.func.id))
            elif isinstance(statement.value, ast.Attribute) and isinstance(statement.value.value, ast.Name) and statement.value.value.id == "self" and scope in self.self_scopes:
                self.return_attributes.append((scope, f"{self.current_qualified_name}.{statement.value.attr}"))
            elif isinstance(statement.value, ast.Name):
                self.return_locals.append((scope, statement.value.id))
```

`return_locals` deliberately overlaps in shape with `return_names`/`return_attributes`
(both are "a name found in a `return`"), but is collected as its own list rather than
merged with either: `return_names` resolves through `_class_names` (a raw *class*
name), while `return_locals` resolves through `variable_classes` (an already-bound
*variable*) — conflating them would require a runtime type check inside the fold to
tell which lookup applies, whereas two lists make the distinction free at collection
time.

Everything else — `return`, `return 1`, `return [Route4()]`, `return a().b()`,
`return mod.Route4()`, `return x` (a local variable) — matches no branch and
contributes nothing. Inert by construction, never an error.

### 3.3 `_own_returns` — lexically bounded traversal

`ast.walk(node)` is **wrong**: it descends into nested `FunctionDef` /
`AsyncFunctionDef` / `ClassDef` bodies and would attribute a nested function's
`return` to the outer one. Explicit bounded traversal, seeded from `node.body`
(so decorators, defaults, and the return annotation subtree are excluded too):

```python
def _own_returns(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.Return]:
    """Every `return` lexically owned by this definition; nested definitions own their own."""
    found: list[ast.Return] = []
    pending: list[ast.AST] = list(node.body)
    while pending:
        current = pending.pop()
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(current, ast.Return):
            found.append(current)
        pending.extend(ast.iter_child_nodes(current))
    return found
```

`ast.Lambda` cannot contain `Return`, but excluding it is explicit and free.
Nested `if` / `for` / `try` / `with` bodies **are** traversed — those returns do
belong to this function.

### 3.4 Fold, and its mandatory ordering

Placed after the `attribute_classes` fold has fully completed.

```python
    annotated_returns: set[str] = set()
    for visitor in visitors:
        for scope, name in visitor.return_annotations:
            annotated_returns.add(scope)
            _extend(function_return_classes.setdefault(scope, []), _class_names(name, scope, visitor.module, by_qualified_name, alias_targets, qualified_by_id))
    for visitor in visitors:
        for scope, name in visitor.return_names:
            if scope in annotated_returns:
                continue
            _extend(function_return_classes.setdefault(scope, []), _class_names(name, scope, visitor.module, by_qualified_name, alias_targets, qualified_by_id))
            for identifier in _lexical_candidates(name, scope, visitor.module, by_qualified_name, alias_targets):
                if identifier.startswith(("function:", "method:")):
                    _extend(return_dependencies.setdefault(scope, []), [qualified_by_id[identifier]])
        for scope, key in visitor.return_attributes:
            if scope in annotated_returns:
                continue
            _extend(function_return_classes.setdefault(scope, []), attribute_classes.get(key, []))
        for scope, var in visitor.return_locals:
            if scope in annotated_returns:
                continue
            _extend(function_return_classes.setdefault(scope, []), variable_classes.get(f"{scope}.{var}", []))
```

**Ordering, unaffected**: this new loop reads `variable_classes`, which the
existing order already builds before `attribute_classes`/`function_return_classes`
(§ Architecture table) — no new edge in the fold DAG, no change to the acyclicity
proof in §3.4 (`variable_classes` never reads `function_return_classes`, by the
same `class:`-filter argument that already covers `attribute_classes`).

**Fold order and its acyclicity proof.** The required order is
`by_qualified_name` → `alias_targets` → `variable_classes` → `attribute_classes`
→ `function_return_classes`. The last edge is the only non-obvious one:
`function_return_classes` reads `attribute_classes` (for `return self.attr`), so
`attribute_classes` must never read `function_return_classes`. It cannot, by
construction: `_bind_target` only records bindings whose RHS is
`ast.Call(func=ast.Name)`, and `_class_names` filters to `class:` ids — so
`self.attr = get_route()` resolves `get_route` to a `function:` id, which is
filtered out, producing no binding. The fold DAG is therefore acyclic, and the
only cycles possible are *within* `function_return_classes`, handled below.

**Annotation precedence.** When `-> T` is present, body inference is skipped
entirely — including when `T` resolves to zero classes (`-> str`, `-> "Route4"`
is not an `ast.Name` so it is not "present"). An explicit annotation is
authoritative; unioning it with body inference would make
`def f() -> Base: return Derived()` falsely `ambiguous`. Rejected alternative:
union everything — manufactures ambiguity from correct code.

### 3.5 Cycle guard — fixed-point iteration

```python
    for _ in range(len(return_dependencies) + 1):
        changed = False
        for scope, dependencies in return_dependencies.items():
            for dependency in dependencies:
                inherited = [name for name in function_return_classes.get(dependency, []) if name not in function_return_classes.get(scope, [])]
                if inherited:
                    _extend(function_return_classes.setdefault(scope, []), inherited)
                    changed = True
        if not changed:
            break
```

**Termination — two independent proofs, both hold:**

1. *Monotonicity.* The mutable state is the set of `(scope, class_name)` pairs in
   `function_return_classes`. Pairs are only ever added, never removed, and are
   drawn from the finite universe `return_dependencies.keys() × {class names in
   the snapshot}`. Every pass either adds at least one pair or sets
   `changed = False` and breaks. Therefore the number of `changed = True` passes
   is bounded by `|scopes| × |classes|`.
2. *Structural bound.* `range(len(return_dependencies) + 1)` caps the loop
   unconditionally. Even a hypothetical monotonicity bug cannot hang the analyzer
   — termination does not depend on the correctness of the inner logic.

**Correctness of the `N + 1` bound.** The longest simple dependency chain over
`N = len(return_dependencies)` functions has at most `N` edges, so a class name
seeded anywhere propagates to every transitively dependent function within `N`
passes. A cycle contributes no new pairs once saturated, so it never needs more.

**The pathological case terminates in one pass.** For
`def a(): return b()` / `def b(): return a()` with no base case:
`_class_names` yields `[]` for both (both names resolve to `function:` ids,
filtered), so nothing is seeded; `return_dependencies = {m.a: [m.b], m.b: [m.a]}`.
Pass 1: both `.get()` lookups return `[]` → `inherited` empty → `changed` stays
`False` → `break`. Both functions end with no return classes → the call site
`a().method()` yields `_resolution([])` → `unresolved`. Exactly the spec's
"self-referential with no base case" scenario, with no crash and no loop. ✓
`def a(): return a()` behaves identically (a scope can never inherit from itself).

**Rejected alternatives:**

| Alternative | Rejected because |
|---|---|
| Topological order over an SCC-condensed call graph | Requires Tarjan/Kosaraju plus cycle-collapse logic — ~40 extra lines for an identical result |
| Bounded-depth recursive DFS with a `visited` set | **Order-dependent, therefore non-deterministic output.** Whichever function is visited first gets the complete answer; a later one may see a partially memoized result. The analyzer's determinism is already an asserted invariant (`"keeps legal same-scope redefinitions distinct and deterministic"`). Fixed-point iteration is confluent — its result is independent of dict iteration order |
| "Just guard against cycles" with a recursion counter | Silently truncates legitimate deep chains at an arbitrary constant |

**Dedup is as mandatory here as in D5.** `-> Route4` on a function that also does
`return Route4()` is collapsed by annotation precedence; two `return Route4()`
statements are collapsed by `_extend`. Without either, `_resolution` would see two
identical candidates and report `ambiguous`.

---

## The full combined resolution branch

Current lines 205–215 become, after all three slices:

```python
    for visitor in visitors:
        for source_id, scope, call in visitor.calls:
            resolution: dict[str, Any] = {"kind": "unresolved"}
            if isinstance(call.func, ast.Name):
                resolution = _resolve_lexical(call.func.id, scope, visitor.module, by_qualified_name, alias_targets)
            elif isinstance(call.func, ast.Attribute):
                receiver = call.func.value
                class_names: list[str] = []
                if isinstance(receiver, ast.Name):
                    class_names = variable_classes.get(f"{scope}.{receiver.id}", [])
                elif isinstance(receiver, ast.Attribute) and isinstance(receiver.value, ast.Name) and receiver.value.id == "self" and scope in visitor.self_scopes:
                    class_names = attribute_classes.get(f"{scope.rpartition('.')[0]}.{receiver.attr}", [])
                elif isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name):
                    for identifier in _lexical_candidates(receiver.func.id, scope, visitor.module, by_qualified_name, alias_targets):
                        if identifier.startswith(("function:", "method:")):
                            _extend(class_names, function_return_classes.get(qualified_by_id[identifier], []))
                candidates: list[str] = []
                for class_name in class_names:
                    candidates.extend(by_qualified_name.get(f"{class_name}.{call.func.attr}", []))
                resolution = _resolution(candidates)
            edges.append({"kind": "call", "source": source_id, "resolution": resolution, "span": visitor.source.span(call)})
```

One coherent decision tree: dispatch on `call.func`, then on the receiver shape,
then **one shared tail** (`class_names` → method-id union → `_resolution`). The
three receiver branches differ only in how `class_names` is obtained.

**Aliasing trap, explicitly guarded.** The `Name` and `self.attr` branches *rebind*
`class_names` to the list object stored inside `variable_classes` /
`attribute_classes`; the `Call` branch *mutates* the fresh `[]`. The branches are
mutually exclusive, so `_extend` never mutates a map's stored list — but any
future edit that calls `_extend(class_names, ...)` after one of the first two
branches would corrupt the fold's output for every other call site. Noted here
because it is silent and would only surface as cross-call-site contamination.

**Widening `elif isinstance(call.func, ast.Attribute)`** (dropping the old
`and isinstance(call.func.value, ast.Name)`) is safe: any receiver matching none
of the three inner branches leaves `class_names == []`, so
`_resolution([]) == {"kind": "unresolved"}` — identical to the initial value.
`pkg.helpers.helper()`, `this.attr.method()`, `obj.get().m()`, and `a().b().c()`
all stay `unresolved`.

### Behavior matrix (delta rows only; prior rows unchanged)

| Call shape | Receiver node | Source | Result |
|---|---|---|---|
| `x.method()` after `x: Route4` (no value) | `Name` | annotation | `resolved` |
| `x.method()` after `x: Route4 = Route4()` | `Name` | annotation only (RHS ignored) | `resolved` |
| `r.method()` in `def f(r: Route4)` | `Name` | param annotation | `resolved` |
| `x.method()` after `x: "Route4"` / `Optional[Route4]` / `Unknown` | `Name` | no binding | `unresolved` |
| `self.route.go()` with `self.route = Route4()` in another method | `Attribute` (`self`) | `attribute_classes` | `resolved` |
| same, but `A()` in one method and `B()` in another | `Attribute` (`self`) | 2 names | `ambiguous` |
| same, but `Route4()` in two methods | `Attribute` (`self`) | deduped to 1 | `resolved` |
| `this.attr.go()` (`def m(this, ...)`) | `Attribute` (not `self`) | no branch | `unresolved` |
| `self.attr.go()` inside `@staticmethod def m(self)` | `Attribute` | not in `self_scopes` | `unresolved` |
| `get_route().go()` with `-> Route4` | `Call` | annotation | `resolved` |
| `get_route().go()` with `return Route4()` | `Call` | body inference | `resolved` |
| `get_route().go()` with `return A()` / `return B()` | `Call` | 2 names | `ambiguous` |
| `get_route().go()` with `return self.attr` (attr known) | `Call` | slice 2 table | `resolved` |
| `a().go()` with `def a(): return b()` / `def b(): return a()` | `Call` | fixed point, 1 pass | `unresolved` |
| `a().go()` with bare `return` / `return 1` / `return [X()]` | `Call` | no contribution | `unresolved` |
| `a().b().c()` | `Call` over `Attribute` func | no branch | `unresolved` |
| `self.factory().go()` | `Call` over `Attribute` func | no branch | `unresolved` |

## `_resolution()` — confirmed zero changes

Verified against every path above: each of the three receiver branches funnels
into the *same* flat `candidates: list[str]` and a *single* `_resolution(candidates)`
call. Zero candidates → `unresolved`; one → `resolved`; many → `ambiguous` with
sorted candidates. No new ambiguity logic anywhere; the proposal's
ADR-mirroring commitment holds. **No proposal-scope violation found.**

The only reason this holds is the dedup discipline (`_extend` at every
accumulation site): `_resolution` sorts but does not deduplicate, so any missed
dedup would surface as a spurious `ambiguous`, not as a crash.

---

## Test surface — `test/unit/pythonAnalyzer.test.ts`

Sole test surface, unchanged rationale from the prior design:
`src/analysis/pythonAnalyzer.ts` is transport-only and `src/protocol.ts`'s
`resolved` / `ambiguous` / `unresolved` union already covers every outcome.
Existing `callAt(line)` helper convention reused.

### MANDATORY existing-test modification — easy to miss

`"leaves unsupported instance-binding shapes unresolved"` (line 132) currently
asserts lines `[11, 14, 18, 23, 27]` are `unresolved`. **Line 11 is
`self.route.get_info()` and line 14 is `factory().get_info()`** — slices 2 and 3
respectively make both `resolved`. This test **will fail** unless edited in the
same PR as each slice. The spec delta explicitly authorizes this
(it "replaces two `remains unresolved` scenarios"), but the change must be
deliberate: remove `11` in slice 2's PR, remove `14` in slice 3's PR, keeping
`[18, 23, 27]` (tuple target, non-constructor RHS, chained assignment) intact.

Note also that slice 3 makes line 14 resolve via *body inference*
(`def factory(): return Route()`), which is the exact shape already present in
that fixture — a small but genuine non-synthetic validation of slice 3.

### Slice 1 — new cases

1. `"resolves a call through a bare annotated variable"` —
   `class Route:\n    def go(self): pass\n\ndef run():\n    x: Route\n    return x.go()\n` → line 6 `resolved`.
2. `"resolves a call through an annotated variable with an assigned value"` —
   `x: Route = Route()` → `resolved`, and assert the RHS constructor call edge still
   exists (the `generic_visit` guard).
3. `"resolves a call through an annotated function parameter"` —
   `def run(r: Route):\n    return r.go()\n` → `resolved`.
4. `"leaves quoted, generic, and unknown annotations unresolved"` — one source with
   `x: "Route"`, `y: Optional[Route]`, `z: Unknown`, each followed by `.go()` →
   all three `unresolved`.
5. `"does not bind starred or keyword-collector parameter annotations"` —
   `def run(*args: Route, **kw: Route):\n    args.go()\n    kw.go()\n` → both
   `unresolved`.

### Slice 2 — new cases

6. `"resolves a self-attribute call assigned in another method of the same class"` —
   `__init__` assigns `self.route = Route()`, `run` calls `self.route.go()` → `resolved`.
7. `"resolves a self-attribute call bound by an attribute annotation"` —
   `self.route: Route` in `__init__` → `resolved`.
8. `"reports ambiguous candidates for a self-attribute bound to different classes"` —
   `A()` in one method, `B()` in another → `ambiguous` with both `go` ids sorted.
9. `"keeps a self-attribute assigned the same class in two methods resolved"` —
   the D5-equivalent dedup guard (`__init__` + `reset`, both `Route4()`) →
   `resolved`, **not** `ambiguous`.
10. `"leaves attribute calls unresolved for a receiver not named self"` —
    `def m(this):\n    this.attr = Route()` + `this.attr.go()` → `unresolved`.
11. `"leaves self-attribute calls unresolved in staticmethods and nested functions"` —
    one source with a `@staticmethod def m(self)` assigning `self.a = Route()`,
    and a nested `def inner(self)` inside a real method doing the same; both
    call sites `unresolved`.
12. `"does not merge a class-body variable with a same-named self attribute"` —
    the §2.3 collision guard: `class A:\n    x = Route()\n    def m(self):\n        self.x = Other()\n    def run(self):\n        return self.x.go()\n` → `resolved` to `Other.go`, not `ambiguous`.

### Slice 3 — new cases

13. `"resolves a chained call through an explicit return annotation"` →
    `def get_route() -> Route:` + `get_route().go()` → `resolved`.
14. `"resolves a chained call through an inferred constructor return"` →
    `def get_route():\n    return Route()` → `resolved`.
15. `"resolves a chained call through a returned self attribute"` →
    method returning `self.route` where `self.route = Route()` → `resolved`.
15b. `"resolves a chained call through a returned local variable"` →
    `def get_route():\n    r = Route()\n    return r` → `resolved` (the N10 amendment).
16. `"reports ambiguous candidates for a function returning different classes"` →
    `return A()` / `return B()` → `ambiguous`.
17. `"prefers an explicit return annotation over an inferred return body"` →
    `def f() -> Base:\n    return Derived()` → `resolved` to `Base.go`, not `ambiguous`.
18. `"ignores returns owned by a nested definition"` → the `_own_returns` guard:
    `def outer():\n    def inner():\n        return Route()\n    return 1\n` +
    `outer().go()` → `unresolved`.
19. `"terminates on mutually recursive returns with no base case"` — **the cycle
    guard test**:
    ```ts
    const started = Date.now();
    const graph = await analyze([{ path: "local.py", content: "class Route:\n    def go(self): pass\n\ndef a():\n    return b()\n\ndef b():\n    return a()\n\ndef use():\n    return a().go()\n" }]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(callAt(11)?.resolution).toEqual({ kind: "unresolved" });
    ```
    The bounded assertion is practical here because the harness already enforces
    a child-process timeout (`analyzePython`'s `timeoutMs`), so a genuine hang
    surfaces as a rejected promise rather than a hung suite — the elapsed-time
    assertion is a secondary signal, not the sole protection.
20. `"propagates a return class through a chain of forwarding functions"` — the
    fixed point's positive case: `def c(): return Route()`, `def b(): return c()`,
    `def a(): return b()`, then `a().go()` → `resolved`.
21. `"leaves chained calls unresolved for undecidable return expressions"` — bare
    `return`, `return 1`, `return [Route()]`, `return mod.Route()`, and
    `a().b().c()` → all `unresolved`.

## Data Flow

`openspec/config.yaml`'s `rules.design` requires sequence diagrams for the Git
comparison, diagram navigation, editing, and snippet execution flows. **None of
those four flows is touched** — this change is confined to a single pure function
inside the already-bridged analyzer subprocess. The relevant flow is the fold
dependency order, which is a strict DAG:

    FileVisitor walk (per file)
      local_bindings ──┐  attribute_bindings ──┐  return_annotations/names/attributes ──┐
                       │                       │                                        │
    analyze() folds    ▼                       ▼                                        ▼
      by_qualified_name ─→ alias_targets ─→ variable_classes ─→ attribute_classes ─→ function_return_classes
                                                                                          │
                                                                              fixed point ─┘ (bounded, monotone)
                                                                                          │
    resolution pass ──────────────────────────────────────────────────────────────────────▼
      call.func: Name ──────────────────→ _resolve_lexical
                 Attribute ─→ receiver: Name      ─→ variable_classes        ─┐
                              receiver: self.attr ─→ attribute_classes       ─┼→ by_qualified_name[f"{Class}.{attr}"] ─→ _resolution
                              receiver: Call      ─→ function_return_classes ─┘

The single back-edge risk (`function_return_classes` → `attribute_classes`) is
proven impossible in §3.4.

## Threat Matrix

**N/A** — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary changes. `python/analyzer.py`
runs in an already-established subprocess whose spawn, argument, timeout, and
output-bound handling are untouched; this change alters only pure in-process AST
analysis over content already delivered through the existing validated channel.

## Migration / Rollout

No migration. Each slice is independently revertible; reverting all three
restores the prior change's behavior exactly.

---

## Decisions (ADR)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| E1 | Annotation bindings reuse `local_bindings` / `variable_classes` unchanged | An annotation name and a constructor name are both "a bare name that should denote a class"; identical staging, identical fold, zero new structure | A separate `annotation_classes` map — duplicated fold with identical semantics |
| E2 | `AnnAssign` binds on the annotation only, ignoring the value | Annotation is authoritative; unioning both would make `x: A = B()` falsely `ambiguous` | Union annotation + RHS constructor |
| E3 | Parameter annotations handled in `visit_FunctionDef` via `_bind_signature` | No `visit_arg` dispatch exists that can see the owning scope, the receiver position, or decorators | A `visit_arg` method |
| E4 | Bind `posonlyargs + args + kwonlyargs`; exclude `vararg` / `kwarg` | `*args: T` types the elements, not the collection — binding it would be flatly wrong | Bind all parameters |
| E5 | Exclude the receiver `self` from parameter binding | Slice 2 owns the receiver; binding it would newly resolve `self.method()`, a behavior no spec scenario requests | Treat `self` as an ordinary annotated parameter |
| E6 | Enclosing class = `scope.rpartition(".")[0]`, gated on `self_scopes` | `self_scopes` already proves the parent is a class; a walk produces a false positive for a nested function with its own `self` (§2.2). Mirrors D8 | Outward walk over `class:`-prefixed ids |
| E7 | Separate `attribute_classes` map, not `variable_classes` | Class-scoped keys collide with class-body assignment keys (§2.3) | One shared map with class-qualified keys |
| E8 | Track `staticmethod` / `classmethod` bare-name decorators | Cheap, one clause; prevents a static method with a `self` parameter from binding class attributes | No decorator tracking (accepted gap for dotted/aliased decorators only) |
| E9 | `_own_returns` bounded traversal seeded from `node.body` | `ast.walk` attributes a nested definition's returns to the outer function | `ast.walk` with a post-filter |
| E10 | Return-class propagation by monotone fixed-point iteration, bound `N + 1` | Confluent (order-independent → deterministic output), provably terminating twice over, ~11 lines | SCC/topological pass (~40 lines, same result); bounded-depth DFS (order-dependent, non-deterministic) |
| E11 | Explicit `-> T` suppresses body inference entirely | An annotation is authoritative; unioning makes `def f() -> Base: return Derived()` falsely `ambiguous` | Union annotation with inferred returns |
| E12 | `attribute_classes` computed before `function_return_classes`; the reverse edge is impossible by construction | `_class_names`'s `class:` filter guarantees `self.attr = get_route()` produces no binding, so the fold DAG is acyclic (§3.4) | Interleaving the two folds |
| E13 | `_class_names` / `_extend` extracted from the current fold | Same behavior-preserving extraction precedent as D2; three slices need the identical class-filter + dedup logic | Copy the loop three times |
| E14 | `_resolution()` unchanged | Every path funnels into one flat candidate list; confirmed exhaustively | Any change (would be a proposal-scope violation) |

---

## Risks and open assumptions — NEW findings from this design phase

Beyond the exploration's and proposal's risk tables:

| # | New finding | Severity | Handling |
|---|---|---|---|
| N1 | **Class-body / `self.attr` key collision.** Folding `self.attr` bindings into `variable_classes` with a class-qualified key silently merges with a class-body assignment's own binding (`class A: x = Route()` + `self.x = Other()`), producing a false `ambiguous` | High if missed | E7 — separate `attribute_classes` map; test 12 is the explicit guard |
| N2 | **Outward class walk false positive.** A nested function declaring its own `self` parameter inside a method would have its `self.attr = ...` attributed to the outer class by the proposal's sketched walk | High if missed | E6 — single-step derivation gated on `self_scopes`; test 11 is the guard |
| N3 | **Existing test 132 will fail on slices 2 and 3.** Lines 11 and 14 of its fixture are exactly the shapes those slices resolve. Not a regression, but an unavoidable in-PR edit that is easy to overlook and easy to "fix" wrongly by weakening the whole assertion | High if missed | Named explicitly; remove only the one line per slice, keep `[18, 23, 27]` |
| N4 | **`*args: T` / `**kw: T` would bind the collection to the element type.** A naive "iterate all parameters" implementation is silently wrong | Medium | E4; test 5 is the guard |
| N5 | **`ast.walk` over a function body captures nested definitions' returns.** The direct analogue of the prior design's `generic_visit` trap, in a different guise | High if missed | E9; test 18 is the guard |
| N6 | **Annotation + body union manufactures false ambiguity.** `def f() -> Base: return Derived()` is correct, idiomatic code that a naive union reports as `ambiguous` | Medium | E11; test 17 is the guard |
| N7 | **`generic_visit` in `visit_AnnAssign`.** The D7 trap recurs verbatim for the new visitor: omitting it drops the RHS call edge of `x: T = Route()` | High if missed | §1.1; test 2 asserts the RHS edge survives |
| N8 | **Aliasing hazard in the combined resolution branch.** `class_names` is sometimes a reference into a fold's stored list and sometimes a fresh list; a future `_extend` after the first two branches would corrupt shared state across call sites | Medium (latent) | Documented inline in §"full combined branch"; branches are currently exclusive |
| N9 | **Fixed-point worst case is O(N²) in forwarding-chain depth.** A pathological chain of N forwarding functions with a class at the tail needs N passes over N edges. Typical real code has depth ≤ 2–3 and terminates in 2 passes; the early `break` makes the common case cheap, but a generated/very large snapshot could be slow | Low-Medium | Accepted and documented; the child-process timeout in `analyzePython` is the outer safety net. Test 20 exercises a 3-deep chain |
| N10 | **`return local_var`, confirmed IN SCOPE by the user.** `def f():\n    r = Route()\n    return r` — `variable_classes` already holds the answer under `f"{scope}.{var}"`; one new `elif` (`return_locals`) covers it with no new fold edge and no change to the acyclicity proof (it reads `variable_classes`, already built earlier in the same order) | Resolved | §3.2/§3.4 amendment; new test 15b |
| N11 | **Only one chaining hop is supported at the call site.** `a().b().c()` and `self.factory().go()` stay `unresolved`; the fixed point chains return types *between functions*, not chained attribute access at a single call site | Low | Documented; test 21 pins the behavior |
| N12 | **`@builtins.staticmethod` / aliased decorators are not detected.** Only bare `ast.Name` decorators are checked | Low | Accepted gap, named in §2.1 |
| N13 | **Inherited methods are still not resolved.** `by_qualified_name.get(f"{class}.{attr}")` performs no MRO walk, so a `self.attr.method()` where `method` is defined on a base class resolves as `unresolved`. Pre-existing, but slices 2–3 make it far more reachable in practice | Medium | Pre-existing limitation, out of scope; flagged because this change increases its visibility |

---

## PR slicing recommendation

**Three chained PRs, one per slice.** Slice 1 is a hard prerequisite (it
introduces `_bind_signature`, `_bind_target`, and the `_class_names` extraction
that 2 and 3 both consume); slice 2 is a hard prerequisite for slice 3's
`return self.attr` case and its `attribute_classes` read.

`Decision needed before apply: Yes` · `Chained PRs recommended: Yes` ·
`400-line budget risk: Low per slice, Medium if merged into one PR`

| Slice | `python/analyzer.py` | `test/unit/pythonAnalyzer.test.ts` | Total changed | Budget |
|---|---|---|---|---|
| 1 — Annotations | ~+26 / −7 (`visit_AnnAssign`, `_bind_target`, `_bind_signature`, `_class_names`/`_extend` extraction, 2 visitor delegations) | ~+32 (5 cases) | **~65** | Well inside |
| 2 — `self.attr` | ~+18 (`self_scopes`, `attribute_bindings`, decorator/receiver clause, `_bind_target` elif, `attribute_classes` fold, resolution elif) | ~+40 (7 cases) / −1 (test 132 edit) | **~59** | Well inside |
| 3 — Chained/returned | ~+52 (`_own_returns`, 3 lists, `_bind_signature` returns block, 2 folds, fixed point, resolution elif) | ~+55 (9 cases) / −1 (test 132 edit) | **~108** | Inside |
| **Aggregate** | ~+96 / −7 | ~+127 / −2 | **~232** | — |

Aggregate is under 400, so a single PR is technically permissible — but it is the
wrong call here. Slice 3 carries the fixed point, the bounded traversal, and the
annotation-precedence rule (N5, N6, N9, plus the cycle-guard test), and folding it
in with two mechanical pattern-matching slices would bury the only genuinely
novel algorithm in the change under routine diff. Each slice is separately
functional, separately testable, and separately revertible — exactly the
proposal's stated rollback plan.

Chain: PR #1 → feature branch; PR #2 → PR #1's branch; PR #3 → PR #2's branch.

## Open Questions

- [x] N10 (`return local_var`) — confirmed with the user: folded into slice 3 now
      (§3.1/§3.4 amendment), not deferred. None remaining.
