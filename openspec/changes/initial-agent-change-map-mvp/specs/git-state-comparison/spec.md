# Git State Comparison Specification

## Purpose

Define read-only validation, selection, and comparison of two Git-backed code states.

## Requirements

### Requirement: Validate comparison references

The system MUST validate each user-selected commit, branch, or worktree reference before comparison and MUST preserve the exact selected identity and resolved state. Validation MUST NOT create, switch, reset, update, or delete repository references or worktrees.

#### Scenario: Validate supported references

- GIVEN two existing supported references in a repository
- WHEN comparison is requested
- THEN each reference is resolved to an immutable state and its selected and resolved identities are reported

#### Scenario: Reject an invalid reference

- GIVEN either reference is missing, ambiguous, unsupported, or belongs to another repository
- WHEN comparison is requested
- THEN the system MUST reject the comparison with a reference-specific error and MUST NOT mutate the repository

### Requirement: Compare selected states without mutation

The system MUST compare the resolved states in the user-selected left-to-right order and MUST NOT alter the index, working tree, references, or worktree registrations.

#### Scenario: Compare two states

- GIVEN two valid resolved states with Python changes
- WHEN comparison is requested
- THEN the result identifies additions, removals, and modifications from left state to right state

#### Scenario: Repository has unrelated local changes

- GIVEN a repository with staged, unstaged, or untracked local content not selected as an input
- WHEN two other states are compared
- THEN local content remains unchanged and is excluded from the result

### Requirement: Represent worktree state precisely

When a selected worktree includes tracked working-copy or index differences, the system MUST compare the captured selected content and MUST identify that input as a worktree state rather than mislabeling it as its HEAD commit.

#### Scenario: Compare a dirty worktree

- GIVEN a selected worktree with tracked changes relative to HEAD
- WHEN it is compared with another valid state
- THEN the result includes those selected tracked changes and distinguishes the worktree state from HEAD

#### Scenario: Selected worktree changes during capture

- GIVEN a selected worktree changes while its comparison state is being captured
- WHEN a consistent state cannot be established
- THEN comparison MUST fail as stale or unstable rather than combining content from different moments

### Requirement: Produce source-correlated differences

For changed Python content, the system MUST correlate file differences with analyzable entities and source spans in both states, while retaining file-level differences that cannot be structurally correlated.

#### Scenario: Function changes

- GIVEN a function differs between valid selected states
- WHEN comparison completes
- THEN the result associates the affected entity with its left and right spans and changed text ranges

#### Scenario: Changed file cannot be analyzed

- GIVEN a changed Python file is invalid or lacks a corresponding entity in one state
- WHEN comparison completes
- THEN its file-level difference remains available with a structural-analysis diagnostic
