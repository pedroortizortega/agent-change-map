# Design: Local-import resolution for the introspection/call sandbox

## Technical Approach

Option A, in four layered pieces: a pure path→dotted-name mapper, a store-reading bundle
gatherer, a driver bootstrap that installs a `sys.meta_path` finder over a base64-enveloped
bundle, and host wiring. Correctness comes from Python's own import machinery; no static
import graph is computed anywhere.

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|---|---|---|---|
| Non-package file (no `__init__.py` in its dir chain) | Not bundled at all | Flat fallback name (`scripts/util.py`→`util`); implicit namespace pkg | A flat fallback collides with a genuine top-level `util.py` and makes importable a name real Python would never resolve. Absent ⇒ ordinary `ModuleNotFoundError`, identical to any uncaptured import. |
| Partially captured package (`pkg/__init__.py`+`pkg/a.py` present, `pkg/b.py` uncaptured) | `pkg.b` is simply unresolvable | Filesystem fallback; synthetic stubs | Confirmed correct. Mechanism: the finder sits on `sys.meta_path` (ahead of `PathFinder`) and resolves by full dotted name, so `__path__` is never consulted by us — it only has to be a list for `pkg` to *be* a package. Setting `__path__ = []` means `import pkg.b` falls through to `PathFinder`, finds nothing, and raises the standard `ModuleNotFoundError`. Inside `--read-only --network none` with no mounts there is no host source to leak into anyway. |
| Payload shape | ONE base64 literal holding a JSON dict `{dotted: {source, isPackage}}` | N separate `_SRC_<n>` literals | One literal, one decode, one regex to test; the security envelope is unchanged (still base64 alphabet `[A-Za-z0-9+/=]` inside the Python string literal) and scales to any file count without template arithmetic. |
| `pkg.py` vs `pkg/__init__.py` collision | Package wins | First-wins; error | Mirrors CPython's `FileFinder`, where package hooks precede module hooks. |
| Builder signatures | Optional trailing `bundle` param defaulting to `[]` | Required param | With an empty bundle the emitted driver text is byte-identical to today's, so slice 3 lands green with all existing tests untouched and slice 4 wires it independently. |
| Target `__init__.py` exclusion side effect | Accepted v1 gap | Self-registering the target in `sys.modules` | Excluding the target by `posixPath` means a target that *is* `pkg/__init__.py` leaves `pkg` unbound. Fixing it means changing the target module's identity/`__name__`, which is outside locked scope. Not a regression (nothing imports today). Recommended follow-up below. |

## Interfaces / Contracts

```ts
// src/execution/pythonModuleName.ts (new, pure)
export interface PythonModuleEntry { readonly dottedName: string; readonly posixPath: string; readonly isPackage: boolean; }
export function mapPathsToModules(posixPaths: readonly string[]): PythonModuleEntry[];
```

Rules: `.py` only; strip `.py`; `__init__` ⇒ dotted name is the directory chain and `isPackage: true`;
every directory segment must be an ASCII identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`) **and** have
`<dir>/__init__.py` present in the SAME input array; the basename must be an identifier too;
root-level `__init__.py` (empty dotted name) is skipped. Output sorted by `dottedName`, package
preferred on collision. A package's `__init__.py` content is bundled verbatim and executed lazily,
so a content-bearing `__init__` populates its own namespace normally.

```ts
// src/navigation/sourceProvider.ts (beside resolveModuleSource)
export interface BundledModule { readonly dottedName: string; readonly source: string; readonly isPackage: boolean; }
export function gatherImportBundle(store: SnapshotStore, snapshot: SnapshotId, excludePosixPath: string): BundledModule[];
```

Behavior: `store.get(snapshot)` (missing ⇒ `[]`, no throw — the target's own resolution already
raises `StaleSourceError`); map over the **full** `files` list so package detection sees every
`__init__.py`; drop the entry whose `posixPath === excludePosixPath` **after** mapping.
**No second matcher filter**: verified in `src/git/gitService.ts` — `captureCommitState` filters
`entry.path` through `matcher.matches`, and `listTrackedPaths`/`listUntrackedPaths` both `.filter`
by the matcher before read, so every `CapturedState.files[].path` is already matcher-filtered
(`defaultSourceFileMatcher` = `[".py"]`). Re-filtering would be dead code. Note the DTO field is
`path`, not `posixPath`.

## Driver bootstrap (`src/execution/callDriver.ts`)

A private `buildBundleBootstrap(bundle)` returns `""` for an empty bundle; otherwise it emits the
text below, inserted after the existing `import` line and **before** `_m = types.ModuleType(...)`,
identically in `buildIntrospectionDriver` and `buildCallDriver`.

```python
import sys
from importlib.abc import Loader as _AcmLoaderBase, MetaPathFinder as _AcmFinderBase
from importlib.machinery import ModuleSpec as _AcmSpec
_BUNDLE = json.loads(base64.b64decode("<base64 of JSON dict>"))

class _AcmLoader(_AcmLoaderBase):
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        _e = _BUNDLE[module.__name__]
        exec(compile(_e["source"], "<acm-bundle:" + module.__name__ + ">", "exec"), module.__dict__)

class _AcmFinder(_AcmFinderBase):
    def find_spec(self, fullname, path=None, target=None):
        _e = _BUNDLE.get(fullname)
        if _e is None:
            return None
        _s = _AcmSpec(fullname, _AcmLoader(), is_package=_e["isPackage"])
        if _e["isPackage"]:
            _s.submodule_search_locations = []
        return _s

