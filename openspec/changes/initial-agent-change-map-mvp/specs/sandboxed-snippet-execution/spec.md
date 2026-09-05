# Sandboxed Snippet Execution Specification

## Purpose

Define explicit, restricted, disposable execution and three-variant result comparison.

## Requirements

### Requirement: Require explicit execution

The system MUST execute no snippet automatically. Each run MUST require an explicit user action after showing the selected snippet variants and applicable restrictions.

#### Scenario: Inspect without running

- GIVEN changed snippet content is displayed
- WHEN the user navigates, edits, or compares it without choosing run
- THEN no code is executed and no execution environment is created

#### Scenario: Request a run

- GIVEN the user has reviewed the selected variants and restrictions
- WHEN the user explicitly chooses run
- THEN only the displayed selected variants are scheduled for that run

### Requirement: Enforce a restricted disposable environment

Every run MUST use a disposable isolated container with network access disabled by default, bounded CPU, memory, and elapsed time, controlled mounts, a read-only root filesystem, and no unnecessary privileges. Enabling network MUST require a separate explicit user decision for that run.

#### Scenario: Run with defaults

- GIVEN a valid snippet run request with no network exception
- WHEN execution starts
- THEN the environment has no network and enforces declared CPU, memory, time, mount, filesystem, and privilege restrictions

#### Scenario: Restriction cannot be applied

- GIVEN any required restriction cannot be established
- WHEN execution is requested
- THEN the system MUST refuse to execute and identify the unsatisfied restriction

### Requirement: Control accessible content

The execution environment MUST receive only the selected snippets and explicitly approved supporting inputs. Repository and host mounts MUST be limited to declared paths and MUST be read-only unless the user separately approves a bounded writable output location.

#### Scenario: Read approved input

- GIVEN a run includes an explicitly approved supporting input
- WHEN the snippet executes
- THEN that input is available only at the declared location and other repository or host content is unavailable

#### Scenario: Reject an undeclared access

- GIVEN a snippet attempts to access an undeclared host path or writable location
- WHEN it executes
- THEN access MUST fail without modifying host or repository content

### Requirement: Compare three variant results

For available original, current, and draft variants, the system MUST execute each under equivalent restrictions and MUST present each result separately with captured standard output, standard error, exit status, timeout status, and execution error. A missing variant MUST be identified rather than synthesized.

#### Scenario: Compare successful and failing variants

- GIVEN original, current, and draft snippets are available
- WHEN the explicit run completes
- THEN all three labeled results are shown and differences in output, errors, and status are identifiable

#### Scenario: Variant times out or is absent

- GIVEN one available variant exceeds its limit and another requested variant is unavailable
- WHEN the run completes
- THEN the first is reported as timed out, the second as unavailable, and completed variant results remain visible

### Requirement: Clean up every run

The system MUST terminate and remove run containers and ephemeral writable state after success, failure, cancellation, or timeout, while retaining only the reported result data.

#### Scenario: Run ends abnormally

- GIVEN an active run fails, is cancelled, or times out
- WHEN termination completes
- THEN its container and ephemeral writable state are removed and the termination outcome is reported
