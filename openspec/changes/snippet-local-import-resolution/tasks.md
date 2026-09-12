# Tasks: Local-import resolution for the introspection/call sandbox

Strict TDD: every implementation task is preceded by its RED test task (test written and
observed failing before the corresponding production code is written). Tasks are grouped by
slice per design.md's "Sequencing" section: mapping → gatherer → driver template → host wiring.
Per design.md's own line estimates (all four slices comfortably under the 400-line review
budget), **no PR split is expected**; each slice ships as exactly one PR
(`delivery_strategy=ask-on-risk`, `chain_strategy=stacked-to-main`, matching the prior change's
convention). See "Review Workload Forecast" and "Delivery Plan" below.

No slice references a later slice's symbols. Revert order is 4 → 3 → 2 → 1 (each slice is
additive per design's Migration/Rollout section).

---

## Slice 1 — Path→dotted-module-name mapping (pure)

Depends on: nothing (first slice, no dependency on any prior change beyond what's already
merged). Unblocks: Slice 2 (`gatherImportBundle` needs this mapping).

### 1.1 — `mapPathsToModules` pure function

- [x] **RED**: `test/unit/pythonModuleName.test.ts` (new) — table-driven cases:
      - flat file at root: `foo.py` → `foo` (not a package).
      - package member: `pkg/mod.py` + `pkg/__init__.py` present in the same input → `pkg.mod`,
        plus `pkg` itself as a package entry (isPackage: true).
      - a package's own `__init__.py` alone maps to the package name (`pkg/__init__.py` → `pkg`).
      - nested multi-level packages: `a/b/c.py` with both `a/__init__.py` and `a/b/__init__.py`
        present → `a.b.c`, plus `a` and `a.b` package entries.
      - missing intermediate `__init__.py`: `pkg/mod.py` present but `pkg/__init__.py` NOT
        present in the input → `pkg/mod.py` excluded entirely from the output (not emitted under
        a namespace-style dotted name).
      - non-identifier directory/file names (e.g. a segment starting with a digit or containing
        a hyphen) excluded from the output.
      - `pkg.py` vs `pkg/__init__.py` collision (both present in input) → package wins (mirrors
        CPython `FileFinder` package-before-module precedence).
      - empty input array → empty output array.
      - root-level `__init__.py` (empty dotted name) is skipped, not emitted as `""`.
      - output is sorted by `dottedName`.
      Satisfies: spec `sandboxed-snippet-execution`, ADDED Requirement "Map a captured file path
      to a deterministic dotted Python module name" — all five scenarios ("Flat file at the root
      maps to its own name", "File inside a package directory with `__init__.py` maps through
      the package", "A package's own `__init__.py` maps to the package name", "File inside a
      directory missing `__init__.py` is not treated as a package member", plus the collision/
      sort/identifier rules from design.md's Interfaces section).
- [x] **GREEN**: `src/execution/pythonModuleName.ts` (new) — `PythonModuleEntry` interface,
      `mapPathsToModules(posixPaths)`; pure, no I/O, per design's Interfaces/Contracts section.

**Slice 1 exit criteria**: the mapping function is fully covered by the design's table, including
every edge case (missing `__init__.py`, collision, non-identifier segments, empty input). No
store reads, no driver changes yet.

---

## Slice 2 — Bundle gathering (store-reading)

Depends on: Slice 1 (`mapPathsToModules` shipped and imported by the gatherer).

### 2.1 — `gatherImportBundle`

