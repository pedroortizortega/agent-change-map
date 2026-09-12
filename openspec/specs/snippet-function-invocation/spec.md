# Snippet Function Invocation Specification

## Purpose

Let a user supply argument values for the currently introspected target and invoke it inside the existing hardened Docker sandbox, without ever allowing user-supplied values to be interpolated into executed Python source.

## Requirements

### Requirement: Render a dynamic per-parameter input form from the introspection result

The system MUST render one input control per parameter reported by signature introspection. When a parameter's shape cannot be represented by a typed input (e.g. `*args`, `**kwargs`, or an unrecognized annotation), the system MUST render a raw-JSON text fallback for that parameter instead of omitting it or guessing a type.

#### Scenario: Render typed inputs for a simple signature

- GIVEN introspection returned parameters with recognizable kinds
- WHEN the "Call function" box renders
- THEN one input control appears per parameter, labeled with its name

#### Scenario: Raw-JSON fallback for an unrepresentable parameter

- GIVEN introspection reports a `**kwargs` parameter or an annotation the form cannot type
- WHEN the form renders
- THEN that parameter is presented as a raw-JSON text field instead of being dropped

### Requirement: Require an explicit confirm step before invoking, independent of introspection

Invoking a function or class with supplied values MUST require its own explicit user confirmation step, separate from and not satisfied by any confirmation already given for introspection or for a prior run.

#### Scenario: Confirm before invocation

- GIVEN the user has filled the input form
- WHEN the user chooses to call the function
- THEN a confirmation step is shown before any container is spawned

#### Scenario: Declining the call confirmation performs no invocation

- GIVEN the call confirmation is shown
- WHEN the user declines
- THEN no container is spawned and no code executes

### Requirement: Pass argument values only as a JSON payload, never interpolated into source

Supplied argument values MUST travel to the sandbox only as a JSON payload, decoded inside a synthesized driver script via `json.loads()` or `ast.literal_eval()`. The system MUST NOT construct the driver script by string-interpolating, string-formatting, or otherwise splicing user-supplied values into Python source text.

#### Scenario: Ordinary values are decoded, not interpolated

- GIVEN valid argument values for a function's parameters
- WHEN the call is confirmed
- THEN the driver script reads the values via `json.loads()`/`ast.literal_eval()` and calls the target with the decoded values

#### Scenario: An adversarial value must not execute as code

- GIVEN a supplied string argument value of `"); import os; os.system('rm -rf /')"`
- WHEN the call is confirmed and the driver runs
- THEN the value is treated strictly as JSON-decoded string data passed to the target parameter, and no shell command or additional Python statement is executed as a result of that value

### Requirement: Construct a class instance via `__init__` for a class target

When the selected target is a class, invocation MUST construct an instance by calling `__init__` with the supplied values, using the same JSON-decode boundary as a function call.

#### Scenario: Calling a class target constructs an instance

- GIVEN a class target with an introspected `__init__` signature and supplied values
- WHEN the call is confirmed
- THEN the driver constructs an instance of the class using the decoded values and reports success or the constructor's failure

### Requirement: Reuse the existing confirm → run → stream → cleanup pipeline

Invocation MUST reuse the same Docker execution pipeline used for snippet runs — confirmation, container spawn, streamed output, timeout/cancellation, and forced cleanup — and MUST report success, failure, or timeout with captured output the same way a run does.

#### Scenario: A successful call streams output and reports success

- GIVEN a confirmed call with valid values
- WHEN the driver completes without error
- THEN streamed output is shown and the result is reported as success

#### Scenario: A failing call reports failure with captured error

- GIVEN a confirmed call whose target raises an exception
- WHEN the driver run completes
- THEN the result is reported as failure with the captured error output, following the same reporting shape as a snippet run failure
</content>
