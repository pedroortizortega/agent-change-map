# Snippet Signature Introspection Specification

## Purpose

Discover, at runtime inside the hardened Docker sandbox, the callable parameters of whichever node is currently selected in the change map, so the Snippet Draft panel can render an accurate input form without a separate in-panel target picker.

## Requirements

### Requirement: Introspect the selected target's signature via sandboxed runtime execution

The system MUST introspect the parameters of the node currently selected in the change map (function, method, or class) by importing the containing module and calling `inspect.signature()` inside the same restricted disposable container used for runs, returning parameter metadata (name, kind, annotation text if any, default presence) as JSON. For a class target, the system MUST introspect `__init__` instead of the class itself. The system MUST NOT fall back to static AST-only signature extraction when Docker is unavailable; instead the input/call UI MUST be disabled with a clear "unavailable" state.

#### Scenario: Introspect a selected function

- GIVEN a function node is selected in the change map
- WHEN the panel requests introspection
- THEN the sandbox imports the module, calls `inspect.signature()` on that function, and returns parameter metadata used to render the input form

#### Scenario: Introspect a selected class via its constructor

- GIVEN a class node is selected in the change map
- WHEN the panel requests introspection
- THEN the sandbox introspects `__init__` and returns its parameter metadata, excluding `self`

#### Scenario: Docker unavailable disables the form without a static fallback

- GIVEN Docker is not available on the host
- WHEN a function, method, or class node is selected
- THEN the input/call form is shown as disabled/unavailable and no static-AST-derived signature is substituted

### Requirement: Cache introspection results per target identity and snippet content hash

The system MUST cache a successful introspection result keyed by the combination of target identity (module path + qualified name) and a content hash of the snippet text, and MUST reuse the cached result instead of spawning another container when the same unchanged target is re-selected. A change to the snippet content or a different target MUST invalidate the cache for that key and trigger a fresh introspection round-trip.

#### Scenario: Cache hit on re-selecting an unchanged target

- GIVEN a target was already introspected and its snippet content has not changed
- WHEN the same target is selected again
- THEN the cached signature is used and no new container is spawned

#### Scenario: Cache miss after content changes

- GIVEN a target was already introspected
- WHEN the snippet content for that target changes and the target is selected again
- THEN a new introspection round-trip runs and its result replaces the cache entry for that key
</content>
