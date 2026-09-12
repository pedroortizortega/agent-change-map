# Exploration: Local-import resolution for the introspection/call sandbox

## Problem

A real user hit this live while testing `extended-snippet-draft-interactive-inputs`: a Python file selected for introspection/call frequently does `from config import ENV1` (or any local, same-project import). The driver only ever embeds **one** file's source (the selected target's own file). When the sandboxed driver execs that single file's module body, `import config` fails with `ModuleNotFoundError: No module named 'config'` — because `config.py`, while captured host-side (git capture already reads the whole repo's `.py` files), is never provided to the sandbox at all. This blocks introspection/invocation for any function/class that transitively depends on another local file — likely the majority of real-world code, not an edge case.

## Current State

- `src/execution/callDriver.ts`'s `buildIntrospectionDriver`/`buildCallDriver` embed exactly **one** file's source as a base64 literal (`_SRC`), decode it in-process, `exec(compile(_SRC, "<acm-target>", "exec"), _m.__dict__)` into a synthetic `types.ModuleType("acm_target")`, then navigate to the target via a `getattr` chain on `dottedName`. No other file's content is ever embedded.
- `src/navigation/sourceProvider.ts`'s `resolveModuleSource(store, sourceId, draftContent?)` resolves **one** file's full content (with optional draft splice) from the `SnapshotStore`, given a `SourceId` (which carries `snapshot` + `posixPath`).
- `src/webviewHost.ts`'s `handleRequestSignature` (line ~422) and `handleRequestCall` (line ~474) both call `resolveModuleSource(this.deps.store, sourceId, ...)` for exactly the target's own file, then hand that single `content` string to `buildIntrospectionDriver`/`buildCallDriver`.
- `src/execution/dockerRunner.ts`'s `runSnippet` spawns `docker run --rm -i --network none --read-only --tmpfs /tmp:rw,... --cap-drop=ALL --security-opt=no-new-privileges --user 65534:65534 python:3.12-slim python3 -u -`; content is delivered **only via stdin**, no bind mounts, no filesystem access to host content at all.
- `src/git/gitService.ts`'s `captureGitState` already captures **every** file matched by `SourceFileMatcher` (`defaultSourceFileMatcher = createSourceFileMatcher([".py"])`) — the entire repo's `.py` files, both tracked and untracked — into a `CapturedState { snapshot, files: CapturedFile[] }` where each `CapturedFile` is `{ path, content, provenance }`.
- `src/snapshots/snapshotStore.ts`'s `SnapshotStore.get(id): CapturedState | undefined` returns the **entire** `files` array for that snapshot (not just one file) — confirmed directly from the class body. **All captured files, keyed by `posixPath`, with full content, are already available host-side.**
- `test/unit/callDriver.test.ts` tests driver-script generation as pure string-building logic — extracts the base64 literal via regex and asserts round-trip correctness and adversarial-value safety, with zero Docker/I-O. This is the exact pattern to mirror for new import-bundling logic.

## Affected Areas

- `src/execution/callDriver.ts` — driver template needs a second embedded payload (bundle of other files' base64 sources + a meta-path-finder bootstrap), for both `buildIntrospectionDriver` and `buildCallDriver`.
- `src/navigation/sourceProvider.ts` or a new sibling module — needs a function to gather the "bundle" (other captured files transformed into `{dottedModuleName, base64Content}` pairs) from `SnapshotStore`, given the snapshot id and the target's own path (to exclude it and avoid duplicate execution).
- `src/webviewHost.ts`'s `handleRequestSignature`/`handleRequestCall` — need to fetch the bundle (via `this.deps.store`, already available) in addition to `resolveModuleSource`, and pass it to the driver builders.
- `src/git/gitService.ts` / `src/analysis/sourceFileMatcher.ts` — no changes needed; the matcher and capture already produce the necessary file set.
- `test/unit/callDriver.test.ts` — new test cases for the bundling/meta-path-finder driver shape.
- Possibly a new pure module (e.g. `src/execution/pythonModuleName.ts`) for path→dotted-module-name mapping, independently unit-testable.

## Approaches

### Option A — Bundle every captured file + in-memory MetaPathFinder/Loader import hook (recommended)

Embed base64 sources for all other captured `.py` files (same base64-literal pattern already proven safe), map each `posixPath` to a dotted module name (`config.py` → `config`, `pkg/sub/mod.py` → `pkg.sub.mod`, `pkg/__init__.py` → `pkg`), install a custom `importlib.abc.MetaPathFinder` that intercepts `import config` and lazily execs the matching bundled source into a real module object registered in `sys.modules`. Python's own import statement then just works, including transitive imports among the bundled files.

- **Pros**: correctness comes "for free" from Python's own import resolution — no need to statically parse import graphs or handle stdlib/aliasing edge cases; a single mechanism uniformly resolves first-level AND transitive local imports; robust to `import x; import x.y` mixed forms.
- **Cons**: bundles the entire captured file set per round-trip regardless of whether it's needed — payload grows with repo size; must implement package (`__init__.py`) semantics correctly (`__path__` for subpackage resolution); the path→module mapping needs a "root" convention that doesn't exist elsewhere in the codebase.
- Effort: Medium (the finder/loader Python code is a well-known ~30-40 line stdlib recipe; package `__path__` handling and testing add real surface).

### Option B — Bundle only first-level static imports

Statically scan (TypeScript-side) the target file's own `import`/`from X import Y` statements, resolve each imported name against the captured file set by path convention, and bundle only those matched files.

- **Pros**: much smaller payload (proportional to actual first-level deps); simpler mental model; solves the reported bug for the common single-hop case.
- **Cons**: misses deeper transitive imports (e.g., `config.py` itself imports `secrets.py`) — still fails for a realistic fraction of real code; static import parsing needs to handle `import x`, `from x import y`, `import x as y`, `from x.y import z`, multi-line/parenthesized import lists — a mini-parser, not a one-line regex.
- Effort: Medium.

### Option C — Full transitive dependency resolution computed host-side (static, no runtime hook)

Recursively parse imports starting at the target file, building the exact minimal file closure needed.

- **Pros**: theoretically the smallest possible payload.
- **Cons**: highest implementation complexity — recursive parsing, cycle detection, false-negatives from dynamic imports (`importlib.import_module(name)`), and a parallel static-resolution engine that can silently diverge from what Python's own import machinery would actually do (`if TYPE_CHECKING:` blocks, `try/except ImportError` fallbacks). Option A sidesteps all of this because Python's real import statement decides at runtime with exact real semantics.
- Effort: High, and arguably solves a problem Option A already solves more robustly.

## Recommendation

**Option A**, scoped to files already matched by the existing `SourceFileMatcher` (not a new filter — reuses the existing capture boundary). This gets Option A's correctness (real Python import semantics handle transitivity, conditional imports, packages) without inventing a second, potentially-diverging static resolution engine (Option C's core risk), and is more complete than Option B's first-level-only static parse for a small added implementation cost.

