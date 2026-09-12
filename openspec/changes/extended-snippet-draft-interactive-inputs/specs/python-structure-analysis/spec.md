# Delta for Python Structure Analysis

## ADDED Requirements

### Requirement: Address a specific callable for introspection and invocation

The entity representation on the wire MUST carry enough target identity for a function, method, or class node to be independently addressed for signature introspection and invocation, beyond what `entitySchema` (`id`, `kind`, `qualifiedName`, `containerId`, `span`) already exposes: at minimum the callable's module path and fully qualified name, sufficient for the host to construct an import statement and attribute lookup without re-deriving them from source spans. For a class node, this identity MUST resolve to its `__init__` for introspection/invocation purposes while the node itself remains addressable as the class.

#### Scenario: Function entity carries an addressable module path and qualified name

- GIVEN an analyzed module contains a top-level function
- WHEN its entity is emitted in the analysis graph
- THEN the entity's data includes a module path and qualified name sufficient to import the module and resolve the function by name

#### Scenario: Class entity resolves to its constructor for introspection

- GIVEN an analyzed module contains a class with an `__init__` method
- WHEN the class entity's target identity is used to request introspection
- THEN it addresses `__init__` of that class rather than the class object itself

#### Scenario: Method entity carries identity relative to its containing class

- GIVEN an analyzed module contains a class with an instance method
- WHEN the method entity's target identity is used to request introspection
- THEN it resolves to that specific class's method, not a same-named method on an unrelated class
</content>
