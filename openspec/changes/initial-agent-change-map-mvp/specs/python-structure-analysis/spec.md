# Python Structure Analysis Specification

## Purpose

Define evidence-based static analysis of Python source structure and relationships.

## Requirements

### Requirement: Discover Python entities

The system MUST identify packages, modules, classes, functions, and methods in selected Python source, including nested definitions, and MUST assign each entity a stable identity within the analyzed state.

#### Scenario: Analyze valid source

- GIVEN a selected state containing valid Python files
- WHEN analysis is requested
- THEN all scoped entities are returned with kind, qualified name, and containing entity

#### Scenario: Encounter invalid source

- GIVEN a Python file containing a syntax error
- WHEN analysis is requested
- THEN the system MUST report the file and diagnostic without discarding valid results from other files

### Requirement: Preserve exact source evidence

Each entity, call, and import result MUST include its analyzed state, file path, and precise source span sufficient to select the corresponding source text. A result MUST NOT silently resolve against another state.

#### Scenario: Locate a definition

- GIVEN an entity extracted from a selected state
- WHEN its source evidence is requested
- THEN the returned path and span select exactly that entity's definition in that state

#### Scenario: Source is unavailable

- GIVEN recorded evidence whose file or span is unavailable in its analyzed state
- WHEN source evidence is requested
- THEN the system MUST report that the evidence cannot be resolved and MUST NOT substitute a similar location

### Requirement: Extract imports

The system MUST report import statements and statically resolvable imported modules or symbols, while preserving unresolved or relative-import evidence explicitly.

#### Scenario: Resolve an import

- GIVEN a module containing an import resolvable within the selected source state
- WHEN analysis is requested
- THEN the import relationship identifies its source, target, statement span, and resolution status

#### Scenario: Import target is unresolved

- GIVEN an import whose target cannot be statically identified
- WHEN analysis is requested
- THEN the relationship MUST remain visible as unresolved with its original source evidence

### Requirement: Represent call uncertainty

The system MUST report syntactically observed calls. It MUST distinguish uniquely resolved targets, multiple candidate targets, and unresolved dynamic calls, and MUST NOT present inferred candidates as certain.

#### Scenario: Resolve a direct call

- GIVEN a call with one statically identifiable in-scope target
- WHEN analysis is requested
- THEN the call identifies that target and its call-site span as resolved

#### Scenario: Analyze a dynamic call

- GIVEN a call whose runtime target is not statically knowable
- WHEN analysis is requested
- THEN the call is marked ambiguous or unresolved, includes available candidates if any, and retains its call-site evidence
