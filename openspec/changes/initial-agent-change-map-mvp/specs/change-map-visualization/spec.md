# Change Map Visualization Specification

## Purpose

Define navigable project and section diagrams that expose structural changes and supporting diffs.

## Requirements

### Requirement: Provide two diagram forms

The system MUST provide a whole-project change map and sectioned diagrams for selected scopes. Both forms MUST represent analyzed entities and relationships and MUST use consistent change status and uncertainty semantics.

#### Scenario: View whole project

- GIVEN a completed comparison
- WHEN the user opens the whole-project map
- THEN scoped entities and their call, import, and containment relationships are displayed with change status

#### Scenario: View a section

- GIVEN a completed comparison and a selected package, module, class, or function scope
- WHEN the user opens a sectioned diagram
- THEN the diagram is limited to that scope while showing relevant boundary relationships

### Requirement: Navigate to exact source

A source-backed node or relationship MUST allow navigation to the exact file and source span in the explicitly chosen comparison state. The system MUST NOT navigate to a same-named symbol or a span from another state.

#### Scenario: Navigate to available source

- GIVEN a displayed item with source evidence in both states
- WHEN the user chooses its left or right source
- THEN the corresponding file opens with exactly that state's recorded span selected

#### Scenario: Source cannot be resolved

- GIVEN a displayed item whose recorded source is unavailable or stale
- WHEN navigation is requested
- THEN the system MUST report the failure and MUST NOT open an approximate location

### Requirement: Expose affected differences

Changed nodes and relationships MUST expose the relevant left-versus-right source difference, including additions, removals, and modifications. Unchanged context MAY be shown but MUST be distinguishable from affected ranges.

#### Scenario: Inspect a modified node

- GIVEN a node associated with a modified entity
- WHEN the user requests its difference
- THEN the system shows the corresponding left and right source ranges and identifies affected lines

#### Scenario: Inspect a one-sided entity

- GIVEN an entity exists in only one selected state
- WHEN its difference is requested
- THEN the system shows it as added or removed without inventing a counterpart

### Requirement: Keep large maps usable

The system MUST provide sectioning and filters before presenting an oversized whole-project map and MUST require an explicit user action to render a map classified as oversized.

#### Scenario: Apply filters

- GIVEN a map containing changed and unchanged entities
- WHEN the user filters by scope, relationship, or change status
- THEN only matching content is displayed without changing the comparison

#### Scenario: Request oversized map

- GIVEN the whole-project map exceeds the declared usability threshold
- WHEN the user opens it
- THEN the system offers sectioning or filtering and MUST NOT render the full map until the user explicitly confirms
