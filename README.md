# Agent Change Map

Agent Change Map is a planned VS Code extension for understanding and safely experimenting with changes between two Python code states. It will turn Python structure, calls, imports, and diffs into navigable diagrams while keeping execution explicit and isolated.

> **Status: pre-alpha.** All five MVP work units in `openspec/changes/initial-agent-change-map-mvp/tasks.md` are implemented and tested (see [Development and testing](#development-and-testing) below), but there is still no packaged/published release.

## What the MVP is intended to do

1. Let a user manually select two Git commits, branches, or worktrees.
2. Analyze Python packages, modules, classes, functions, calls, and imports without importing project code.
3. Show whole-project or sectioned change diagrams.
4. Navigate diagram nodes to exact source spans and expose affected diffs.
5. Allow edits in isolated draft boxes by default, with a guarded direct-worktree option.
6. Run selected changed Python snippets only after an explicit user action, in restricted disposable Docker containers.
7. Compare output or errors across original, current, and draft variants.

## Safety model

Repositories and snippets are treated as untrusted input. The planned MVP separates read-only comparison, editing, and execution:

- Comparison must not mutate the selected Git states.
- Source navigation must use validated file identities and exact spans rather than approximate matches.
- Draft edits remain isolated unless the user deliberately chooses a direct-worktree write.
- Direct writes must detect stale or conflicting content and must never overwrite silently.
- Snippet execution is opt-in, Docker-only, resource-bounded, network-denied by default, and disposable.
- If required isolation controls cannot be established, execution must be refused.

Docker isolation reduces risk; it is not a guarantee that arbitrary code is safe.

## MVP boundaries

### In scope

- Python structure, call, and import diagrams
- Manual comparison of commits, branches, and worktrees
- Whole-project and sectioned views
- Exact source navigation and affected diffs
- Editable isolated drafts and guarded direct comparison boxes
- Explicit restricted disposable Docker snippet runs

### Out of scope

- Languages other than Python
- Automatic refactoring or merging
- Silent file replacement
- Autonomous or background execution
- Cloud execution, deployment, or full-project build orchestration

## Current repository contents

The specifications under `openspec/` describe intended behavior and security constraints and drove the implementation via strict TDD (RED test, then GREEN implementation, then REFACTOR, per work unit). See [Development and testing](#development-and-testing) for how to build, lint, typecheck, and run the test suite - including a real VS Code Extension Development Host end-to-end run.

## Development and testing

The implementation now includes a real (though still MVP-scoped) VS Code extension: an
`agentChangeMap.compare` command wired in `src/extension.ts`, a strict-CSP webview
(`webview/index.ts`, `webview/graphView.ts`, `webview/styles.css`) that renders the
change-map graph as SVG, and host-side orchestration in `src/webviewHost.ts` that mediates
every navigation, draft/direct-save, and Docker-run intent from the webview.

```bash
npm install
npm run build        # compiles the extension host (out/src) and the webview bundle (out/webview)
npm run lint          # eslint over src, test, and webview
npm run typecheck     # tsc --noEmit over the extension-host and webview tsconfigs
npm test              # vitest unit + integration suite (no Docker, no VS Code required)
npm run test:docker   # gated: requires a reachable Docker daemon
npm run test:e2e      # real VS Code Extension Development Host end-to-end run
```

### Try the comparison workflow

1. Open a Git workspace in the Extension Development Host and run **Agent Change Map: Compare Python Changes** from the Command Palette. Enter the base reference and a current reference (blank means the workspace worktree).
2. Select a node, inspect the paired source spans, and choose **Left source** or **Right source**. Relationship labels expose their source and available target candidates. Section, relationship, and change filters are available before rendering a large map.
3. Edit the **Snippet draft** and choose **Save draft**. This never changes repository files. **Apply snippet to worktree…** preserves the surrounding captured file bytes and presents the complete before/after effect for explicit confirmation. Changed worktree content is refused rather than overwritten.
4. Select run variants and choose **Run selected variants…**. Confirm the displayed frozen source and Docker restrictions; output arrives live, and **Cancel run** requests cleanup. Unavailable variants and runner/cleanup errors remain explicit.

`test/unit/webviewDom.test.ts` uses jsdom to click the production controls and send their messages through a real `ChangeMapSession`. This complements, but does not replace, the real-host tests below: jsdom is not Electron and cannot prove native webview CSP/layout behavior.

### What `npm run test:e2e` actually does

`scripts/vscode-harness.mjs` is a genuine end-to-end harness, not a stub:

1. Builds the extension host and webview bundles.
2. Creates a real two-commit Git fixture repository on disk.
3. Downloads (and caches under `.vscode-test/`) a real VS Code build via
   `@vscode/test-electron`, and launches it as a real Extension Development Host with the
   fixture repository open as its workspace folder.
4. Runs `test/e2e/scenarios.ts` (compiled to `out/test/e2e`) inside that real host. The
   scenarios invoke the contributed `agentChangeMap.compare` command to activate the extension normally (without calling `extension.activate()`), then run it
   against the real fixture commits (exercising the real `GitService`, the real Python
   `ast` analyzer subprocess, `SnapshotStore`, and `correlateDiff`), and then exercise:
   exact navigation (opens a real editor), stale-navigation refusal, draft save, a guarded
   direct write with an explicit preview/confirm round trip that performs a real atomic
   file write, oversized-map consent gating, and - when a Docker daemon is reachable -
   an explicit run with streamed lifecycle events and an explicit cancel that verifies
   real container cleanup.

**One deliberate scope limitation, not an environment failure:** VS Code's public
extension API has no supported way to script mouse clicks or DOM events *inside* a
webview's own HTML content from a test running in the extension host (that would require
a heavier tool such as Selenium-based `vscode-extension-tester` driving the whole
Electron window, which this project does not depend on). Because of that, the "user acts
inside the webview" step in each scenario calls the exact same
`ChangeMapSession.handleIntent(...)` entry point that the webview's `postMessage` would
have invoked, running through the identical message-validation and orchestration code the
real webview drives. Every VS Code-side effect the scenarios assert on - the created
webview panel, the opened editor, the file written to disk, the Docker container
lifecycle - is real; only the pixel-level "click inside the iframe" step is replaced by
its exact code-level equivalent.

If no `docker` daemon is reachable in the environment `npm run test:e2e` runs in, the
explicit run/stream/cancel assertions are skipped with a logged, explicit reason
(`[e2e] Skipping explicit run/stream/cancel assertions: ...`) rather than being silently
omitted or reported as passing; every other scenario still runs. `npm run test:docker`
has the same real-Docker requirement and is intentionally excluded from the default
`npm test` run for the same reason the project's own review-workload forecast gates it
separately.

If the environment running `npm run test:e2e` has no display and no software rendering
available for Electron, or cannot download a VS Code build (no network egress), the
Extension Development Host itself cannot launch; in that case the harness's download or
launch step fails with an explicit error naming the missing capability, rather than
reporting a false pass.

## Contributing

Contributions to specifications, threat modeling, tests, and later implementation are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