The payload-size concern is real but should be validated against the intended use case (typically small projects) rather than pre-optimized; if the proposal phase confirms this is a real cost, a follow-up could add a size-based cap or fall back to Option B's first-level-only scope for oversized snapshots — a decision for `sdd-propose`, not this exploration.

## Path-to-module-name mapping (concrete rule discovered)

Given a captured `posixPath` (already repo-root-relative, per how `captureCommitState`/`captureWorktreeState` produce `entry.path`):
- `foo.py` → `foo`
- `pkg/mod.py` → `pkg.mod`
- `pkg/__init__.py` → `pkg` (needs `__path__` set to make `pkg.sub` importable)
- A file whose containing directories lack `__init__.py`: the custom `MetaPathFinder` doesn't need real filesystem `__init__.py` discovery, so it could pragmatically treat every directory component as an implicit namespace-package segment, OR require `__init__.py` presence to mirror real Python semantics exactly. **Not yet decided — no existing convention in this codebase for "project root as package root," since prior work only ever handled a single flat file.**

## Relative imports — scope question

`from . import sibling` / `from ..pkg import thing` requires knowing the importing module's own dotted name/package (`__package__`) to resolve `.`/`..` — knowable once the meta-path-finder exists, but adds real edge-case surface (`ImportError: attempted relative import beyond top-level package`, no established top-level-package concept). **Recommend scoping relative imports OUT of v1** and deferring — matches the concretely-reported bug (`from config import ENV1`, an absolute import).

## Missing/uncaptured import — expected behavior

If an imported local file was not captured (outside matcher, ignored dir, or genuinely absent), the meta-path-finder simply has no entry for that dotted name, `find_spec` returns `None`, and Python's own import machinery raises the standard `ModuleNotFoundError: No module named 'x'` — identical to genuine real-world behavior, no special-casing needed.

## Security invariant re-verification

The existing security invariant (`test/unit/callDriver.test.ts`'s "args-are-JSON-only" tests) rests on: base64's alphabet (`[A-Za-z0-9+/=]`) cannot contain a `"` or newline, so no adversarial *decoded* value can break out of the Python string literal it's embedded in, regardless of what that decoded value contains. This reasoning is **content-agnostic** — it holds identically whether the base64-encoded payload is the target file's own source or any other captured file's source, because the embedding mechanism applies uniformly to any string, and the captured files come from the same trust boundary as the currently-already-embedded target file (the user's own already-open workspace, read via `git`/`fs.readFile`, never from network or attacker input). **Confirmed: no new injection surface is introduced by bundling more same-trust-boundary file contents this way.**

## Testing Strategy

- Path→dotted-module-name mapping: pure function, fully unit-testable in isolation (table-driven tests over `posixPath` → expected dotted name, package `__init__.py` cases), no Docker/store needed.
- Driver-script template growth: extend `test/unit/callDriver.test.ts` using the exact same regex-extraction pattern to assert each bundled file's content round-trips as its own base64 literal, and that the meta-path-finder Python bootstrap text is present/well-formed — all pure string assertions, no Docker daemon required.
- Bundle-gathering logic (host-side: given `SnapshotStore` + target `sourceId`, produce the list of `{dottedName, content}` pairs to embed) is testable with an in-memory `SnapshotStore` fixture, matching `sourceProvider.test.ts`'s existing pattern — no real git or Docker needed.

## Open Questions for sdd-propose

1. Implicit-namespace-package semantics vs. requiring `__init__.py` for directories to be treated as packages — pick one, document the tradeoff.
2. Payload-size guard: is there a concrete file-count/byte-size cap on the bundle, or is "typically small" sufficient justification to defer that entirely?
3. Exact exclusion rule for the target's own file when building the "other files" bundle (by `posixPath` equality against `sourceId.posixPath`) — trivial but must be explicit so the target isn't double-embedded/double-executed.
4. Whether draft-splice (`draftContent` override in `resolveModuleSource`) should also apply to any OTHER bundled file that happens to have an open, unsaved draft in `draftStore` (edge case: user is editing `config.py` in another tab while introspecting a function in `main.py` that imports it) — likely out of scope for v1, worth an explicit non-goal.

## Ready for Proposal

Yes.
