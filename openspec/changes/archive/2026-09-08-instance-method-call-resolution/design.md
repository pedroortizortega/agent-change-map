# Design: Resolve Instance Method Calls

## Scope of this design

Exactly the proposal's Approach 1: `x = ClassName(...)` then `x.method()` in the
**same lexical scope**. Branch reassignment across different classes resolves as
`ambiguous` through the existing `_resolution()` helper. No new ambiguity code.

All line references are against `python/analyzer.py` as of this change's baseline
(248 lines).

## Architecture

The analyzer is a three-stage pipeline, and this change adds exactly one datum to
each stage — no new pass, no new traversal, no new module:

| Stage | Existing artifact | New artifact |
|-------|-------------------|--------------|
| 1. Per-file AST walk (`FileVisitor`) | `import_aliases: list[tuple[str, str, str]]` | `local_bindings: list[tuple[str, str, str]]` |
| 2. Global fold in `analyze()` | `alias_targets: dict[str, list[str]]` | `variable_classes: dict[str, list[str]]` |
| 3. Pass-2 call resolution | `if isinstance(call.func, ast.Name)` | `elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)` |

The design principle is **structural mirroring of `import_aliases`**: the new
binding table has the same tuple shape, the same scope key, is collected in the
same visitor pass, and is folded into a `dict[str, list[str]]` with the same
`f"{scope}.{name}"` key shape. A reader who understands `import_aliases`
understands `local_bindings` with no additional concepts.

---

## 1. `FileVisitor.visit_Assign`

### Data structure

`ast.Assign` is `Assign(targets: list[expr], value: expr, type_comment)`. The
match must be strict on all four conditions below.

Declaration — in `FileVisitor.__init__`, immediately after the existing line 59
(`self.import_aliases: list[tuple[str, str, str]] = []`):

```python
        self.local_bindings: list[tuple[str, str, str]] = []
```

Exact 3-tuple semantics, mirroring `import_aliases`'
`(scope, local_name, target_qualified_name)`:

`(scope, var, constructor_name)` where

- `scope` = `self.current_qualified_name` at the assignment statement,
- `var` = the bare target name,
- `constructor_name` = the constructor callee **as written in source**
  (e.g. `"Route4"`), **not** a qualified name and **not** a node id.

This raw-name storage is deliberate and matches `import_aliases`' own staging
discipline: `visit_ImportFrom` (line 106) stores `alias.asname or alias.name` —
the local name as written — and defers resolution to `analyze()`'s later fold at
line 179. The visitor has no access to `by_qualified_name` or `alias_targets`
(neither exists until after every file has been walked), so resolution here is
not merely undesirable, it is impossible.

### Method

Placed after `visit_ImportFrom`/`_from_import_base` and before `visit_Call`
(i.e. between current lines 121 and 123), keeping visitor methods in AST-node
grouping order:

```python
    def visit_Assign(self, node: ast.Assign) -> None:
        """Bind `var = ClassName(...)` for the current scope; every other assignment shape is ignored."""
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
            self.local_bindings.append((self.current_qualified_name, node.targets[0].id, node.value.func.id))
        self.generic_visit(node)
```

The four conditions and what each excludes:

| Condition | Excludes |
|-----------|----------|
| `len(node.targets) == 1` | chained assignment `x = y = ClassName()` |
| `isinstance(node.targets[0], ast.Name)` | `a, b = ...` (`ast.Tuple`), `*a, b = ...` (`ast.Starred`), `self.attr = ...` / `obj.x = ...` (`ast.Attribute`), `d[k] = ...` (`ast.Subscript`) |
| `isinstance(node.value, ast.Call)` | `x = other_var` (`ast.Name`), `x = [ClassName()]`, literals |
| `isinstance(node.value.func, ast.Name)` | `x = mod.ClassName()` / `x = self.factory()` (`ast.Attribute`), `x = table[k]()` (`ast.Subscript`) |

Not `ast.Assign` at all, therefore untouched by construction: `x: Route4 = Route4()`
(`ast.AnnAssign`), `x := ClassName()` (`ast.NamedExpr`), `for x in ...`
(`ast.For`), `with ... as x` (`ast.withitem`), `x += ClassName()` (`ast.AugAssign`).

### `generic_visit` is MANDATORY, not optional — verified `ast.NodeVisitor` semantics

