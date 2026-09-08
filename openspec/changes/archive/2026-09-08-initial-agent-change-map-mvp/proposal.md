# Proposal: Initial Agent Change Map MVP

## Intent

Create a VS Code extension for understanding and safely experimenting with changes between two Python code states through navigable diagrams, editable comparisons, and opt-in isolated execution.

## Scope

### In Scope
- Analyze Python packages, modules, classes, functions, calls, and imports.
- Compare two manually selected commits, branches, or worktrees.
- Render whole-project or sectioned diagrams; nodes navigate to exact sources and show affected diffs.
- Edit comparison boxes through Docker-backed drafts (default) or guarded direct-worktree mode.
- On explicit action, run changed snippets in restricted disposable containers and compare original/current/draft output or errors.

### Out of Scope
- Non-Python languages, automatic refactoring/merging, silent overwrites, autonomous execution.
- Cloud execution, deployment, background tests, or full-project build orchestration.

## Capabilities

### New Capabilities
- `python-structure-analysis`: Extract Python structure, calls, imports, and source spans.
- `git-state-comparison`: Compare two selected commits, branches, or worktrees without mutation.
- `change-map-visualization`: Provide both diagram forms, exact navigation, and affected diffs.
- `guarded-comparison-editing`: Provide isolated drafts and conflict-safe worktree editing.
- `sandboxed-snippet-execution`: Explicitly compare snippets in restricted disposable containers.

### Modified Capabilities
None; no existing specifications exist.

## Approach

Separate analysis, Git snapshot/diff, diagram, editing, and sandbox services behind VS Code commands/views. Use immutable inputs, source-span identities, isolated drafts, pre-write validation, and per-run Docker restrictions.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| VS Code extension | New | Selection, diagrams, navigation, diffs, editing |
| Analysis/Git services | New | Structure graph and comparison |
| Docker boundary | New | Restricted execution and result comparison |

## Security Implications

Treat repositories/snippets as untrusted. Require explicit execution; deny network by default; bound CPU, memory, time, mounts, and filesystems; discard containers. Detect stale/conflicting worktrees, confirm destructive replacements, never overwrite silently, and surface all output/errors.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Dynamic-call inaccuracies | High | Mark ambiguity; retain source evidence |
| Unusable large diagrams | Medium | Sectioning, filters, giant-map opt-in |
| Lost edits | Medium | Draft default, state checks, backups |
| Sandbox abuse | Low | Minimal privileges, quotas, timeout, cleanup |

## Rollback Plan

Disable the extension and delete disposable state. Restore direct edits from backups or Git. Comparison remains read-only and requires no repository migration.

## Dependencies

- VS Code APIs, Git, Python parsing, and user-available Docker.

## Success Criteria

- [ ] Representative projects produce all scoped entities/relations with correct navigation.
- [ ] Every valid supported reference pair compares without mutation.
- [ ] Both diagram modes expose diffs; editing prevents unconfirmed conflicting/destructive writes.
- [ ] Snippet runs enforce limits, clean up, and compare output/errors across three variants.
