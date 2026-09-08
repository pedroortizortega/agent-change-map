# Guarded Comparison Editing Specification

## Purpose

Define isolated draft editing and conflict-safe direct updates from comparison content.

## Requirements

### Requirement: Default to isolated drafts

Editing comparison content MUST create or update draft content isolated from repository worktrees unless the user explicitly selects direct-worktree mode. Draft saves MUST persist across view closure and MUST NOT modify either compared state.

#### Scenario: Save a draft

- GIVEN comparison content and no direct-worktree selection
- WHEN the user edits and saves it
- THEN the draft is persisted separately and repository files, index, and references remain unchanged

#### Scenario: Reopen a draft

- GIVEN a persisted draft for comparison content
- WHEN the user reopens that content
- THEN the latest saved draft and its base-state identity are restored

### Requirement: Make persistence mode explicit

The editor MUST identify whether content is original, current, or draft and whether saving targets isolated draft storage or a worktree. Switching to direct-worktree mode MUST require explicit user selection of the target worktree.

#### Scenario: Enter direct mode

- GIVEN editable comparison content in draft mode
- WHEN the user explicitly selects a valid target worktree for direct editing
- THEN the pending save target is clearly identified without writing content

#### Scenario: Invalid direct target

- GIVEN a target that is not an available worktree or does not contain the intended file
- WHEN direct mode is selected
- THEN the system MUST reject the target without altering files

### Requirement: Detect stale or conflicting writes

Before every direct write, the system MUST verify the target file and relevant worktree state still match the state on which the edit was based. It MUST block stale, overlapping, or ambiguous updates and MUST NOT overwrite silently.

#### Scenario: Apply a current edit

- GIVEN the target remains identical to the recorded edit base
- WHEN the user explicitly saves in direct mode
- THEN the intended content is written and the resulting target identity is reported

#### Scenario: Target changed externally

- GIVEN the target changed after the edit base was recorded
- WHEN a direct save is requested
- THEN the write is blocked as stale or conflicting and the current target and pending edit are preserved for review

### Requirement: Guard destructive replacement and recovery

A direct write that removes or replaces existing target content MUST present the exact pending effects and require explicit confirmation. Before a confirmed write, the system MUST preserve recoverable prior content; failed writes MUST leave no partial replacement.

#### Scenario: Confirm destructive write

- GIVEN a current edit would remove or replace existing content
- WHEN the user reviews the exact effect and confirms
- THEN recoverable prior content is preserved before the complete write is applied

#### Scenario: Decline or fail a write

- GIVEN a destructive write is declined or cannot complete
- WHEN the operation ends
- THEN the original target remains intact and the draft or pending edit remains available