- [x] **RED**: `test/unit/sourceProvider.test.ts` (modify) — add cases:
      - target excluded by path: given a snapshot whose `files` include the target's own
        `posixPath`, `gatherImportBundle(store, snapshot, excludePosixPath)` never returns an
        entry for that exact `posixPath` (exact-equality exclusion, applied AFTER mapping so
        package detection still sees it).
      - package detection over the full file set: a snapshot containing `pkg/__init__.py` and
        `pkg/mod.py` (neither being the excluded target) yields `BundledModule` entries for both
        `pkg` and `pkg.mod`, with `isPackage` set correctly on each.
      - unknown snapshot id → `store.get(snapshot)` returns `undefined` → `gatherImportBundle`
        returns `[]`, does not throw (target's own resolution already raises `StaleSourceError`
        elsewhere; the gatherer must not duplicate that failure mode).
      - correct field use: the fixture's captured-state file objects use the `path` field (not
        `posixPath`) per `CapturedState.files[]` shape in `src/git/gitService.ts`; assert the
        gatherer reads `.path`, not a non-existent `.posixPath` on the DTO.
      - no second matcher filter: a fixture with a `.txt` file the real `SnapshotStore` would
        never contain (because `captureCommitState`/`listTrackedPaths`/`listUntrackedPaths`
        already filter by `defaultSourceFileMatcher`) is out of scope for this test — assert only
        that the gatherer performs no additional extension/matcher filtering of its own beyond
        the posixPath-equality exclusion (i.e., it maps every file in the snapshot, trusting
        upstream filtering).
      Satisfies: spec `sandboxed-snippet-execution`, MODIFIED Requirement "Control accessible
      content" — scenarios "Introspection target resolves a same-repo absolute import",
      "Transitive same-repo import resolves" (bundle must include every matched file, enabling
      transitive resolution downstream), "The target's own file is never double-embedded via the
      bundle", and "Genuinely uncaptured local import fails as an ordinary missing module"
      (unknown snapshot / missing `__init__.py` degrade path).
- [x] **GREEN**: `src/navigation/sourceProvider.ts` (modify) — `BundledModule` interface,
      `gatherImportBundle(store, snapshot, excludePosixPath)`: `store.get(snapshot)` (missing ⇒
      `[]`), map the full `files` list's `.path` values through `mapPathsToModules`, attach each
      mapped entry's source content, drop the entry whose `posixPath === excludePosixPath` after
      mapping.

**Slice 2 exit criteria**: given a `SnapshotStore` and a target's own `posixPath`, the gatherer
produces the exact bundle the driver template (Slice 3) will consume — fully covered including
the unknown-snapshot and target-exclusion edge cases. No driver changes yet.

---

## Slice 3 — Driver bootstrap (bundle literal + `sys.meta_path` finder)

Depends on: nothing from Slices 1–2 at the type level (the builders take an already-assembled
`BundledModule[]`) — independently testable per design's "builder param defaults to `[]`"
decision, though logically it will be wired to Slice 2's output in Slice 4.

### 3.1 — `buildBundleBootstrap` + optional `bundle` param on both builders

- [ ] **RED**: `test/unit/callDriver.test.ts` (modify) — add cases:
      - bundle literal round-trip: given a `bundle` with one or more `BundledModule` entries,
        extract the `_BUNDLE = json.loads(base64.b64decode("..."))` literal via a regex (mirroring
        the existing `extractBundleLiteral`-style helper pattern already used for `_SRC`/`_ARGS`),
        base64-decode it, `JSON.parse` it, and assert the resulting dict's keys/values (`source`,
        `isPackage` per dotted name) equal the input bundle.
      - bootstrap presence: with a non-empty bundle, the generated driver text contains
        `sys.meta_path.insert` (proves the finder is installed) and defines both `_AcmLoader` and
        `_AcmFinder`.
      - empty bundle ⇒ byte-identical output: calling `buildIntrospectionDriver`/`buildCallDriver`
        with `bundle: []` (or omitted) produces driver text byte-identical to today's output with
        no `bundle` argument at all — proves existing callers/tests are unaffected.
      - **SECURITY-CRITICAL adversarial (reuses the existing `adversarialValues` array, now as
        bundled-file content)**: for each value in the existing `adversarialValues` array (raw
        `'''`, embedded newline + `_t=__import__('os')`, NUL byte, non-ASCII), construct a bundle
        with that value as a bundled module's `source`, generate the driver, and assert (a) the
        `_BUNDLE` literal segment matches `BASE64_ONLY` (`/^[A-Za-z0-9+/=]*$/`), and (b) the raw
        adversarial substring never appears anywhere in the generated driver text — same envelope
        class already enforced for the target's own embedded source, now proven per-file across
        the whole bundle.
      Satisfies: spec `sandboxed-snippet-execution`, MODIFIED Requirement "Control accessible
      content" — scenario "Bundled file content still cannot escape its embedding envelope"
      (adversarial case); design's Threat Matrix row "Code injection via embedded content"; design
      Architecture Decision "Builder signatures" (empty-bundle byte-identity).
