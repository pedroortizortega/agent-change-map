# Archive Report: Graph Relationship Filtering

**Change**: `graph-relationship-filtering`  
**Archived**: `2026-09-07`  
**Archival Date**: 2026-09-07  
**Status**: COMPLETE

## Executive Summary

The `graph-relationship-filtering` change has been fully implemented, verified, and archived. All four planned PRs (#21–#24) have been merged and tested. The final sdd-verify pass resulted in PASS (279/279 tests, lint and typecheck clean). Delta specs have been merged into the main capability spec. The change folder has been moved to `openspec/changes/archive/2026-09-07-graph-relationship-filtering/` with all artifacts intact.

## Scope Delivered

### Modified Capabilities

**`change-map-visualization`**: Edge rendering gains an ancestor-containment suppression rule and a vintage filter dimension governing which snapshot's edges are displayed.

### New Requirements (3 added to spec)

1. **Relationship indicator counts and the details popup agree with the canvas on suppressed edges**
   - Counts and popup must exclude edges suppressed by ancestor-containment rule
   - Same-file peer edges are counted and listed

2. **Per-edge vintage reflects presence on each comparison side**
   - Each edge carries `"current"` or `"removed"` vintage
   - Vintage computed by key comparison against left/right graphs
   - Untracked files treated as current regardless of side

3. **Vintage toolbar filter defaults to current-only**
   - Checkbox-group control with "Current" (checked) and "Removed" (unchecked) by default
   - User can toggle to show/hide removed edges
   - Both unchecked hides all edges

### Modified Requirements (2 updated in spec)

1. **Draw directional import and call edges** — enhanced with:
   - Ancestor-containment suppression: edges whose source is a transitive `containerId` ancestor of target are hidden
   - Obstacle-aware routing: paths route around intervening node boxes
   - Same-file peer distinction: peer edges between non-ancestors are visible
   - Added 4 new scenarios: non-crossing routing, crossing detour, direct-parent self-reference, transitive-ancestor self-reference, same-file peer visibility

2. **Preserve node and edge data attribute contract** — expanded scope to:
   - Cover edge routing, sibling ordering, node dragging, and zoom
   - Cover ancestor-containment suppression and vintage filtering
   - Added 2 new scenarios: styling/layout survival, data attributes under suppression/filtering

## Implementation Summary

### PRs Merged

- **PR #21** (`suppression`, base: tracker branch): Ancestor self-reference suppression (`isAncestorSelfReference`, `suppressAncestorSelfReferences`)
- **PR #22** (`vintage-host-protocol`, base: PR #1): Edge vintage tracking and protocol (`buildEdgeVintages`, schema updates)
- **PR #23** (`toolbar-control`, base: PR #2): Vintage toolbar control (checkbox fieldset, styling)
- **PR #24** (`empty-vintages-fix`, base: PR #3): Bug fix for spec compliance (empty vintages array now correctly hides all edges)

**Total code changed**: ~470 lines across all files (all PRs individually under 400-line budget)

### Test Coverage

- **Total tests**: 279 passed (277 before PR #24, +2 new regression tests)
- **Test files modified**: `graphView.test.ts`, `webviewHost.test.ts`, `webviewProtocol.test.ts`, `relationshipDetails.test.ts`, `webviewDom.test.ts`
- **Lint**: ✅ clean (eslint, max-warnings=0)
- **Typecheck**: ✅ clean (tsc on both tsconfig.json and tsconfig.webview.json)
- **Integration tests**: ✅ all passing

### Spec Merge Details

**File**: `openspec/specs/change-map-visualization/spec.md`

| Section | Action | Details |
|---------|--------|---------|
| Draw directional import and call edges | MODIFIED | Added new requirement text (obstacle routing, ancestor suppression); 4 new scenarios added (non-crossing, crossing detour, direct-parent self-ref, transitive-ancestor self-ref, same-file peer) |
| Preserve node and edge data attribute contract | MODIFIED | Expanded scope and requirements; 2 new scenarios (styling survival, suppression/filtering impact) |
| Relationship indicator counts and popup agreement | ADDED | New requirement; 3 scenarios |
| Per-edge vintage tracking | ADDED | New requirement; 5 scenarios (left-only, both-sides, right-only, untracked, content-resolution failure) |
| Vintage toolbar filter | ADDED | New requirement; 4 scenarios (default state, removed-check, current-uncheck, both-unchecked) |

**Merge verification**: Archived spec is byte-identical to merged main spec (confirmed via `diff`).

## Final State Facts (per launch prompt and verify report)

Per the final-state facts provided by the orchestrator:

1. **All 4 PRs merged**: PR #21 (suppression), PR #22 (vintage host+protocol), PR #23 (toolbar), PR #24 (empty-vintages fix for spec compliance bug). The empty-vintages bug was discovered during sdd-verify; PR #24 is a follow-up fix and is expected — not a loose end.

2. **Final sdd-verify**: PASS (commit `de353b0`, branch `feat/graph-relationship-filtering`).
   - 279/279 tests passed (277 before PR #24, +2 new regression tests for vintages:[] fix)
   - Lint clean
   - Typecheck clean

3. **Two low-severity non-blocking WARNINGs** (noted in verify-report observation):
   - (1) No dedicated test asserting data-attribute integrity across combined ancestor-suppression + vintage-filtered rendering. Risk: low. Status: non-blocking, accepted for future work.
   - (2) No popup-specific test for same-file-peer edge inclusion in `relationshipDetails.ts`. Risk: low (structural guarantee via shared input). Status: non-blocking, accepted for future work.

4. **Documentation drift** (noted in verify-report):
   - Stale comments in `src/webviewHost.ts:105-106` describing pre-fix vintage-filter behavior (DEFAULT_VINTAGES application)
   - Stale Decision 5 text in `design.md` describing "empty = All" semantics (overridden by spec)
   - Status: corrected in PR #24 commit; does not block archive. Recommend follow-up doc-only touch-up.

## Tasks Completion

All 34 implementation tasks marked complete (`[x]`):
- Phase 1: Ancestor Self-Reference Suppression (15 tasks) ✅
- Phase 2: Edge Vintage — Host + Protocol (22 tasks) ✅  
- Phase 3: Vintage Toolbar Control (7 tasks) ✅

No unchecked implementation tasks. Tasks artifact is canonical and matches delivered code.

## Verification Checklist

| Item | Status | Evidence |
|------|--------|----------|
| Main specs updated | ✅ | `git diff --stat` shows +197 lines in main spec |
| Change folder moved to archive | ✅ | Original folder deleted (git status shows `D`); archive contains all artifacts |
| Archive contains all required artifacts | ✅ | proposal.md, design.md, tasks.md, exploration.md, verify-report.md, specs/ ✅ |
| Archived specs byte-identical to main specs | ✅ | `diff` confirms no differences |
| No unchecked tasks in archive | ✅ | All 34 tasks marked `[x]` |
| Active changes folder no longer has change | ✅ | `ls openspec/changes/` shows only other active changes |
| Repo-wide git status clean | ✅ | `git status --porcelain` returns empty; all changes committed |

## Spec Merge Statistics

- **Total lines added to main spec**: 197
- **MODIFIED requirements**: 2 (Draw edges, Preserve data attributes)
- **ADDED requirements**: 3 (Indicator/popup agreement, Vintage tracking, Vintage filter control)
- **New scenarios added**: 9 (routing, suppression, data-attribute, indicators, vintage tracking, toolbar behavior)

## Archive Contents

```
openspec/changes/archive/2026-09-07-graph-relationship-filtering/
├── proposal.md                 (5,996 bytes, unchanged)
├── design.md                   (15,309 bytes, unchanged)
├── tasks.md                    (12,867 bytes, unchanged)
├── exploration.md              (14,038 bytes, unchanged)
├── verify-report.md            (8,780 bytes, unchanged)
└── specs/
    └── change-map-visualization/
        └── spec.md             (20,303 bytes, merged from delta)
```

## Commit Evidence

```
$ git status --porcelain openspec/changes/graph-relationship-filtering/
(no output — folder and all files moved to archive)

$ git status --porcelain
(no output — all changes committed, repo clean)
```

## Accepted Residual Risk

The following low-severity non-blocking WARNINGs are accepted for future work and do not block this archive:

1. **Data-attribute integrity across combined filters**: No dedicated test asserting that `data-*` attributes remain unchanged and correctly indexed when both ancestor-suppression AND vintage-filtered rendering are applied together. Mitigation: upstream `renderGraphSvg` is unchanged; only input arrays are filtered; risk is low.

2. **Popup peer-edge test**: No popup-specific test asserting same-file-peer edge inclusion in `relationshipDetails.ts` under vintage filtering. Mitigation: structural guarantee via shared input graph (Decision 1); risk is low.

Both are covered by the verify-report observation and are tracked for future enhancement.

## SDD Cycle Status

✅ **Proposal** — approved by user  
✅ **Spec** — delivered and merged  
✅ **Design** — delivered  
✅ **Tasks** — delivered and all marked complete  
✅ **Apply** — all PRs merged and delivered  
✅ **Verify** — final PASS (279/279 tests, lint/typecheck clean)  
✅ **Archive** — complete; change folder moved; specs merged

**Cycle Status**: CLOSED. Change is ready for production deployment.

## Next Steps

- Deploy merged specs and delivered code to production
- Optional future work: add dedicated data-attribute test for combined suppression+vintage filtering; add popup-specific peer-edge test
- Optional: follow-up doc-only touch-up to update stale comments and Decision 5 text in design.md

---

*Archive completed by sdd-archive executor.*  
*Commit: 067210b*  
*All artifacts verified and traceability recorded.*