`ast.NodeVisitor.visit()` dispatches to `getattr(self, "visit_" + node.__class__.__name__, self.generic_visit)`.
`generic_visit` is the **fallback when no specific visitor exists**; it is *not*
invoked in addition to a specific visitor.

The exploration's claim that "a `Call` on the RHS is still recorded via
`generic_visit`" is **correct for today's code and only because `visit_Assign`
does not exist**: today `visit(Assign)` finds no `visit_Assign`, falls back to
`generic_visit(Assign)`, which recurses into `node.value` and reaches
`visit_Call`.

The moment `visit_Assign` is defined, that automatic fallback disappears for
`Assign` nodes. Omitting `self.generic_visit(node)` would silently **stop
recording the constructor call itself** (`Route4()` would produce no call edge)
and would drop every nested call inside any assignment's RHS — a regression in
existing, tested behavior, not a new-feature gap. The explicit call is therefore
a correctness requirement, and it must be **unconditional** (outside the `if`),
so ignored assignment shapes still have their subexpressions walked.

This matches the two existing precedents in the file: `visit_Call` (line 126)
and `add_definition` (line 78) both call `self.generic_visit(node)` explicitly.
`visit_Import`/`visit_ImportFrom` deliberately do not, because those nodes have
no call-bearing children.

Consequence to state explicitly: `x = Route4()` continues to emit a `call` edge
resolved to the *class* `Route4` via the existing `ast.Name` branch. That edge is
unchanged by this design; the new edge is the separate one for `x.method()`.

---

## 2. Building `variable_classes` in `analyze()`

### Precedent being mirrored (current lines 170–179)

```python
    by_qualified_name: dict[str, list[str]] = {}
    for node in nodes:
        by_qualified_name.setdefault(node["qualifiedName"], []).append(node["id"])

    alias_targets: dict[str, list[str]] = {}
    for visitor in visitors:
        for edge, qualified_name in visitor.from_imports:
            edge["resolution"] = _resolution(by_qualified_name.get(qualified_name, []))
        for scope, local_name, target_qualified_name in visitor.import_aliases:
            alias_targets.setdefault(f"{scope}.{local_name}", []).extend(by_qualified_name.get(target_qualified_name, []))
```

Note the value type: `by_qualified_name` and `alias_targets` both map to lists of
**node ids** (`"class:pkg.mod.Route4@120"`), not qualified names.

### Decision: `_resolve_lexical` must be reused, via a small extracted helper

A direct `by_qualified_name` / `alias_targets` lookup is **not** sufficient. The
constructor name is written unqualified (`Route4`) and may be bound by any of:
a class defined in the same scope, a class defined in an enclosing scope, a
module-level class referenced from a nested function, or a `from ... import`
alias. Only `_resolve_lexical`'s outward scope walk — including its deliberate
class-scope skip at lines 200–202 — covers all of these, and reusing it
guarantees the binding resolves to exactly the same entity the analyzer already
resolves the `Route4()` constructor call itself to. Any divergence between those
two would be a latent inconsistency.

But `_resolve_lexical` returns a resolution *dict*, while the fold needs a
*candidate list*. Extract the list-producing core, leaving `_resolve_lexical` a
one-line wrapper. This is provably behavior-preserving: the old function returned
`_resolution(candidates)` on the first non-empty hit and `{"kind": "unresolved"}`
otherwise, and `_resolution([])` already returns exactly `{"kind": "unresolved"}`
(line 212).

```python
def _lexical_candidates(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]]) -> list[str]:
    current = scope
    while True:
        candidates = symbols.get(f"{current}.{name}", []) + aliases.get(f"{current}.{name}", [])
        if candidates:
            return candidates
        if current == module:
            break
        current = current.rpartition(".")[0]
        # Class attributes are not lexical bindings inside method bodies.
        if current and symbols.get(current, [""])[0].startswith("class:"):
            current = current.rpartition(".")[0]
    return []


def _resolve_lexical(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]]) -> dict[str, Any]:
    return _resolution(_lexical_candidates(name, scope, module, symbols, aliases))
```

### The fold

Add an id→name index next to `by_qualified_name` (after line 172):

```python
    qualified_by_id: dict[str, str] = {node["id"]: node["qualifiedName"] for node in nodes}
```

Then, as a **separate loop placed after the `alias_targets` loop has fully
completed** (i.e. between current lines 179 and 181):

