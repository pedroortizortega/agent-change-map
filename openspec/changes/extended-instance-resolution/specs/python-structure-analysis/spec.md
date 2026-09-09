# Delta for Python Structure Analysis

## MODIFIED Requirements

### Requirement: Represent call uncertainty

The system MUST report syntactically observed calls. It MUST distinguish uniquely resolved targets, multiple candidate targets, and unresolved dynamic calls, and MUST NOT present inferred candidates as certain.

Calls made through an instance variable (`ast.Attribute` over an `ast.Name` value) MUST be resolved using the same `resolved` / `ambiguous` / `unresolved` contract as direct name calls, when the variable was bound to a class by any of: a constructor-call assignment (`x = ClassName(...)`) in the same lexical scope as the call; a bare-`Name` type annotation on an `AnnAssign` target (`x: ClassName`, with or without a value) or on a function parameter (`def f(r: ClassName)`), resolved the same way as a constructor binding; or a class-scoped `self.attr = ClassName(...)` / `self.attr: ClassName` binding, resolved at any `self.attr.method()` call site inside the same class, not only the assigning method. A call whose receiver is itself a call expression (`get_route().method()`) MUST resolve through that inner call's function: an explicit `-> ClassName` return annotation, or a recursively inferred return-body class (`return ClassName(...)`, `return self.attr` where `self.attr`'s class is already known, or `return local_var` where `local_var`'s class is already known from an in-scope binding), guarded against infinite recursion on self-referential returns. A binding, annotation, or return type resolving to more than one class across branches, methods, or `return` statements MUST resolve as `ambiguous` with candidates drawn from all matching methods, rather than being dropped or downgraded to `unresolved`. Quoted or generic annotation forms (`"ClassName"`, `Optional[ClassName]`), an annotation or return type naming an unresolvable class, a non-constructor right-hand side, a tuple/multi-assignment target, an attribute receiver bound through a parameter not literally named `self`, and a return type that is empty, too complex to evaluate, or self-referential with no base case MUST all continue to resolve as `unresolved`, never crashing or looping.

(Previously: only direct `x = ClassName()` same-scope constructor bindings resolved; `self.attr` access and chained/returned-instance calls always resolved as `unresolved` regardless of shape.)

#### Scenario: Resolve a direct call

- GIVEN a call with one statically identifiable in-scope target
- WHEN analysis is requested
- THEN the call identifies that target and its call-site span as resolved

#### Scenario: Analyze a dynamic call

- GIVEN a call whose runtime target is not statically knowable
- WHEN analysis is requested
- THEN the call is marked ambiguous or unresolved, includes available candidates if any, and retains its call-site evidence

#### Scenario: Resolve a call through a locally constructed instance

- GIVEN a scope containing `x = ClassName()` followed by `x.method()` in that same scope, where `ClassName` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `ClassName.method`

#### Scenario: Instance variable reassigned to different classes across branches

- GIVEN a scope containing `x = A()` in one branch and `x = B()` in another, followed by `x.method()`, where both `A` and `B` define a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "ambiguous"` and `candidates` including the matching `method` from both `A` and `B`

#### Scenario: Instance call to an unresolvable constructor class

- GIVEN a scope containing `x = UnknownClass()` followed by `x.method()`, where `UnknownClass` cannot be statically resolved
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Instance call with no matching method on the resolved class

- GIVEN a scope containing `x = ClassName()` followed by `x.other_method()`, where `ClassName` does not define `other_method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Call through a variable bound from a non-constructor expression remains unresolved

- GIVEN a scope containing `x = other_var` (or `x = factory()`) followed by `x.method()`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Resolve a call through an annotated variable

- GIVEN `x: Route4` (with or without `= Route4()`) followed by `x.method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Resolve a call through an annotated function parameter

- GIVEN `def f(r: Route4): r.method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Annotation naming an unresolvable or quoted/generic class remains unresolved

- GIVEN `x: UnknownClass` or `x: "Route4"` or `x: Optional[Route4]` followed by `x.method()`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Resolve a call through a class-scoped self-attribute binding

- GIVEN a class where one method assigns `self.attr = Route4()` and a different method of the same class calls `self.attr.method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Self-attribute bound to different classes resolves as ambiguous

- GIVEN a class where one method assigns `self.attr = A()`, another assigns `self.attr = B()`, and a third calls `self.attr.method()`, where both `A` and `B` define a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "ambiguous"` and `candidates` including the matching `method` from both `A` and `B`

#### Scenario: Non-`self`-named receiver parameter is not treated as a self-attribute binding

- GIVEN a method whose first parameter is literally named `this` (not `self`), assigning `this.attr = Route4()`, followed by `this.attr.method()`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Resolve a chained call through an explicit return-type annotation

- GIVEN `def get_route() -> Route4: ...` and a call `get_route().method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Resolve a chained call through an inferred return-body class

- GIVEN `def get_route(): return Route4()` (no return annotation) and a call `get_route().method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Resolve a chained call through a returned local variable

- GIVEN `def get_route(): r = Route4(); return r` and a call `get_route().method()`, where `Route4` defines a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "resolved"` and `target` identifying `Route4.method`

#### Scenario: Chained call with multiple return types resolves as ambiguous

- GIVEN a function with `return A()` on one path and `return B()` on another, called as `get_route().method()`, where both `A` and `B` define a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "ambiguous"` and `candidates` including the matching `method` from both `A` and `B`

#### Scenario: Chained call with no discernible return type resolves as unresolved without crashing or looping

- GIVEN a function with a bare `return`, a return expression too complex to evaluate, or a self-referential recursive return with no base case, called as `get_route().method()`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"` and analysis completes without crashing or entering an infinite loop
</content>