sys.meta_path.insert(0, _AcmFinder())
```

Laziness is structural: nothing executes until `exec_module` is called by a real `import`.
Transitive imports work because bundled modules import through the same installed finder.

## Data Flow

    webviewHost.handleRequestSignature/RequestCall
        ├─ resolveModuleSource(store, sourceId, draft)  ──→ target content (unchanged)
        └─ gatherImportBundle(store, sourceId.snapshot, sourceId.posixPath)
               └─ mapPathsToModules(files[].path) ──→ BundledModule[]
                        ↓
        buildIntrospectionDriver/buildCallDriver(content, …, bundle)
                        ↓ base64/JSON envelope + meta_path finder
             runSnippet (stdin only, no mounts) ──→ Python import machinery

## File Changes

| File | Action | Description |
|---|---|---|
| `src/execution/pythonModuleName.ts` | Create | Pure `mapPathsToModules` |
| `src/navigation/sourceProvider.ts` | Modify | Add `gatherImportBundle` + `BundledModule` |
| `src/execution/callDriver.ts` | Modify | `buildBundleBootstrap` + optional `bundle` param on both builders |
| `src/webviewHost.ts` | Modify | Gather + pass bundle in both handlers; thread through `executeCall`; widen the introspection cache key |
| `test/unit/pythonModuleName.test.ts` | Create | Table-driven mapping tests |
| `test/unit/sourceProvider.test.ts` | Modify | Gatherer tests over an in-memory store |
| `test/unit/callDriver.test.ts` | Modify | Bundle-literal + bootstrap + adversarial tests |
| `test/unit/webviewHost.test.ts` | Modify | Wiring + cache-key tests |

**Cache-key hazard (found during design)**: `handleRequestSignature` keys its LRU on
`${targetId}|sha256(content)`. With the bundle in play, an edit confined to an imported file
(changing a default value sourced from it) would return a stale cached signature. Key must become
`${targetId}|${sha256Hex(content)}|${sha256Hex(JSON.stringify(bundle))}`.

## Testing Strategy (Strict TDD, RED first)

| Layer | File | What |
|---|---|---|
| Pure unit | `test/unit/pythonModuleName.test.ts` | Table: `foo.py`→`foo`; `pkg/mod.py`+`pkg/__init__.py`→`pkg.mod`,`pkg`(isPackage); nested `a/b/c.py` with both `__init__`s; missing intermediate `__init__` ⇒ excluded; non-identifier names excluded; `pkg.py` vs `pkg/__init__.py` collision; empty input |
| Store fixture | `test/unit/sourceProvider.test.ts` | `new SnapshotStore()` + `store.store({snapshot, files:[…]})` (existing helper shape); target excluded by path; package detection over the full set; unknown snapshot ⇒ `[]` |
| Driver string | `test/unit/callDriver.test.ts` | `extractBundleLiteral` via `/_BUNDLE = json\.loads\(base64\.b64decode\("([^"]*)"\)\)/`; round-trip decode→JSON equals input; `BASE64_ONLY` match; bootstrap contains `sys.meta_path.insert`; empty bundle ⇒ no `_BUNDLE` and byte-identical to today |
| Adversarial (security-critical) | `test/unit/callDriver.test.ts` | Reuse the existing `adversarialValues` array as **bundled-file** content: assert the bundle literal matches `BASE64_ONLY` and `driver` never contains the raw substring — same envelope class as the single-file case, now over N files |
| Host unit | `test/unit/webviewHost.test.ts` | Bundle reaches both builders; cache misses when only the bundle changes |
| Integration (optional, Docker-gated) | `test/integration/docker/dockerRunner.test.ts` | One real `from config import ENV1` round-trip — the only layer that proves the Python bootstrap actually executes |

## Threat Matrix

Applicable boundary: subprocess/sandboxed execution. Rows:
- **Code injection via embedded content** — Applicable. Every bundled source crosses the same
  base64+JSON envelope; base64's alphabet cannot terminate the Python literal. RED test: adversarial
  bundled content (above).
- **Privilege/isolation change** — N/A: `dockerRunner` flags, stdin-only delivery, no mounts, and
  `--network none` are untouched; the bundle adds bytes to stdin, nothing else.
- **Host filesystem reach** — Applicable. `__path__ = []` plus no mounts means a partially captured
  package cannot fall back to any host path. RED test: uncaptured submodule ⇒ `ModuleNotFoundError`.
- **Routing / VCS-PR automation / executable-file classification** — N/A: no such boundary touched.

## Migration / Rollout

No migration. Purely additive; drop the `bundle` argument and the bootstrap to revert.

## Sequencing

The proposal's order (mapping → gatherer → driver template → host wiring) holds: each slice is
independently testable and green on its own, because the builder param defaults to `[]`.
Estimated authored lines: mapping ≈120 src + 120 test; gatherer ≈60 + 100; driver template ≈70 + 140;
host wiring ≈40 + 90. All four land comfortably under the 400-line review budget — unlike the prior
change, no mid-implementation split is expected. `sdd-tasks` owns exact boundaries.

## Open Questions

- [ ] Follow-up (not v1): register the target module in `sys.modules` under its own dotted name
      before exec, which would fix the target-is-`__init__.py` gap and prepare relative-import support.