```python
    variable_classes: dict[str, list[str]] = {}
    for visitor in visitors:
        for scope, var, constructor in visitor.local_bindings:
            class_names: list[str] = []
            for identifier in _lexical_candidates(constructor, scope, visitor.module, by_qualified_name, alias_targets):
                if not identifier.startswith("class:"):
                    continue
                name = qualified_by_id[identifier]
                if name not in class_names:
                    class_names.append(name)
            if not class_names:
                continue
            bound = variable_classes.setdefault(f"{scope}.{var}", [])
            bound.extend(name for name in class_names if name not in bound)
```

Four decisions encoded here, each load-bearing:

**(a) Separate loop, not folded into the `alias_targets` loop.** `_lexical_candidates`
reads `alias_targets`; folding bindings inside the same loop would resolve
visitor *N*'s bindings against a partially built alias map. Scope keys are
module-prefixed so cross-visitor collision is impossible in practice, but
depending on that is a fragile invariant. A separate loop makes the dependency
unconditional and obvious.

**(b) Values are qualified class *names*, not node ids.** The consumer looks up
`f"{Class}.{attr}"` in `by_qualified_name`, which is keyed by qualified name.
Hence the `qualified_by_id` index. The direct index (not `.get`) is intentional:
every id in `by_qualified_name` and `alias_targets` originates from `nodes`, so a
`KeyError` here would signal a broken invariant and should not be swallowed.

**(c) `class:` prefix filter.** The id format is `f"{kind}:{qualified_name}@{start_byte}"`
(`entity_id`, lines 13–15), and the file already relies on this prefix test at
line 201. Without the filter, `x = factory()` where `factory` is a function
resolves to `pkg.mod.factory`, and a *nested function* `def method()` inside
`factory` would make `pkg.mod.factory.method` a real node — producing a false
`resolved` edge for `x.method()`. The filter makes the spec's "non-constructor
right-hand side remains unresolved" scenario true by construction rather than by
luck.

**(d) Deduplication is MANDATORY and lives at the qualified-name level.**
`_resolution` (lines 206–212) sorts but does **not** deduplicate; it branches
purely on `len(ordered)`. So a duplicated candidate would be reported as
`ambiguous` with two identical entries. This is a real, reachable bug:

```python
def run(flag):
    x = Route()          # binding 1
    if flag:
        x = Route()      # binding 2 — legal Python, same class
    return x.get_info()  # must be resolved, NOT ambiguous
```

Two dedup barriers exist and both are needed:

- *Within one binding*: `if name not in class_names` collapses the case where a
  class qualified name is genuinely defined twice in the file — both ids map to
  the same qualified name, so the class contributes one name, and the downstream
  `by_qualified_name` lookup then legitimately returns two method ids →
  `ambiguous`. That is the correct answer for a genuinely duplicated class.
- *Across bindings*: `if name not in bound` collapses repeated assignments of the
  same class to the same `(scope, var)`.

With names deduped and `by_qualified_name` values already distinct per key, the
final union is duplicate-free, so `_resolution` never sees a spurious length > 1.

**Zero / one / many candidates:**

- **Zero** (unknown class, non-class resolution, or unresolvable name): `continue`
  — the key is never created. Preferred over folding an empty list so
  `variable_classes` contains only meaningful bindings; behaviorally identical
  since `.get(key, [])` yields `[]` either way, but it keeps the map honest for
  debugging and avoids an entry that can never contribute.
- **One**: single class name → single method lookup → `resolved` (or `unresolved`
  if the method does not exist).
- **Many** (branch reassignment, or a duplicated class definition): accumulated;
  the union of all classes' matching methods drives `_resolution` → `ambiguous`.

---

## 3. The resolution branch

Current lines 181–186 become:

```python
    for visitor in visitors:
        for source_id, scope, call in visitor.calls:
            resolution: dict[str, Any] = {"kind": "unresolved"}
            if isinstance(call.func, ast.Name):
                resolution = _resolve_lexical(call.func.id, scope, visitor.module, by_qualified_name, alias_targets)
            elif isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name):
                candidates: list[str] = []
                for class_name in variable_classes.get(f"{scope}.{call.func.value.id}", []):
                    candidates.extend(by_qualified_name.get(f"{class_name}.{call.func.attr}", []))
                resolution = _resolution(candidates)
            edges.append({"kind": "call", "source": source_id, "resolution": resolution, "span": visitor.source.span(call)})
```

Union semantics, explicitly: **one flat list**, extended once per bound class,
passed once to `_resolution`. `_resolution` sorts and branches on length — 1 →
`resolved`, >1 → `ambiguous` with sorted candidates, 0 → `unresolved`. No new
ambiguity logic anywhere.

