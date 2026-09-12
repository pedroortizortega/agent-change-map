# Delta for Sandboxed Snippet Execution

## ADDED Requirements

### Requirement: Apply sandbox isolation guarantees to introspection and invocation runs

Signature introspection round-trips and driver-wrapped invocation calls MUST execute under the exact same isolation, restriction, and cleanup guarantees as an ordinary snippet run: a disposable container, network access disabled, bounded CPU/memory/elapsed time, controlled mounts, a read-only root filesystem, no unnecessary privileges, and forced kill-and-verify termination on cancellation, failure, or timeout. Neither use case MAY relax any restriction that applies to a run.

#### Scenario: Introspection round-trip runs under full sandbox restrictions

- GIVEN a signature introspection request for a selected target
- WHEN the container is spawned to run `inspect.signature()`
- THEN it runs with no network, read-only root filesystem, non-privileged user, no bind mounts, and the same CPU/memory/time bounds as a snippet run

#### Scenario: Invocation run is cleaned up like an ordinary run

- GIVEN a confirmed function or class call is executing
- WHEN the call times out or is cancelled
- THEN the container is force-killed and verified removed, identically to how an ordinary run is cleaned up on timeout or cancellation

#### Scenario: Introspection is refused if a required restriction cannot be applied

- GIVEN Docker cannot establish a required restriction (e.g. network isolation)
- WHEN an introspection or invocation request is made
- THEN the system refuses to execute and identifies the unsatisfied restriction, the same way an ordinary run refuses
</content>
