# Python Structure Analysis Specification Delta

## MODIFIED Requirements

### Requirement: Represent call uncertainty

The system MUST report syntactically observed calls. It MUST distinguish uniquely resolved targets, multiple candidate targets, and unresolved dynamic calls, and MUST NOT present inferred candidates as certain.

Calls made through an instance variable (`ast.Attribute` over an `ast.Name` value) MUST be resolved using the same `resolved` / `ambiguous` / `unresolved` contract as direct name calls, when the variable was bound to a class by a constructor-call assignment (`x = ClassName(...)`) in the same lexical scope as the call. A variable bound to more than one class across branches MUST resolve as `ambiguous` with candidates drawn from all bound classes' matching methods, rather than being dropped or downgraded to `unresolved`. Binding shapes outside a direct single-name-target, direct-constructor-call assignment (attribute access on `self`, non-constructor right-hand sides, tuple/multi-assignment targets, and chained or returned-instance calls) MUST continue to resolve as `unresolved`, unchanged from prior behavior.
(Previously: only `ast.Name` calls were resolved; any `ast.Attribute` call, including instance method calls, always fell back to `unresolved`.)

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
- THEN the call resolves with `kind: "resolved"` and `target` identifying `ClassName.method`, retaining the call-site span

#### Scenario: Instance variable reassigned to different classes across branches

- GIVEN a scope containing `x = A()` in one branch and `x = B()` in another branch, followed by `x.method()` after the branches, where both `A` and `B` define a matching `method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "ambiguous"` and `candidates` including the matching `method` from both `A` and `B`

#### Scenario: Instance call to an unresolvable constructor class

- GIVEN a scope containing `x = UnknownClass()` followed by `x.method()` in that same scope, where `UnknownClass` cannot be statically resolved to a known entity
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Instance call with no matching method on the resolved class

- GIVEN a scope containing `x = ClassName()` followed by `x.other_method()` in that same scope, where `ClassName` does not define `other_method`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`

#### Scenario: Call through self-attribute access remains unresolved

- GIVEN a method containing `self.attr = ClassName()` followed elsewhere by `self.attr.method()`
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`, unchanged from prior behavior

#### Scenario: Call through a variable bound from a non-constructor expression remains unresolved

- GIVEN a scope containing `x = other_var` (or `x = factory()` returning an instance indirectly) followed by `x.method()` in that same scope
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`, unchanged from prior behavior

#### Scenario: Chained or returned-instance call remains unresolved

- GIVEN a call of the shape `get_route().method()`, where the instance is produced by a call expression rather than a bound variable
- WHEN analysis is requested
- THEN the call resolves with `kind: "unresolved"`, unchanged from prior behavior