Behavior matrix:

| Call shape | `call.func.value` | `variable_classes` hit | Result |
|---|---|---|---|
| `x.method()` with `x = A()` | `Name` | `["m.A"]` | `resolved` |
| `x.method()` with `x = A()` / `x = B()` | `Name` | `["m.A", "m.B"]` | `ambiguous`, both methods |
| `x.method()` with `x = A()` twice | `Name` | `["m.A"]` (deduped) | `resolved` |
| `x.missing()` with `x = A()` | `Name` | `["m.A"]`, lookup empty | `unresolved` |
| `x.method()` with `x = Unknown()` | `Name` | miss (no key) | `unresolved` |
| `self.method()` | `Name` (`self`) | miss — `self` is never bound | `unresolved`, unchanged |
| `self.attr.method()` | `Attribute` | branch not taken | `unresolved`, unchanged |
| `get_route().method()` | `Call` | branch not taken | `unresolved`, unchanged |
| `pkg.helpers.helper()` | `Attribute` | branch not taken | `unresolved`, unchanged |
| `helpers.helper()` | `Name` | miss (module, not a class binding) | `unresolved`, unchanged |
| `obj.dynamic()` (existing test) | `Name` | miss | `unresolved`, unchanged |

Scope isolation is exact: the lookup key is `f"{scope}.{var}"` using the *call
site's own* scope from `visitor.calls`, and the binding key uses the *assignment's*
scope. No outward walk is performed for bindings, so a variable bound in one
function is invisible in another — including a same-named parameter in a sibling
function. This is intentional and matches the proposal's "same lexical scope"
constraint; an outward walk would require closure/shadowing analysis this
analyzer does not have.

---

## 4. Test surface

### Harness relationship (verified, not assumed)

`src/analysis/pythonAnalyzer.ts` is a **pure transport passthrough**: it validates
the request with `analyzeRequestSchema`, spawns `python3 python/analyzer.py`,
enforces timeout/output caps, and parses the response through
`analysisGraphSchema`. It contains **zero resolution logic**, so it needs no new
case for this change.

`test/unit/pythonAnalyzer.test.ts` imports `analyzePython` and therefore executes
the **real Python analyzer as a child process** over in-memory file contents
(`analyze(files)` helper, lines 10–11). It is the **sole test surface** for this
change. No fixture files on disk, no TypeScript source changes, no webview
changes, no `src/protocol.ts` change (`resolved` / `ambiguous` / `unresolved`
already cover every outcome).

### Edge selection convention for new tests

`x = Route()` itself emits a `call` edge (resolved to the class). New tests must
therefore select the `.method()` edge by **`span.startLine`**, not by
`edges.find(kind === "call")`, which would grab the constructor edge. Recommended
local helper inside each test:

```ts
const callAt = (line: number) => graph.edges.find((edge) => edge.kind === "call" && edge.span.startLine === line);
```

### New test cases (titles and sources)

1. **`"resolves a call through a locally constructed instance variable"`**
   ```ts
   [{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run():\n    route = Route()\n    return route.get_info()\n" }]
   ```
   Assert `callAt(6)?.resolution` equals `{ kind: "resolved", target: <id of local.Route.get_info> }`.

2. **`"reports ambiguous candidates when an instance variable is reassigned across branches"`**
   ```ts
   [{ path: "local.py", content: "class A:\n    def go(self): pass\n\nclass B:\n    def go(self): pass\n\ndef run(flag):\n    if flag:\n        x = A()\n    else:\n        x = B()\n    return x.go()\n" }]
   ```
   Assert `callAt(12)?.resolution` equals `{ kind: "ambiguous", candidates: [<local.A.go>, <local.B.go>].sort() }`.

3. **`"keeps repeated assignment of the same class resolved rather than ambiguous"`** — the dedup guard
   ```ts
   [{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run(flag):\n    x = Route()\n    if flag:\n        x = Route()\n    return x.get_info()\n" }]
   ```
   Assert `callAt(8)?.resolution.kind` is `"resolved"`.

4. **`"leaves instance calls unresolved when the constructor class is unknown"`**
   ```ts
   [{ path: "local.py", content: "def run():\n    x = Unknown()\n    return x.method()\n" }]
   ```
   Assert `callAt(3)?.resolution` equals `{ kind: "unresolved" }`.

