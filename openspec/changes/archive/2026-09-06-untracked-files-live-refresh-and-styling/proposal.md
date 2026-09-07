# Proposal: Untracked Files, Live Refresh, and Graph Styling

## Intent

Three gaps found in hands-on testing keep the extension from matching how people actually
work. First, a brand-new file the user has not `git add`ed yet is invisible end-to-end: the
worktree capture sources its file list only from `git ls-files -s`, so exactly the files an
agent just created — the most interesting ones in a change map — do not appear until the user
stages them. Second, the whole comparison runs once, inside the `agentChangeMap.compare`
command closure, so the only way to see new work is to close the panel and reopen it. Third,
the just-shipped graph restyle left three visible defects: elbow edges read as harsh
right angles, `function` and `method` render identically (violating the prior change's own
"mutually distinct" criterion), and SVG `<text>` sets no `font-family`, so graph labels do not
inherit the webview font.

Success looks like: a user writes a new file, presses Refresh (or opts into auto-refresh),
and sees it in a graph whose kinds are all visually distinguishable and whose edges curve.

## Scope

### In Scope

**1 — Untracked-file capture (`src/git/gitService.ts`)**
- Merge `git ls-files --others --exclude-standard` output into the same path list worktree
  capture already builds from tracked paths.
- Filter both tracked and untracked candidates through a **new, named, reusable file-matcher
  abstraction** (concept: `SourceFileMatcher` / `LanguageFileFilter`; exact name is a design
  call) that today matches only `.py`. **No inline `.endsWith(".py")` check anywhere in the
  filter path** — this replaces `buildGraphForSelection`'s current late, separate `.py` filter
  for tracked files too, so tracked and untracked capture share one filtering point and one
  timing. The abstraction must be shaped so a later change can add languages (e.g. SQL) without
  reworking the capture pipeline.
- Track file provenance (tracked vs. untracked) alongside each captured file so it can flow
  through to node rendering (see visual polish, below).
- Switch `statusFingerprint` from `--untracked-files=no` to `--untracked-files=all`, so an
  untracked file created, removed, or edited mid-capture trips the same
  `GitCaptureInstabilityError` a tracked file already trips.
- Existing size/binary guards apply unchanged: an oversized or binary untracked file hard-fails
  via `GitCaptureLimitError` / `GitBinaryContentError`. No silent skip-with-diagnostic path.

**2 — Refresh without closing the panel**
- New `requestRefresh` webview→host message that re-runs capture → diff → correlate for the
  panel's original selection and reloads the graph. Requires moving `references` / `repoRoot`
  off the one-shot command closure in `src/extension.ts` onto state `ChangeMapSession` can
  reach later.
- A manual refresh action, always available, as the default path.
- An **off-by-default, explicitly opted-into** automatic refresh driven by a debounced
  filesystem watcher, gated behind a user toggle/setting.
- Bound / evict `SnapshotStore`, today an unbounded `Map`; both refresh modes feed it.

**3 — Graph visual polish (`webview/graphView.ts`, `webview/styles.css`)**
- Bezier/curved edge routing replacing the sharp right-angle elbow paths.
- Fix the `function` vs. `method` stroke encoding so the two kinds are distinct.
- Add an explicit `font-family` to SVG `<text>` (a real pre-existing bug, not polish).
- CSS custom properties replacing hardcoded hex colors — include if design judges it low-risk.
- A visual distinction between a node from a tracked file and one from an untracked file,
  additive to the existing change-status color channel (see Request 1b).

### Out of Scope
- Multi-language matching beyond `.py`. Explicitly deferred, but the Decision-1 abstraction
  must not preclude it.
- Drop-shadow / glow SVG filters, and hover / selected visual affordances. Follow-on candidates.
- Symlink handling (mode `120000`) beyond what untracked capture inherits from existing guards.
- `captureCommitState` — a fixed git object has no untracked content by definition.
- Any change to the Python analyzer, the diff-panel / source-comparison feature, or Docker
  execution.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `git-state-comparison`: both tracked and untracked capture route through one language file
  matcher; worktree capture includes untracked, non-ignored source files; mid-capture stability
  now accounts for untracked files; captured files carry a tracked/untracked provenance flag.
- `change-map-visualization`: a panel can be refreshed in place without being reopened;
  edge routing, entity-kind encoding, and label typography are corrected; nodes visually
  distinguish tracked vs. untracked provenance alongside change status.

## Approach

### Request 1 — the matcher is the single filtering point (decided)

The user's constraint is that language selection becomes an explicit, named collaborator, not
a scattered predicate. **Decided: unified.** The *tracked* capture path today has **no
extension filter at the git layer at all** — filtering to `.py` happens much later, in
`buildGraphForSelection`, right before the analyzer runs. The matcher becomes the **single**
place both tracked and untracked capture route through for extension filtering: tracked
capture in `src/git/gitService.ts` is changed to filter through the same matcher untracked
capture uses, rather than leaving `.py` filtering to happen later and separately in
`buildGraphForSelection`. This changes what tracked capture returns (and therefore what
`buildGraphForSelection` receives) — `sdd-design` must trace this through and `sdd-tasks` must
budget for the wider test impact (existing tracked-capture tests that assume non-`.py` files
pass through capture and get silently dropped later need review).

### Request 1b — distinguish tracked vs. untracked nodes visually (new)

