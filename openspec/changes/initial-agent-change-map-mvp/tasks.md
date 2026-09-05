# Tasks: Initial Agent Change Map MVP

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 2,400–3,400 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Tracker branch → PR 1 → PR 2 → PR 3 → PR 4 → PR 5 |
| Delivery strategy | auto-chain (user approved) |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| 1 / PR 1 | Tooling, protocol, analyzer | `npm run test:unit -- analyzer protocol` | `npm run analyze:fixture` | Manifests, `src/protocol.ts`, analyzer/fixtures |
| 2 / PR 2 | Git comparison/navigation | `npm run test:integration -- git navigation` | `npm run harness:git` | `src/{git,snapshots,navigation}/` |
| 3 / PR 3 | Drafts/guarded writes | `npm run test:integration -- editing` | `npm run harness:editing` | `src/editing/`, fixtures |
| 4 / PR 4 | Restricted execution | `npm run test:integration -- docker` | `npm run test:docker` (real Docker) | `src/execution/`, fixtures |
| 5 / PR 5 | Extension/webview | `npm run test:e2e` | `xvfb-run -a npm run test:e2e` | `src/extension.ts`, `webview/`, e2e fixtures |

## Phase 1: Foundation

- [x] 1.1 Create `package.json`, `tsconfig.json`, dependencies, test/quality scripts, VS Code/Python harnesses, and `test/{unit,integration,e2e,fixtures}/` first.
- [x] 1.2 RED DTO tests; GREEN create `src/protocol.ts`; REFACTOR IDs/schemas.
- [x] 1.3 RED AST tests for entities, imports, resolved/ambiguous/unresolved calls, spans, syntax diagnostics; GREEN create `python/analyzer.py` and `src/analysis/pythonAnalyzer.ts`; REFACTOR JSON-lines.

## Phase 2: Git and Sources

- [ ] 2.1 RED `test/integration/gitSelection.test.ts`: reject `-C`-like input, relative escape, absolute foreign path without mutation; GREEN create canonical membership/fixed argv in `src/git/gitService.ts`.
- [ ] 2.2 RED `test/integration/gitState.test.ts`: staged, commit-a-like dirty worktree, empty index; assert byte/status equality; GREEN implement stable capture, IDs, diffs, instability failure in `src/git/gitService.ts` and `src/snapshots/snapshotStore.ts`.
- [ ] 2.3 RED exact commit/worktree span and stale-refusal tests; GREEN create `src/navigation/sourceProvider.ts` and structural/file diff correlation; REFACTOR virtual sources.

## Phase 3: Guarded Editing

- [ ] 3.1 RED isolated save/reopen and repository-equality tests; GREEN create SourceId overlays in `src/editing/draftStore.ts`.
- [ ] 3.2 RED invalid target, stale race, confirmation/decline, backup, failed atomic-write tests; GREEN create `src/editing/writeGuard.ts`; REFACTOR effect receipts.

## Phase 4: Restricted Execution

- [ ] 4.1 RED `test/unit/runPolicy.test.ts`: reject `requirements.txt`, `CMakeLists.txt`, executable `.md/.mdx`, `README.sh` without Docker creation; accept valid `.py`; GREEN add policy to `src/execution/dockerRunner.ts`.
- [ ] 4.2 RED required no-network, read-only, capability, privilege, PID/CPU/memory/time, tmpfs, input, and refusal tests; GREEN implement fixed-argv Docker lifecycle.
- [ ] 4.3 RED variant labels, bounded streams, missing/timeout/cancel/failure cleanup tests; GREEN implement results/cleanup; REFACTOR states.

## Phase 5: UI and Verification

- [ ] 5.1 RED CSP/intents, whole/section SVG, filters, uncertainty/status, diffs, oversized-consent tests; GREEN create `webview/{index.ts,graphView.ts,styles.css}`.
- [ ] 5.2 RED VS Code e2e selection, exact/stale navigation, draft/direct save, explicit run/stream/cancel, oversized consent; GREEN wire `src/extension.ts`.
- [ ] 5.3 REFACTOR; run `npm run lint && npm run typecheck && npm test && npm run test:e2e` plus gated `npm run test:docker`; document skips in `README.md`.