5. **`"leaves instance calls unresolved when the bound class has no matching method"`**
   ```ts
   [{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef run():\n    route = Route()\n    return route.missing()\n" }]
   ```
   Assert `callAt(6)?.resolution` equals `{ kind: "unresolved" }`.

6. **`"leaves unsupported instance-binding shapes unresolved"`** — one test covering
   every negative shape the spec and the proposal's risk table require
   ```ts
   [{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef factory():\n    return Route()\n\nclass Holder:\n    def __init__(self):\n        self.route = Route()\n    def run(self):\n        return self.route.get_info()\n\ndef chained():\n    return factory().get_info()\n\ndef tupled():\n    a, b = Route(), Route()\n    return a.get_info()\n\ndef rebound():\n    r = Route()\n    s = r\n    return s.get_info()\n\ndef chain_assigned():\n    p = q = Route()\n    return p.get_info()\n" }]
   ```
   Assert the resolution at each of the five `.get_info()` lines (11, 14, 18, 23, 27)
   is `{ kind: "unresolved" }` — covering `self.attr` propagation, chained/returned
   instances, tuple targets, non-constructor RHS, and chained assignment.

7. **`"scopes instance bindings to the assignment's own scope"`**
   ```ts
   [{ path: "local.py", content: "class Route:\n    def get_info(self): pass\n\ndef bind():\n    route = Route()\n\ndef other(route):\n    return route.get_info()\n" }]
   ```
   Assert `callAt(8)?.resolution` equals `{ kind: "unresolved" }` — no cross-scope leak.

8. **`"resolves instance calls to a class bound by a from-import"`** — mirrors the
   real `test/app.py` shape from the proposal's success criteria
   ```ts
   [
     { path: "pkg/__init__.py", content: "" },
     { path: "pkg/routes.py", content: "class Route4:\n    def get_info(self): pass\n" },
     { path: "pkg/app.py", content: "from pkg.routes import Route4\n\nclass Main:\n    def run(self):\n        instance = Route4()\n        print(instance.get_info())\n" },
   ]
   ```
   Assert the `pkg/app.py` line-6 call edge resolves to `pkg.routes.Route4.get_info`.
   This exercises alias resolution plus the class-scope skip in the outward walk
   (scope `pkg.app.Main.run` → skip `pkg.app.Main` → hit alias at `pkg.app`).

### Regression guard

The existing test at line 17 asserts `obj.dynamic()` stays among the unresolved
call kinds. `obj` is never bound, so it still misses `variable_classes` and stays
`unresolved`. No existing assertion changes.

---

## 5. Dual-compilation / cross-language note

**Confirmed pure Python.** The only production file changed is
`python/analyzer.py`. Verified by reading:

- `src/analysis/pythonAnalyzer.ts` — transport only (spawn, timeout, output
  bounds, schema parse). No resolution knowledge. **No new case needed**; its
  existing tests (absolute-root rejection, timeout, stdout/stderr bounds) are
  orthogonal to resolution semantics.
- `src/protocol.ts` — the `resolved` / `ambiguous` / `unresolved` union already
  carries every outcome this change can produce; `analysisGraphSchema.parse`
  accepts the new resolutions unchanged.
- No `webview/` surface is involved; the graph consumes `resolution.kind`
  generically.

`test/unit/pythonAnalyzer.test.ts` is therefore the **sole** test surface, and it
tests the real Python behavior end-to-end through the bridge, so no separate
Python-level test runner is introduced.

---

## Decisions (ADR)

### D1 — Store the raw constructor name in the visitor, resolve in `analyze()`
**Chosen** because the visitor has no access to `by_qualified_name` or
`alias_targets` (neither exists until all files are walked), and because it
mirrors `import_aliases`' identical staging.
**Rejected:** resolving inside `visit_Assign` — impossible without a cross-file
symbol table at walk time.

### D2 — Reuse `_lexical_candidates` (extracted from `_resolve_lexical`) for constructor resolution
**Chosen** so the binding resolves to exactly the entity the analyzer already
resolves the `ClassName()` constructor call to, including alias and class-scope-skip
semantics. Extraction is provably behavior-preserving (`_resolution([])` is
already the unresolved case).
**Rejected:** a direct `by_qualified_name`/`alias_targets` lookup — would miss
enclosing-scope classes and would diverge from the constructor call's own
resolution. **Rejected:** unpacking `_resolve_lexical`'s dict back into a
candidate list — three lines of shape-sniffing conditionals that reintroduce
resolution semantics at the call site.

