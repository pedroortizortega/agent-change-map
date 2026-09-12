# Delta for Sandboxed Snippet Execution

## MODIFIED Requirements

### Requirement: Control accessible content

The execution environment MUST receive only the selected snippets and explicitly approved supporting inputs. Repository and host mounts MUST be limited to declared paths and MUST be read-only unless the user separately approves a bounded writable output location.

For introspection and invocation runs specifically, the execution environment MAY additionally receive every snapshot file matched by the project's existing source-file matcher, delivered as in-memory importable Python modules via the same stdin-only delivery used for the target's own content — never via a bind mount, never via host filesystem access, and never via network. This bundled delivery exists solely to resolve same-repo absolute Python imports (`import config`, `from config import ENV1`, including transitive imports among bundled files) during introspection or invocation of the selected target. An import that resolves to a dotted module name with no corresponding entry in that matched, bundled set MUST fail with an ordinary `ModuleNotFoundError`, exactly as real Python reports a genuinely missing module — this is expected behavior, not a defect, and requires no special-casing beyond Python's own import machinery.

#### Scenario: Read approved input

- GIVEN a run includes an explicitly approved supporting input
- WHEN the snippet executes
- THEN that input is available only at the declared location and other repository or host content is unavailable

#### Scenario: Reject an undeclared access

- GIVEN a snippet attempts to access an undeclared host path or writable location
- WHEN it executes
- THEN access MUST fail without modifying host or repository content

#### Scenario: Introspection target resolves a same-repo absolute import

- GIVEN a selected target's file contains `from config import ENV1`, and `config.py` is present in the same snapshot and matched by the source-file matcher
- WHEN the target is introspected or invoked
- THEN `config.py`'s actual content is available inside the sandbox as an importable module and the import succeeds without any host filesystem access or bind mount

#### Scenario: Transitive same-repo import resolves

- GIVEN the selected target's file imports `config`, and `config.py` itself imports `helpers`, and both `config.py` and `helpers.py` are present in the same snapshot and matched by the source-file matcher
- WHEN the target is introspected or invoked
- THEN both imports resolve successfully using the bundled content, without needing a direct import of `helpers` from the target's own file

#### Scenario: Genuinely uncaptured local import fails as an ordinary missing module

- GIVEN the selected target's file imports a module whose corresponding file is not present in the matched, bundled set (outside the matcher, ignored, or genuinely absent from the snapshot)
- WHEN the target is introspected or invoked
- THEN the run reports a standard `ModuleNotFoundError` for that module name, with no crash, hang, or other failure mode

#### Scenario: The target's own file is never double-embedded via the bundle

- GIVEN the selected target's own file is present in the snapshot and would otherwise match the source-file matcher
- WHEN the bundle of other importable modules is assembled for that run
- THEN the target's own file, identified by exact posixPath equality against the target's own source id, is excluded from the bundle and is never embedded or executed a second time

#### Scenario: Bundled file content still cannot escape its embedding envelope

- GIVEN any bundled file's content contains an adversarial value from the same class already covered for the target's own embedded source (for example a raw `'''`, an embedded newline followed by `_t=__import__('os')`, a null byte, or non-ASCII characters)
- WHEN the driver script is generated with that file included in the bundle
- THEN the generated script contains that file's content only as a base64-alphabet literal, never as a raw substring, identically to the existing invariant already enforced for the target's own embedded source — the invariant now holds per-file across the whole bundle, not only for the target file

## ADDED Requirements

### Requirement: Map a captured file path to a deterministic dotted module name

Granularity note: this mapping is a small, independently-testable pure function, but it is specified here (rather than as a separate capability) because it exists solely to serve the "Control accessible content" bundling behavior above and has no meaning outside it.

Given a captured file's posixPath from a matched snapshot, the system MUST derive a dotted Python module name deterministically, following classic (`__init__.py`-required) package semantics rather than implicit namespace-package semantics: a directory is treated as an importable package segment only if that directory's own `__init__.py` is present in the same matched, bundled set.

#### Scenario: Flat file at the root maps to its own name

- GIVEN a matched file at posixPath `foo.py`
- WHEN its dotted module name is derived
- THEN the result is `foo`

#### Scenario: File inside a package directory with `__init__.py` maps through the package

- GIVEN a matched file at posixPath `pkg/mod.py`, and `pkg/__init__.py` is also present in the same matched, bundled set
- WHEN its dotted module name is derived
- THEN the result is `pkg.mod`

#### Scenario: A package's own `__init__.py` maps to the package name

- GIVEN a matched file at posixPath `pkg/__init__.py`
- WHEN its dotted module name is derived
- THEN the result is `pkg`

#### Scenario: File inside a directory missing `__init__.py` is not treated as a package member

- GIVEN a matched file at posixPath `pkg/mod.py`, and `pkg/__init__.py` is NOT present in the matched, bundled set
- WHEN the bundle is assembled
- THEN `pkg/mod.py` is excluded from the importable bundle rather than being imported under a namespace-package-style dotted name; a target importing `pkg.mod` in this situation MUST fail with an ordinary `ModuleNotFoundError`, exactly as it would if `pkg/mod.py` had never been captured

> Design note (flagged, not fully resolved here): the scenario above specifies the fallback for a directory that never has an `__init__.py` anywhere in the matched set. It intentionally leaves unresolved the exact `__path__`/partial-package construction rule for a package that IS rooted by a present `__init__.py` but whose submodule tree is only **partially** captured (e.g. `pkg/__init__.py` and `pkg/sub/mod.py` are both matched, but `pkg/sub/__init__.py` is not). This is the residual `__path__` design detail the proposal explicitly deferred to `sdd-design`; this spec only guarantees that a directory with no `__init__.py` anywhere in the set is never treated as a package.

## Non-Goals (explicit exclusions)

- Relative imports (`from . import x`, `from ..pkg import y`) are NOT supported by this change. They fail exactly as real Python fails them outside a real package/`__package__` context; no relative-import resolution is attempted.
- Standard-library and third-party package imports are NOT bundled by this change and continue to fail exactly as they did before this change when genuinely unavailable in the sandbox's Python installation.
- Draft-splicing (unsaved editor content overriding a file's stored content) applies ONLY to the target's own file. Unsaved edits in any other bundled file are never reflected in the bundle; the bundle always uses that file's stored snapshot content.