- [ ] **GREEN**: `src/execution/callDriver.ts` (modify) — private `buildBundleBootstrap(bundle)`
      returning `""` for an empty bundle, else the `_BUNDLE`/`_AcmLoader`/`_AcmFinder`/
      `sys.meta_path.insert` text from design.md's "Driver bootstrap" section, inserted after the
      existing `import` line and before `_m = types.ModuleType(...)`, identically in both
      `buildIntrospectionDriver` and `buildCallDriver`; add an optional trailing `bundle:
      BundledModule[] = []` parameter to both exported builders.

**Slice 3 exit criteria**: both builders accept an optional bundle and emit a correct, laziness-
preserving bootstrap; the empty-bundle path is proven byte-identical to pre-change output; the
security envelope is proven per-file across a multi-entry bundle, not just for the single target
file as before.

---

## Slice 4 — Host wiring + cache-key fix

Depends on: Slice 2 (`gatherImportBundle`) and Slice 3 (bundle-aware builders).

### 4.1 — Wire `gatherImportBundle` into `handleRequestSignature`/`handleRequestCall`

- [ ] **RED**: `test/unit/webviewHost.test.ts` (modify) — add cases:
      - `handleRequestSignature` calls `gatherImportBundle(store, sourceId.snapshot,
        sourceId.posixPath)` and passes the result as `buildIntrospectionDriver`'s trailing
        `bundle` argument (assert the driver-building seam receives the gathered bundle, not `[]`,
        when the snapshot has other matched files).
      - `handleRequestCall`/`executeCall` thread the same gathered bundle through to
        `buildCallDriver`.
      Satisfies: spec `sandboxed-snippet-execution` scenarios "Introspection target resolves a
      same-repo absolute import" and "Transitive same-repo import resolves" (host-wiring half —
      Slices 2/3 proved the pieces in isolation, this proves they are actually connected).

- [ ] **GREEN**: `src/webviewHost.ts` (modify) — `handleRequestSignature`/`handleRequestCall` call
      `gatherImportBundle` and pass the result through to `buildIntrospectionDriver`/
      `buildCallDriver`; `executeCall` threads the bundle from `handleRequestCall` through.

### 4.2 — Cache-key fix: widen the introspection LRU key to include the bundle hash

