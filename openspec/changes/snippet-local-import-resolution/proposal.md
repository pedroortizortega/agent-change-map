# Proposal: Local-import resolution for the introspection/call sandbox

## Intent

Introspection and call of a Python target fail with `ModuleNotFoundError` whenever its file imports another same-project file. Concretely reported: a file doing `from config import ENV1` cannot be introspected or invoked, because the driver embeds exactly one file's source. Only fully self-contained single files work today — which excludes most real code. Fix: make same-repo absolute imports resolve inside the sandbox.

## Scope

### In Scope
- Bundle **all** snapshot files already matched by the existing `SourceFileMatcher` (no new filter) into the driver payload, using the proven base64-literal embedding pattern.
- Install a custom `MetaPathFinder`/`Loader` in the driver bootstrap so Python's own import machinery resolves local absolute imports, including transitive ones, lazily into `sys.modules`.
- `__init__.py`-required package semantics (classic Python), with `__path__` set for packages.
- Path→dotted-module-name mapping as a standalone pure function (`foo.py`→`foo`, `pkg/mod.py`→`pkg.mod`, `pkg/__init__.py`→`pkg`).
- Exclude the target's own file from the bundle by `posixPath` equality against `sourceId.posixPath`, so it is never double-embedded/double-executed.

### Out of Scope (non-goals)
- Relative imports (`from . import x`, `from ..pkg import y`) — deferred.
- Bundling stdlib/third-party packages; genuinely unavailable ones still fail loudly (unchanged prior behavior).
- Draft-splicing any file other than the target's own; unsaved edits in an imported file are not reflected.
- Any payload size/file-count cap or guard — explicitly deferred.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `sandboxed-snippet-execution`: "Control accessible content" must permit the captured snapshot's matched source files to be delivered as in-memory importable modules via stdin (still no mounts, no host FS access), and must state that uncaptured imports fail as ordinary `ModuleNotFoundError`.

## Approach

Option A from exploration. Host-side: a bundle-gathering function reads `SnapshotStore.get(snapshot).files`, drops the target path, and yields `{dottedName, content}` pairs. Driver-side: those pairs become a base64 dict literal plus a ~40-line stdlib finder/loader recipe executed before the target module body. Correctness derives from Python's real import semantics rather than a parallel static resolver.

New module placement: put the pure mapping in `src/execution/pythonModuleName.ts` (driver-shaping concern) and the store-reading bundle gatherer alongside `resolveModuleSource` in `src/navigation/sourceProvider.ts` (it already owns `SnapshotStore` reads).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/execution/callDriver.ts` | Modified | Bundle literal + finder bootstrap in both driver builders |
| `src/execution/pythonModuleName.ts` | New | Pure path→dotted-name mapping |
| `src/navigation/sourceProvider.ts` | Modified | Bundle gatherer beside `resolveModuleSource` |
| `src/webviewHost.ts` | Modified | `handleRequestSignature`/`handleRequestCall` fetch and pass the bundle |
| `test/unit/callDriver.test.ts` | Modified | Bundling cases mirroring base64 invariants |
| `test/unit/pythonModuleName.test.ts`, `sourceProvider.test.ts` | New/Modified | Table-driven mapping and gatherer tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Package `__path__`/`__init__.py` edge cases (flat single file, sibling packages, partially-matched packages) | Med | Table-driven mapping tests; explicit `__init__.py`-required rule |
| Payload growth with repo size | Med | Accepted for v1; cap deferred, revisit on real evidence |
| Uncaptured local import | Med | Degrades to standard `ModuleNotFoundError` — acceptable, not a defect |
| Injection surface | Low | **Locked, re-verified**: base64 alphabet excludes `"`/newline and files share the target's trust boundary — no new surface |
| Slice sizes exceed the 400-line review budget | High | Same PR-splitting discipline as the prior change; exact boundaries are `sdd-tasks`'s job |

Strict TDD applies: every slice is RED-first, matching the prior change's task convention.

## Suggested Sequencing

1. Pure path→dotted-module-name mapping.
2. Host-side bundle gathering (with target exclusion).
3. Driver template: bundle literal + meta-path-finder bootstrap.
4. Host wiring in `webviewHost.ts`.

## Rollback Plan

Each slice is additive. Revert by dropping the bundle argument from the driver builders and the bootstrap section from the template; drivers return to single-file embedding with no other behavior change.

## Dependencies

- `extended-snippet-draft-interactive-inputs` (completed) — provides the driver builders this extends.

## Success Criteria

- [ ] A target whose file does `from config import ENV1` introspects and calls successfully.
- [ ] A transitive local import (target → `config` → `helpers`) resolves.
- [ ] Package imports (`pkg/sub/mod.py` with `__init__.py`) resolve; missing `__init__.py` does not create a package.
- [ ] A genuinely absent import still raises `ModuleNotFoundError`.
- [ ] Base64 security-invariant tests still pass with multi-file bundles.

## Proposal question round

All exploration open questions were answered and locked by the user (Option A, `__init__.py`-required, no cap, relative imports deferred, security re-verified). Residual item for design, not a product decision: exact `__path__` handling for packages whose submodules are only partially captured.