Both tracked and untracked `.py` files now feed the same graph, so a user needs to tell them
apart at a glance. **In scope, added by user decision:** give a node originating from an
untracked file a visually distinct treatment from one originating from a tracked file, additive
to (not replacing) the existing change-status coloring (`added`/`removed`/`modified`/
`unchanged`). This needs a "provenance" flag (tracked vs. untracked) to flow from capture
(`CapturedFile`) through the protocol and diff correlation to the rendered `Entity`/node — a
new field, not something derivable from `added`/`removed`/`modified` alone (an untracked file's
entities are always `added` relative to a tracked-only baseline, but the reverse is not
true — a tracked file can also contain freshly `added` entities). Exact visual mechanism
(a distinct stroke/fill color, a small badge, a secondary indicator) is a design-phase call,
constrained to not collide with or muddy the existing change-status color channel.

### Request 2 — refresh must not act behind the user's back

The project's posture is that nothing disruptive happens without explicit action (drafts stay
isolated until a deliberate write; execution is opt-in). Auto-refresh, when enabled, must
respect that:

- Deferred or skipped while a write/run confirmation dialog is pending or a Docker run is
  active — never silently invalidating a decision the user is mid-way through making.
- Diff-panel collapse state and unsaved draft-editor text must survive a refresh, the same way
  they must survive the existing `retainContextWhenHidden` case.

The exact guarding mechanism (queue-and-apply-after, suppress-and-notify, or refresh-pending
indicator) is a design-phase call; the *behavioral guarantee* above is not.

### Request 3 — polish inside the locked contract

All visual work stays inside the contract the archived `diff-view-and-graph-styling` change
locked in: stable `data-*` attributes, outline-only boxes, dashed containers / solid entities,
arrowhead-at-destination, strict CSP, no external fonts or resources. Bezier routing is a `d`
attribute change compatible with the existing `marker-end` setup.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/git/gitService.ts` | Modified | Untracked path merge; `--untracked-files=all` fingerprint |
| `src/` (new module) | New | Language file matcher abstraction |
| `src/extension.ts` | Modified | `references`/`repoRoot` move off the command closure |
| `src/webviewHost.ts`, `src/webviewProtocol.ts` | Modified | `requestRefresh` message and recapture |
| `SnapshotStore` | Modified | Bounding / eviction |
| `webview/graphView.ts`, `webview/styles.css` | Modified | Bezier edges, kind encoding, `font-family` |
| Analyzer / Docker / diff panel | None | Explicitly untouched |

## Test Impact (Strict TDD)

Expected and intentional churn — `sdd-tasks` must budget for it, not treat it as regression:

- `test/integration/gitState.test.ts` worktree-capture instability tests **must be explicitly
  reviewed** once `statusFingerprint` includes untracked files. Verify that no existing test
  depends on untracked noise being excluded. This is a required task, not an assumption.
- New: capturing a wholly untracked `.py` file; an untracked non-`.py` file being excluded by
  the matcher; untracked file appearing/disappearing mid-capture; oversized/binary untracked
  file hard-failing; commit-state capture unaffected.
- New: `requestRefresh` protocol/host cases, session recapture, `SnapshotStore` eviction,
  auto-refresh deferral while a confirmation is pending, and an e2e refresh scenario.
- New: `graphView` cases for Bezier path shape, function-vs-method stroke distinction, and
  `font-family` presence on `<text>`.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `--untracked-files=all` makes capture spuriously unstable in noisy worktrees | Medium | Review existing instability tests first; scope the fingerprint carefully |
| Matcher abstraction over-engineered for one extension | Medium | Keep it a small named unit; resist a plugin registry |
| Auto-refresh lands under a pending confirmation or unsaved draft | Medium | Off by default; explicit deferral guard; state-preservation tests |
| `SnapshotStore` growth under repeated refresh | Medium | Bounded store with eviction, covered by test |
| Bezier edges cross node boxes and hurt readability | Low | Obstacle-aware routing stays out of scope; visual review at design |
| Unifying the matcher changes tracked capture's returned file set, with wider test blast radius than the narrow option | Medium | `sdd-tasks` explicitly reviews existing tracked-capture and `buildGraphForSelection` tests for the new filtering point/timing |
| Tracked/untracked node coloring collides visually with existing change-status coloring | Medium | Design picks an additive channel (not a competing color hue) and states it explicitly |

## Rollback Plan

Three independently revertible slices. Reverting the graph slice restores elbow paths with no
data-model impact. Reverting refresh restores the one-shot command closure; only the
`requestRefresh` message shape changes and host+webview ship together, so no version skew.
Reverting untracked capture restores `listTrackedPaths`-only sourcing and the
`--untracked-files=no` fingerprint. No stored state, no migration.

## Dependencies

- No new runtime dependencies, no bundler, no relaxation of the existing CSP.

## Success Criteria

- [ ] A never-staged `.py` file appears in a worktree comparison.
- [ ] An untracked non-`.py` file is excluded by the named matcher, with no inline extension
      check in the capture path, and the matcher is extensible without pipeline rework.
- [ ] An untracked file changing mid-capture raises `GitCaptureInstabilityError`.
- [ ] An oversized or binary untracked file hard-fails exactly like a tracked one.
- [ ] The panel refreshes in place via an explicit user action, without reopening.
- [ ] Auto-refresh is off by default, requires opt-in, and never discards a pending
      confirmation or unsaved draft when enabled.
- [ ] `SnapshotStore` does not grow without bound across repeated refreshes.
- [ ] Edges render as curves; `function` and `method` are visually distinct; SVG `<text>`
      declares a `font-family`.
- [ ] A node from an untracked file is visually distinguishable from a tracked one, without
      obscuring its change-status color.
- [ ] `webview/index.ts` click-to-navigate works unchanged against the same `data-*` contract.