- [ ] **RED**: `test/unit/webviewHost.test.ts` (modify) — add a regression case: prime the
      introspection cache for a target whose content is unchanged, then change ONLY the content
      of an imported (bundled) file in the snapshot store (not the target's own file) and issue a
      second `requestSignature` for the same target/content — assert this is a cache MISS (a
      fresh `runIntrospection` round-trip is triggered), not a stale cache hit. Without the fix,
      `${targetId}|${sha256Hex(content)}` is unchanged because only the bundle changed, so the
      stale cached signature would incorrectly be returned.
      Satisfies: spec `sandboxed-snippet-execution` — this is a correctness bug found during
      design (not an explicit spec scenario) that the same "Control accessible content" behavior
      makes newly reachable: a signature that depends on bundled content must invalidate when that
      content changes, or the introspection result silently lies about the current code. Traced to
      design.md's "Cache-key hazard (found during design)" note.
- [ ] **GREEN**: `src/webviewHost.ts` (modify) — widen `handleRequestSignature`'s cache key from
      `` `${targetId}|${sha256Hex(content)}` `` to
      `` `${targetId}|${sha256Hex(content)}|${sha256Hex(JSON.stringify(bundle))}` ``.

**Slice 4 exit criteria**: both handlers actually gather and pass the bundle end-to-end (proving
Slices 2–3 are connected, not just independently unit-tested), and the cache-key regression is
closed with its own dedicated RED test — the design's own flagged bug does not ship silently.

---

## Optional — Docker-gated integration proof (not part of the 400-line review budget)

### I.1 — Real Docker round-trip: `from config import ENV1`

- [ ] Add one test to `test/integration/docker/dockerRunner.test.ts` (modify) — spawns a real,
      maximally-isolated Docker container (same harness/conventions as the file's existing tests)
      running a target script that does `from config import ENV1` against a bundle containing
      `config.py` with `ENV1` defined, asserting the import succeeds and the value is observed in
      stdout — round-tripping through the actual driver bootstrap and Python's real import
      machinery, not through the unit-level string assertions of Slices 3–4.
      Satisfies: spec `sandboxed-snippet-execution` scenario "Introspection target resolves a
      same-repo absolute import" (the one layer that proves the bootstrap actually executes end
      to end, per design's Testing Strategy table).

      **Confirmed scope note**: `npm run test:docker` runs `vitest run --config
      vitest.docker.config.ts`, whose `include` is scoped to `test/integration/docker/**/*.test.ts`
      and is explicitly excluded from `vitest.config.ts`'s own `include`/via its own `exclude`
      entry — so this test is NOT part of `npm test`, `npm run test:unit`, or `npm run
      test:integration`, and is never picked up by ordinary CI unless a job explicitly runs `npm
      run test:docker` with a working Docker Engine available. This task is therefore optional and
      does not gate the four slices above; it is the only layer proving real execution and should
      be run manually or in a Docker-capable CI lane before considering the change fully verified
      end to end.

---

## Review Workload Forecast

| Slice | Files touched | Design estimate (impl+test) | Reconciled estimate | Chained PR? | 400-line budget risk | Decision needed before apply? |
|---|---|---|---|---|---|---|
| 1 | `pythonModuleName.ts` (new), `pythonModuleName.test.ts` (new) | ~240 (120+120) | ~230–260 — table has 9 named cases plus sort/collision assertions; consistent with design | No — single PR | **Low** | No |
| 2 | `sourceProvider.ts` (modify), `sourceProvider.test.ts` (modify) | ~160 (60+100) | ~150–190 — gatherer body is small (map + filter + attach content); test additions include an in-memory `SnapshotStore` fixture setup cost not fully captured by the design's raw count | No — single PR | **Low** | No |
| 3 | `callDriver.ts` (modify), `callDriver.test.ts` (modify) | ~210 (70+140) | ~200–260 — the bootstrap template itself is ~25 lines of Python-as-string, but the adversarial test reuses `adversarialValues` in a loop (cheap) plus a new literal-extraction/round-trip helper adds real test weight; still the design's own estimate holds up | No — single PR | **Low–Medium** (largest test surface of the four, but same shape as slice 1a's precedent in the prior change, which landed under budget) | No |
| 4 | `webviewHost.ts` (modify), `webviewHost.test.ts` (modify) | ~130 (40+90) | ~120–160 — two call sites changed plus one cache-key line change; the dedicated cache-key regression test is the main addition beyond the design's raw estimate | No — single PR | **Low** | No |
| Optional | `test/integration/docker/dockerRunner.test.ts` (modify) | Not estimated in design (integration test, excluded from unit review budget) | ~40–60 (one new `it` block, no production code) | N/A — not part of the review-budget chain | **N/A** (Docker-gated, not part of `npm test`) | No — informational, run manually/CI-lane only |

**Confirm vs. challenge design.md's own forecast**: design.md states all four slices land
"comfortably under the 400-line review budget... no mid-implementation split is expected." This
is **confirmed** on re-estimation: even the highest reconciled estimate (Slice 3, ~200–260 lines)
leaves more than 140 lines of headroom before the 400-line budget, and none of the four slices
touches more than two files. Unlike the prior change (`extended-snippet-draft-interactive-inputs`,
whose slice 1 and 3a both blew past budget only after real implementation surfaced extra host-
wiring/UI/fixture weight the pre-implementation estimates missed), this change's slices are each
narrowly scoped to one pure function, one store-reading function, one driver-template addition, or
one two-call-site wiring change — there is no UI, no new protocol branches, and no new fixture
corpus of the kind that caused the prior change's overruns. No pre-emptive split or
`size:exception` is proposed; if real implementation exceeds budget on any slice, treat it as a
size-exception candidate at apply time rather than pre-splitting now, consistent with how Slice
3a-i was handled in the prior change.

**No decision needed before apply** for any of the four slices. The optional Docker-gated
integration task is explicitly out of the review-budget chain and requires no approval gate either
— it is recommended but not mandatory for this change to be considered code-complete, since it
exercises real Docker and is intentionally excluded from ordinary CI (`vitest.config.ts` excludes
`test/integration/docker/**`; it only runs via the separate `npm run test:docker` /
`vitest.docker.config.ts`).

---

## Delivery Plan (stacked-to-main)

`delivery_strategy=ask-on-risk`, `chain_strategy=stacked-to-main`: four PRs (plus one optional,
non-gating Docker-integration addition folded into the last PR or shipped standalone — see note),
each based on the previous PR's branch. The first PR bases on the actual current tip, not on local
`main` (which is stale in this repo — confirmed via `git status`: current checked-out branch is
`feat/extended-snippet-draft-3b-semantic-highlighting`, the final branch of the just-completed
`extended-snippet-draft-interactive-inputs` change, per that change's own Delivery Plan table).

| Order | PR branch | Base branch | Task-id range | Slice |
|---|---|---|---|---|
| 1 | `feat/snippet-local-import-1-module-name-mapping` | `feat/extended-snippet-draft-3b-semantic-highlighting` | 1.1 | 1 |
| 2 | `feat/snippet-local-import-2-bundle-gathering` | `feat/snippet-local-import-1-module-name-mapping` | 2.1 | 2 |
| 3 | `feat/snippet-local-import-3-driver-bootstrap` | `feat/snippet-local-import-2-bundle-gathering` | 3.1 | 3 |
| 4 | `feat/snippet-local-import-4-host-wiring` | `feat/snippet-local-import-3-driver-bootstrap` | 4.1–4.2 | 4 |

**Optional Docker-integration task (I.1)**: not a review-budget PR (Docker-gated tests are
excluded from ordinary CI and from the 400-line chain by design). Ship it as a small follow-up
commit on top of PR 4's branch (`feat/snippet-local-import-4-host-wiring`) before merge, or as its
own trivial PR based on that branch if the team prefers to keep Docker-dependent changes isolated
for review — `sdd-apply` should default to folding it into PR 4 unless a reviewer asks for
isolation, since it has no production code of its own.

Notes:

- Revert order mirrors the reverse of this table: 4 → 3 → 2 → 1. Each revert is clean: Slice 4's
  removal drops the `gatherImportBundle` call sites and the cache-key widening; Slice 3's removal
  drops the `bundle` parameter and bootstrap (builders return to single-file embedding); Slice 2's
  removal drops `gatherImportBundle`/`BundledModule`; Slice 1's removal drops the pure mapper —
  matching design.md's Migration/Rollout section exactly.
- Each PR's diff should be reviewed against the merged tree of its base branch, not against
  `main`, consistent with the prior change's stacked-PR workflow (and its externally-noted
  dependency on upstream chains eventually reaching `main`).
- No task in this file references a later slice's symbols; Slice 3's builder tests use bundles
  constructed inline in the test file, not Slice 2's `gatherImportBundle`, preserving independent
  testability per design.md's "Sequencing" section.
