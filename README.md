# Agent Change Map

Agent Change Map is a planned VS Code extension for understanding and safely experimenting with changes between two Python code states. It will turn Python structure, calls, imports, and diffs into navigable diagrams while keeping execution explicit and isolated.

> **Status: pre-alpha, pre-implementation.** The repository currently contains design and specification work, not an installable extension. There are no supported releases, setup commands, or published dependencies yet.

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

The implementation is being designed through the specifications under `openspec/`. Those artifacts describe intended behavior and security constraints; they are not evidence that the product has been implemented or validated.

No installation or development commands are documented yet because the toolchain and dependencies have not been introduced. They should be added only when they exist and can be verified.

## Contributing

Contributions to specifications, threat modeling, tests, and later implementation are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
