# Design: Initial Agent Change Map MVP

## Technical Approach

A TypeScript VS Code Extension Host owns trust-sensitive Git, filesystem, process, navigation, and persistence operations. A sandboxed webview receives immutable graph/diff DTOs and emits typed intents only. A Python helper performs safe `ast`-based analysis without importing or executing project code. No implementation or npm dependency currently exists; package choices below are planned and must be introduced explicitly.

## Architecture Decisions

| Decision | Alternatives / tradeoff | Choice and rationale |
|---|---|---|
| Host/UI split | Webview filesystem/process access is unsafe | Extension Host services plus CSP-restricted webview; validate every message and keep authority host-side. |
| Language/UI | Python extension host; custom canvas | TypeScript extension layer. Planned VS Code Webview UI with SVG and a planned graph-layout library (selected during implementation), enabling accessible nodes, filtering, and exact intent IDs without claiming dependencies are installed. |
| Analysis | Runtime introspection is accurate but executes code | Spawn a bundled Python `ast` analyzer with an argument array. Emit definitions/imports/calls with evidence and `resolved\|ambiguous\|unresolved`; never import target modules. |
| Git snapshots | Checkout/temp worktree mutates state | Read via Git plumbing spawned with `shell:false`, fixed executable and argument arrays. Resolve commits to OIDs; capture tracked worktree/index content into extension storage, hash before/after, and fail if unstable. |
| Identity/editing | Names/line numbers drift | `SnapshotId={repoId,kind,resolvedOid?,contentDigest}` and `SourceId={snapshotId,posixPath,start/end byte offsets,contentHash}` are immutable. Drafts are overlays keyed by `SourceId`; direct writes require explicit worktree, hash/state compare, effect confirmation, backup, temp-file+atomic rename. |
| Execution | Host Python or composed shell is unsafe | Explicit user run invokes Docker Engine through `spawn("docker", args,{shell:false})`; create/run/remove with no network, read-only root, dropped capabilities, no-new-privileges, PID/CPU/memory/time bounds, approved read-only inputs, tmpfs output, and forced cleanup. Refuse if any control cannot be established. |

## Data Flow

```text
Git picker -> GitService(resolve/capture/diff) -> SnapshotStore -> Analyzer process
 -> Graph/Diff DTO -> webview -> node intent -> SourceProvider(hash/span check) -> editor

webview edit -> DraftStore
 -> direct-save intent -> WriteGuard(revalidate -> preview/confirm -> backup -> atomic write)

run intent -> RunPolicy -> Docker argv/create -> streamed stdout/stderr events
 -> timeout/cancel cleanup -> labeled original/current/draft results
```

Commit sources use a read-only `TextDocumentContentProvider`; worktree navigation revalidates content hash and refuses approximation. Docker streams are bounded, sequenced events; excess output is truncated with a diagnostic.

## Planned File Changes

| Path | Action / responsibility |
|---|---|
| `package.json`, `tsconfig.json` | Create extension manifest/build configuration and explicitly add selected dependencies. |
| `src/extension.ts`, `src/protocol.ts` | Create activation/commands and validated host-webview contracts. |
| `src/git/gitService.ts`, `src/snapshots/snapshotStore.ts` | Create reference resolution, stable capture, diff, virtual source storage. |
| `src/analysis/pythonAnalyzer.ts`, `python/analyzer.py` | Create subprocess adapter and AST JSON-lines analyzer. |
| `src/navigation/sourceProvider.ts` | Create exact state/span navigation. |
| `src/editing/draftStore.ts`, `src/editing/writeGuard.ts` | Create overlay persistence and guarded atomic writes. |
| `src/execution/dockerRunner.ts` | Create policy, Docker lifecycle, bounded streaming/cleanup. |
| `webview/index.ts`, `webview/graphView.ts`, `webview/styles.css` | Create CSP UI, SVG graph, section/filter/diff/editor/results views. |
| `test/unit/**`, `test/integration/**`, `test/e2e/**`, `test/fixtures/**` | Create tests and adversarial repositories. |

## Interfaces / Contracts

```ts
interface AnalysisGraph { snapshot: SnapshotId; nodes: Entity[]; edges: Edge[]; diagnostics: Diagnostic[] }
type EdgeResolution = {kind:"resolved"; target:string}|{kind:"ambiguous"; candidates:string[]}|{kind:"unresolved"};
interface DirectWrite { targetWorktree:string; source:SourceId; baseHash:string; replacement:string; confirmedEffectHash?:string }
interface RunRequest { variants:("original"|"current"|"draft")[]; inputs:ApprovedInput[]; networkApproved:boolean; limits:RunLimits }
type RunEvent = {variant:string; seq:number; channel:"stdout"|"stderr"|"status"; data:string};
```

All DTOs are schema-validated, size-bounded, and comparison-scoped.

## Testing Strategy

Unit tests cover AST fixtures, identities, DTO validation, diff correlation, draft overlays, policy/argv generation, and write races. Integration tests use temporary Git repositories, real analyzer processes, mocked Docker Engine CLI, then Docker-gated restriction/cleanup tests. VS Code e2e tests exercise both diagram forms, exact navigation, stale-source refusal, draft restore, confirmed direct saves, explicit run, streaming, cancellation, and oversized-map consent.

## Threat Matrix

| Boundary | Status/reason | Safe and failure behavior | Concrete RED tests |
|---|---|---|---|
| Documentation-like paths | Applicable: execution classifies snippets | Only `.py` source spans; reject `requirements.txt`, `CMakeLists.txt`, executable `.md/.mdx`, `README.sh` without Docker creation | One rejection test per named class; valid `.py` accepted |
| Git repository selection | Applicable | Canonical repository/worktree membership is authority; fixed cwd/argv; reject escapes/foreign repos without mutation | `-C`-like input, relative escape, absolute foreign path |
| Commit state | Applicable | Comparison never writes index/worktree; dirty tracked capture is stable or fails; staged/unstaged remain unchanged | staged, commit-a-like dirty worktree, empty index; assert byte/status equality |
| Push state | N/A: no push capability | No push/ref destination exists | None |
| PR commands | N/A: no PR automation | No PR command exists | None |

Applicable cases must propagate unchanged to tasks and begin as RED tests.

## Migration / Rollout

No migration required. Ship disabled-by-default execution commands; deleting extension storage removes snapshots/drafts after warning, while backups remain recoverable.

## Open Questions

None.