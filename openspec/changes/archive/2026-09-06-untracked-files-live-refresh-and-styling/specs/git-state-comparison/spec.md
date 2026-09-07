# Specification: Git State Comparison

## Purpose

Defines how the extension captures file content from the working tree, index,
and commits to build a change map, including which files are eligible and how
mid-capture consistency is enforced.

## Requirements

### Requirement: Filter capture through a single file matcher

The system MUST route every candidate file — tracked or untracked — through one
named, reusable file-matcher abstraction to decide eligibility for capture. No
capture code path MAY perform an inline extension check outside this
abstraction. The matcher MUST be structured so that adding a new matched
language later requires no change to the capture pipeline itself.

#### Scenario: Tracked file filtered by the matcher

- GIVEN a tracked non-`.py` file in the worktree
- WHEN worktree capture builds its file list
- THEN the matcher excludes it before capture proceeds

#### Scenario: Untracked file filtered by the same matcher

- GIVEN an untracked non-`.py` file in the worktree
- WHEN worktree capture builds its file list
- THEN the matcher excludes it using the same abstraction used for tracked files

### Requirement: Worktree capture includes untracked files

Worktree capture MUST merge untracked, non-ignored files selected by the file
matcher with the tracked file list, so a file that has never been staged is
captured alongside tracked files.

#### Scenario: Never-staged file appears in worktree capture

- GIVEN a `.py` file created in the worktree and never staged
- WHEN a worktree state is captured
- THEN the file is included in the captured file set

#### Scenario: Ignored untracked file excluded

- GIVEN an untracked file excluded by `.gitignore`
- WHEN a worktree state is captured
- THEN the file is not included in the captured file set

### Requirement: Captured files carry tracked/untracked provenance

Each captured file MUST carry a flag indicating whether it originated from a
tracked or untracked source, so downstream consumers can distinguish origin
independent of change status.

#### Scenario: Provenance flag set correctly

- GIVEN a worktree capture containing one tracked and one untracked file
- WHEN capture completes
- THEN the tracked file's captured record is flagged tracked and the untracked
  file's record is flagged untracked

### Requirement: Mid-capture stability covers untracked files

Worktree capture's stability check MUST detect an untracked file appearing,
disappearing, or changing during capture and raise the same instability error
already raised for a tracked file changing mid-capture.

#### Scenario: Untracked file appears mid-capture

- GIVEN a worktree capture in progress
- WHEN a new untracked file is created before capture finishes
- THEN the capture raises a `GitCaptureInstabilityError`

#### Scenario: Untracked file removed mid-capture

- GIVEN a worktree capture in progress that has selected an untracked file
- WHEN that file is deleted before capture finishes
- THEN the capture raises a `GitCaptureInstabilityError`

### Requirement: Size and binary guards apply uniformly

An untracked file MUST be subject to the same file-size limit and binary-content
detection already enforced for tracked files, with no silent skip.

#### Scenario: Oversized untracked file hard-fails

- GIVEN an untracked file exceeding the configured size limit
- WHEN it is selected for capture
- THEN capture raises `GitCaptureLimitError` and does not silently omit the file

#### Scenario: Binary untracked file hard-fails

- GIVEN an untracked file with binary content
- WHEN it is selected for capture
- THEN capture raises `GitBinaryContentError` and does not silently omit the file

### Requirement: Commit-state capture is unaffected

Capturing the state of a specific commit MUST NOT consider untracked files,
since a commit's git object has no untracked content by definition.

#### Scenario: Commit capture ignores worktree untracked files

- GIVEN an untracked file present in the worktree
- WHEN a specific commit's state is captured
- THEN the untracked file has no effect on the captured result
