# Archive Report: Extended Instance Method Call Resolution

**Change**: `extended-instance-resolution`  
**Archived**: 2026-09-12  
**Branch**: `feat/agent-change-map-mvp` (tracker branch, all 3 slices merged via PRs #29, #30, #45)  
**Artifact Store Mode**: Hybrid (OpenSpec files + Engram)

## Executive Summary

The `extended-instance-resolution` change extends the prior `instance-method-call-resolution` to resolve three additional shapes: type-annotated variables/parameters, cross-method class-scoped self-attribute bindings, and chained/returned-instance calls via return-type inference. All three slices (Annotations, self.attr, Chained/returned) are implemented, verified as PASS with 481/481 tests and spec-compliant across all 18 "Represent call uncertainty" scenarios. Archive includes merged spec reflecting final state, all task checkboxes normalized to completion, TODO.md rationale corrected per verify recommendations.

## Artifacts Archived

- `proposal.md` — three-slice proposal with risk analysis
- `design.md` — detailed per-slice architecture and code blocks (design exceeds phase budget per orchestrator requirement for full correctness scrutiny)
- `tasks.md` — 56 implementation tasks across Sections 0–3, all checkboxes marked complete (Sections 0–2 normalized by archive step per verify recommendations)
- `exploration.md` — prior discovery work supporting the proposal
- `verify-report.md` — full verification PASS report, 0 CRITICAL, 2 carried-forward non-blocking items (tasks.md hygiene, TODO.md wording)
- `specs/python-structure-analysis/spec.md` — merged spec snapshot (byte-identical to openspec/specs/python-structure-analysis/spec.md post-merge)

## Spec Merge Summary

### Domain: Python Structure Analysis

**Requirement**: "Represent call uncertainty"  
**Action**: MODIFIED — replaced 7-scenario requirement with expanded 18-scenario requirement  
**Changes**:
- Previous: 7 scenarios (direct calls, ambiguous, constructor calls, self-attribute unresolved, non-constructor unresolved, chained unresolved)
- New: 18 scenarios (prior 7 + 11 new covering annotations, self.attr cross-method, chained/returned calls with annotation and inference)

**Details**:
- **Slice 1 (Annotations)**: 3 new scenarios — resolve through annotated variable, annotated parameter, quoted/generic unresolved
- **Slice 2 (self.attr)**: 3 new scenarios — class-scoped self.attr binding, ambiguous multiple bindings, non-self receiver unresolved
- **Slice 3 (Chained/returned)**: 5 new scenarios — explicit return annotation, inferred constructor return, returned local variable, multiple returns ambiguous, no discernible return unresolved

**Scenarios fully verified**: All 18 passing with dedicated test coverage (tests 1–21, mapping to scenarios per verify-report Section "Spec Compliance Matrix").

## Verification Summary

**Verdict**: PASS (per verify-report observation #761, 2026-09-12)

| Metric | Result |
|--------|--------|
| Implementation status | All 3 slices (annotations, self.attr, chained/returned) complete |
| Test suite | 481/481 tests passing, including 10 new tests for slice 3 |
| Spec compliance | All 18 scenarios in "Represent call uncertainty" requirement PASS |
| Typecheck | Clean (`tsc` exit 0) |
| Lint | Clean (`eslint` exit 0) |
| CRITICAL issues | 0 |
| Non-blocking items | 2 (carried forward, archived as-is per skill guidance) |

## Non-Blocking Items Resolved at Archive

Per verify-report recommendations and explicit final-state facts provided by orchestrator:

1. **Tasks.md checkbox hygiene (Sections 0–2)**  
   - **State**: Sections 0–2 had 26 unchecked tasks despite work being merged and verified complete  
   - **Action taken**: Marked all Section 0–2 tasks `[x]` to reflect final state (Section 3 was already marked by PR #45)  
   - **Justification**: Verify-report confirmed spot-checks for all three slices; no regression on slices 1–2 when slice 3 landed; archived tasks artifact now accurately represents completion state

2. **TODO.md super() entry wording**  
   - **State**: Super() gap remains legitimately unfixed; verify-report noted the rationale sentence had become stale  
   - **Action taken**: Updated rationale from "only ast.Name and self.attr" to clarify that slice 3 added an ast.Call arm but it doesn't help with super() because super is a builtin (not resolved through _lexical_candidates), unlike chained calls through functions/methods  
   - **Justification**: Verdict unchanged (super() remains unresolved), explanation now accurate to post-slice-3 code

## Task Completion Status

| Section | Tasks | Actual state | Archive checkbox state | Notes |
|---------|-------|--------------|------------------------|-------|
| 0 — Setup | 1 | Complete (tracker branch existed, 3 PRs based off it) | [x] ✓ normalized |
| 1 — Annotations (PR #29) | 10 | Complete (all code, tests, gates verified) | [x] ✓ normalized |
| 2 — self.attr (PR #30) | 15 | Complete (all code, tests, gates verified) | [x] ✓ normalized |
| 3 — Chained/returned (PR #45) | 20 | Complete (all code, tests, gates verified) | [x] ✓ (already marked by PR #45) |
| **Total** | **56** | **Complete** | **All marked [x]** | No unchecked tasks remain |

## PR Chain

All three PRs confirmed MERGED via `gh pr view --json` and commit history:

| PR | Title | Base | Head | Additions | Deletions | Merged |
|----|-------|------|------|-----------|-----------|--------|
| #29 | feat(analyzer): resolve instance method calls through type annotations | feat/extended-instance-resolution | feat/extended-instance-resolution-annotations | 87 | 11 | 2026-09-12T06:29:16Z |
| #30 | feat(analyzer): resolve self.attr instance calls across methods of the same class | feat/extended-instance-resolution | feat/extended-instance-resolution-self-attr | 74 | 6 | 2026-09-12T06:29:31Z |
| #45 | feat(analyzer): resolve chained and returned instance calls | feat/agent-change-map-mvp | feat/extended-instance-resolution-chained-calls | 173 | 21 | 2026-09-12T06:55:55Z |

Line counts independently verified: 87/11 (PR #29), 74/6 (PR #30), 173/21 (PR #45) — exact match to `gh` reports.

## Spec Compliance Proof

18 scenarios, all PASS:

| # | Scenario | Slice | Test | Result |
|----|----------|-------|------|--------|
| 1 | Resolve a direct call | pre-existing | `resolves direct calls only through Python lexical scopes` | PASS |
| 2 | Analyze a dynamic call | pre-existing | existing ambiguous/unresolved coverage | PASS |
| 3 | Resolve a call through a locally constructed instance | pre-existing | `resolves a call through a locally constructed instance variable` | PASS |
| 4 | Instance variable reassigned to different classes across branches | pre-existing | `reports ambiguous candidates when an instance variable is reassigned across branches` | PASS |
| 5 | Instance call to an unresolvable constructor class | pre-existing | `leaves instance calls unresolved when the constructor class is unknown` | PASS |
| 6 | Instance call with no matching method on the resolved class | pre-existing | `leaves instance calls unresolved when the bound class has no matching method` | PASS |
| 7 | Call through a variable bound from a non-constructor expression remains unresolved | pre-existing | `leaves unsupported instance-binding shapes unresolved` | PASS |
| 8 | Resolve a call through an annotated variable | Slice 1 | tests 1–2 | PASS |
| 9 | Resolve a call through an annotated function parameter | Slice 1 | test 3 | PASS |
| 10 | Annotation naming an unresolvable or quoted/generic class remains unresolved | Slice 1 | test 4 | PASS |
| 11 | Resolve a call through a class-scoped self-attribute binding | Slice 2 | tests 6–7 | PASS |
| 12 | Self-attribute bound to different classes resolves as ambiguous | Slice 2 | test 8 | PASS |
| 13 | Non-self-named receiver parameter is not treated as a self-attribute binding | Slice 2 | test 10 | PASS |
| 14 | Resolve a chained call through an explicit return-type annotation | Slice 3 | test 13 | PASS |
| 15 | Resolve a chained call through an inferred return-body class | Slice 3 | test 14 | PASS |
| 16 | Resolve a chained call through a returned local variable | Slice 3 (N10 amendment) | test 15b | PASS |
| 17 | Chained call with multiple return types resolves as ambiguous | Slice 3 | test 16 | PASS |
| 18 | Chained call with no discernible return type resolves as unresolved without crashing or looping | Slice 3 | tests 18–19 | PASS |

## Final-State Authority Ranking

Per SKILL.md Final-State Authority:

1. **Native review authority**: Not applicable (no explicit review gate for this change)
2. **Persisted tasks artifact**: All tasks marked complete in `tasks.md`
3. **Explicit final-state facts**: Orchestrator provided verify-report PASS verdict and two cleanup instructions; both carried out and archived
4. **verify-report and apply-progress**: Intermediate snapshots, ranked lowest; used for evidence only

**Final state**: ARCHIVED AND CLOSED. All work complete, all specs merged, all artifacts moved, all checkboxes normalized, all recommendations addressed.

## Dependencies and Rollback

**Dependencies met**:
- Prior change `instance-method-call-resolution` (merged) — supplies `variable_classes`, `_lexical_candidates`, `_resolution()`

**Rollback plan** (unchanged from proposal):
- Each slice is a separate PR touching only `python/analyzer.py` plus its tests
- Revert a single slice; earlier slices stand alone
- Full rollback restores prior-change behavior (all three new shapes unresolved)

## Known Open Gaps

1. **super() calls remain unresolved** — documented in TODO.md with corrected rationale (builtin unresolvable via _lexical_candidates, distinct from chained-call inference path)
2. **Filter refresh issue** — unrelated, documented separately in TODO.md

## Archival Completion Checklist

- [x] All Section 0–3 task checkboxes marked complete (normalized per verify recommendations)
- [x] TODO.md rationale updated (super() entry clarified, verdict unchanged)
- [x] Delta spec merged into main spec (18-scenario "Represent call uncertainty" requirement)
- [x] Change folder moved to archive with date prefix (2026-09-12-extended-instance-resolution)
- [x] Archive contains merged spec snapshot (byte-identical to openspec/specs/)
- [x] All artifacts (proposal, design, tasks, verify-report, exploration, specs/) copied to archive
- [x] Original change folder removed from filesystem and git-tracked deletion staged
- [x] Archive report written

## File Integrity

**Merged spec snapshot verification**:  
Archive spec: `openspec/changes/archive/2026-09-12-extended-instance-resolution/specs/python-structure-analysis/spec.md`  
Main spec: `openspec/specs/python-structure-analysis/spec.md`  
Status: Byte-identical (merged content, not raw delta)

## SDD Cycle Complete

This change has completed all SDD phases:
- ✓ Proposal: scope, approach, risks defined
- ✓ Spec: requirements and scenarios detailed
- ✓ Design: per-slice code blocks and architecture finalized
- ✓ Tasks: 56 discrete implementation units sequenced across 3 slices
- ✓ Apply: all 3 PRs merged, 481/481 tests passing
- ✓ Verify: PASS, spec-compliant, 0 CRITICAL issues
- ✓ Archive: artifacts frozen, specs merged, change closed

**Next change**: Ready to proceed.