### D3 — `variable_classes` values are qualified class names, not node ids
**Chosen** because the downstream lookup key is `f"{Class}.{attr}"` against
`by_qualified_name`. Requires the small `qualified_by_id` index.
**Rejected:** storing ids and re-deriving names at lookup time — same index
needed, but recomputed per call site.

### D4 — Filter candidates to `class:`-prefixed ids
**Chosen** so non-constructor right-hand sides cannot produce false edges via
nested-function qualified names. Uses the prefix convention the file already
relies on at line 201.
**Rejected:** trusting `_lexical_candidates` blindly — reachable false-positive.

### D5 — Deduplicate at the qualified-name level, in both the per-binding and cross-binding folds
**Chosen** because `_resolution` branches on `len()` without deduplicating, so a
repeated `x = Route()` would otherwise be misreported as `ambiguous`.
**Rejected:** deduplicating inside `_resolution` — changes shared behavior used
by import and direct-call resolution, out of scope and higher blast radius.
**Rejected:** deduplicating at lookup time in the `elif` — recomputed per call
site instead of once per binding.

### D6 — Skip the fold entirely when zero class candidates resolve
**Chosen** so `variable_classes` contains only meaningful bindings. Behaviorally
identical to folding an empty list (`.get(key, [])`), but avoids inert entries.

### D7 — Unconditional `self.generic_visit(node)` in `visit_Assign`
**Chosen** because defining `visit_Assign` removes `ast.NodeVisitor`'s automatic
`generic_visit` fallback for `Assign` nodes; omitting it would drop the
constructor call edge and every nested call in any assignment RHS — a regression,
not a gap. Unconditional placement keeps ignored assignment shapes traversed.

### D8 — No outward scope walk for variable bindings
**Chosen:** exact `f"{scope}.{var}"` match only. Matches the proposal's
"same lexical scope" constraint and prevents false edges from shadowed or
same-named variables in sibling scopes.
**Rejected:** walking outward like `_resolve_lexical` — would require closure and
shadowing analysis that does not exist here, and would produce edges the source
does not support.

---

## Risks and open assumptions

| Risk | Severity | Handling |
|------|----------|----------|
| `_resolution` does not deduplicate; duplicate candidates would misreport `ambiguous` | High if missed | D5 dedup at both fold levels; test case 3 is the explicit guard |
| Forgetting `generic_visit` silently removes existing constructor call edges | High if missed | D7; existing test at line 17 partially covers, test case 6 exercises assignment-heavy source |
| `qualified_by_id[identifier]` KeyError | Low | Every id originates from `nodes`; direct index chosen deliberately so an invariant break surfaces loudly |
| Fold placed inside the `alias_targets` loop would read a partial alias map | Medium | D2/(a): separate loop after that loop completes |
| Flow-insensitivity: `x = A()` after `x.go()` in the same scope still binds | Accepted | Documented limitation; the analyzer has no CFG. Over-reports rather than under-reports, consistent with `ambiguous` semantics |
| `AnnAssign` (`x: Route = Route()`) is not `ast.Assign` and stays unresolved | Accepted | Explicitly out of scope (Approach 2, deferred follow-up) |
| Scope creep into annotation typing | Medium | Out-of-scope list in proposal and spec; no `AnnAssign` handling in this design |

---

## PR slicing recommendation

**Single PR.** Estimated diff against this repo's ~400-line review budget:

| File | Added | Removed |
|------|-------|---------|
| `python/analyzer.py` — `local_bindings` init | 1 | 0 |
| `python/analyzer.py` — `visit_Assign` | 5 | 0 |
| `python/analyzer.py` — `qualified_by_id` | 1 | 0 |
| `python/analyzer.py` — `variable_classes` fold | 13 | 0 |
| `python/analyzer.py` — resolution `elif` | 5 | 0 |
| `python/analyzer.py` — `_lexical_candidates` extraction | ~14 | ~12 |
| `test/unit/pythonAnalyzer.test.ts` — 8 new cases | ~70 | 0 |
| **Total** | **~109** | **~12** |

Roughly 120 changed lines — comfortably inside one review budget, and splitting
would be actively harmful: the visitor, the fold, and the `elif` are a single
non-functional-until-complete unit (bindings collected but never consumed, or a
consumer with no data), so a split PR would ship dead code with no test able to
prove it. Tests ship in the same PR as the behavior they assert.
