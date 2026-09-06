# Design: Diff View and Graph Styling

## Technical Approach

Two independent presentation slices over unchanged data models. Slice A moves line
classification host-side: a vendored line-diff module in `src/diff/lineDiff.ts` produces one
aligned op sequence that `ChangeMapSession` puts on the `sourcePair` message, and
`webview/index.ts` renders it as a two-column git-style table. Slice B rewrites
`renderGraphSvg` as a recursive containment layout with kind-encoded outline-only boxes and
drawn elbow edges. Neither slice touches the analyzer, git capture, draft/write guard, or
Docker paths. The `data-*` click contract is frozen so `webview/index.ts`'s graph wiring
needs zero edits.

Build constraint that shapes both slices: `tsconfig.webview.json` compiles `webview/**/*.ts`
only, and `tsconfig.build.json` compiles `src/**` plus `webview/graphView.ts`. The new diff
module is host-only at runtime; the webview imports its **types only** (erased), so no
cross-root runtime import is introduced and no bundler is needed.

## Architecture Decisions

| # | Decision | Alternatives / tradeoff | Choice and rationale |
|---|---|---|---|
| 1 | Diff algorithm | Port `vscode-diff`'s `DefaultLinesDiffComputer`: MIT, battle-tested, but drags `Range`/`LineRange`/`RangeMapping`/`DetailedLineRangeMapping`/`ArrayText`/`myersDiffAlgorithm`/`dynamicProgrammingDiffing` plus join-and-heuristics passes across many files — hundreds of lines of machinery whose value is the intra-line detail we explicitly scoped **out**. Hand-rolled clean-room Myers: zero attribution burden but unproven. | Port jsdiff's `Diff` base + `diffLines` into a single self-contained `src/diff/lineDiff.ts`. It is one ~200-line O(ND) Myers loop with `tokenize`/`equals` hooks; dropping the word/char/json diff subclasses and the patch layer leaves exactly the line path we need, with no imports. **License note:** jsdiff (`diff` on npm) is **BSD-3-Clause**, not MIT — the file header must reproduce the BSD-3-Clause notice verbatim, not an MIT one. |
| 2 | Where the diff runs | Webview-side keeps the wire small | Host-side in `inspectSources`. The host already holds both full contents; the webview stays a pure renderer and the algorithm is unit-testable with no DOM. |
| 3 | `affectedLines` on the wire | Keep as a derivable compatibility field | **Dropped.** Its only consumer is the `Affected lines: n, m` string being deleted, and keeping it creates a second source of truth for "what changed". Host and webview ship together (see proposal rollback), so no version skew is possible. |
| 4 | Op sequence shape | Two per-side op arrays | One shared `DiffOp[]`. The two columns are two projections of a single alignment; two arrays would have to be re-zipped in the webview and could drift. |
| 5 | Containment as geometry | Drawn `contains` edges | Nesting only (proposal Decision A). `contains` edges still consume their `graph.edges` array index but emit no element. |
| 6 | Kind encoding channel | CSS classes only | Inline SVG presentation attributes for `stroke-width`/`stroke-dasharray`/`fill="none"`, CSS class for stroke **color**. Unit tests assert against the SVG string and jsdom does not load `styles.css`; geometry-carrying values must be in the string, theme-varying colors must not. |
| 7 | Flat-degradation location | `webview/index.ts` | Top of `renderGraphSvg`. Keeping it in `graphView.ts` is what lets `index.ts` stay byte-unchanged, and the host must not make a rendering decision. |

## Data Flow

```text
inspectSources ──> ChangeMapSession ──> resolveSource(left) + resolveSource(right)
                                          │
                                          └─> diffLines(left, right, startLines) ──> DiffOp[]
                                                 │
   sourcePair{ sources[], ops[] } ──> webview ──> renderDiffPanel(ops, expandedRuns)

graph ──> isOversized (300/600, host gate: render at all?)
            └─> post graph ──> renderGraphSvg
                                 ├─ nodes > 60 ──> renderFlatSvg   (new visual language, old stack geometry)
                                 └─ else       ──> measure() bottom-up ──> place() top-down ──> edges
```

## Interfaces / Contracts

```ts
// src/diff/lineDiff.ts  (new; BSD-3-Clause header from jsdiff retained verbatim)
export type DiffOp =
  | { op: "unchanged"; leftLine: number; rightLine: number; text: string }
  | { op: "added";     rightLine: number; text: string }
  | { op: "removed";   leftLine: number;  text: string };

export function diffLines(
  left: string,
  right: string,
  offsets: { leftStartLine: number; rightStartLine: number },
): DiffOp[];
```

`left`/`right` are `""` when that side has no counterpart, yielding an all-`added` or
all-`removed` sequence. Trailing-newline handling reuses the existing `contentLines`
semantics (a single trailing empty line is dropped), which moves into `lineDiff.ts`.

```ts
// src/webviewProtocol.ts — sourcePair
| { type: "sourcePair";
    sources: { side: "left" | "right"; sourceId: SourceId; content: string;
               startLine: number; endLine: number }[];   // affectedLines REMOVED
    ops: DiffOp[] }
```

`src/webviewHost.ts`: delete `affectedLinesForSources` entirely; in `inspectSources` build
`sources` as today minus `affectedLines`, then
`const ops = diffLines(left?.content ?? "", right?.content ?? "", { leftStartLine: left?.startLine ?? 1, rightStartLine: right?.startLine ?? 1 })`
and post `{ type: "sourcePair", sources, ops }`.

## Diff Panel DOM and Collapse State

Four-column CSS grid, one `.diff-row` per op, always both sides present:

```html
<div id="diff-panel"><div class="diff" role="table">
  <div class="diff-row op-removed">
    <span class="ln">12</span><code class="side left">old text</code>
    <span class="ln"></span><code class="side right ghost" aria-hidden="true"></code>
  </div>
  <button class="diff-collapsed" data-run-key="L14-41/R14-38">⋯ 28 unchanged lines ⋯</button>
</div></div>
```

- `op-added` fills the right pair and ghosts the left; `op-removed` the mirror;
  `op-unchanged` fills both and carries `.muted`.
- **Ghost column**: a side with no counterpart still emits its `<span class="ln">` and
  `<code class="side ghost">` with empty `textContent`, so the grid never collapses to one
  column and the left/right reading rhythm survives a wholly added/removed entity.
- **Collapse state**: module-level `const expandedRuns = new Set<string>()` and
  `let lastOps: DiffOp[] = []` in `webview/index.ts`. Run key is
  `` `L${leftStart}-${leftEnd}/R${rightStart}-${rightEnd}` `` derived from the run's first
  and last op (an absent side contributes `L-`/`R-`), so it is a stable line range and stays
  unambiguous when one side is missing. The `sourcePair` case calls `expandedRuns.clear()`
  **before** rendering — this is the per-message reset the proposal requires.
- Collapse rule: `COLLAPSE_MIN_RUN = 6` consecutive `unchanged` ops collapse, keeping
  `CONTEXT = 3` visible rows at each boundary. Clicking the affordance toggles the key in
  `expandedRuns` and re-renders from `lastOps`. All rows are built with
  `createElement`/`textContent` — no `innerHTML`, CSP posture unchanged.

## Graph Layout Algorithm

```text
childrenOf: Map<string|undefined, Entity[]>   // containerId normalized to undefined when
                                              // that id is absent from graph.nodes (orphan)
measure(n):  leaf      -> { w: NODE_MIN_W, h: NODE_H }
             container -> w = 2*PAD_X + max(NODE_MIN_W, max(child.w))
                          h = HEADER_H + 2*PAD_Y + Σ child.h + GAP_Y*(k-1)
place(n, x, y): emit <g transform="translate(x,y)"><rect .../></g>; children at local
                (PAD_X, HEADER_H + PAD_Y + Σ previous heights); record ABSOLUTE
                {x,y,w,h} in boxes: Map<nodeId, Rect> for edge anchoring.
roots: childrenOf.get(undefined) stacked vertically at x=MARGIN with ROOT_GAP.
```

Cycle guard: a `visited` set on the containerId walk, mirroring `sectionScope`'s existing
guard; a node reached twice is demoted to a loose root. Orphans (container filtered out) are
laid out as roots alongside real roots, with **no** placeholder box.

Constants: `NODE_H=32, HEADER_H=20, PAD_X=12, PAD_Y=10, GAP_Y=8, NODE_MIN_W=200,
ROOT_GAP=24, MARGIN=16`.

### Kind encoding (inline attributes on each `<rect class="node-box status-…">`)

| `kind` | `stroke-width` | `stroke-dasharray` | `rx` | Reading |
|---|---|---|---|---|
| `package` | `1` | `2 4` | `4` | container, thinnest, dashed |
| `module` | `1.5` | `4 3` | `4` | container, dashed |
| `class` | `3.5` | *(absent)* | `2` | entity, solid, squarest |
| `function` | `2.5` | *(absent)* | `10` | entity, solid, pill |
| `method` | `2.5` | *(absent)* | `10` | entity, solid, pill |

Containers are strictly thinner than every entity; `class` is distinguished from
`function`/`method` on **two** channels (width and corner radius), so the distinction
survives a theme that flattens one. Every rect carries `fill="none"`.

`webview/styles.css`: the four `.node-box.status-*` rules change `fill:` to `stroke:`, plus
`.node-box { fill: none }` and `.node-box.status-unchanged { stroke: #6e7681 }` (gray).

## Edge Rendering

One `<defs>` block emitted once per SVG:

```html
<defs>
  <marker id="acm-arrow-import" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" class="arrow-import"></path></marker>
  <marker id="acm-arrow-call" …><path d="M0,0 L10,5 L0,10 z" class="arrow-call"></path></marker>
</defs>
```

Anchors: source = bottom-center of the **source/importer/caller** box
`(sx + sw/2, sy + sh)`; target = top-center of the **target** box `(tx + tw/2, ty)`. Elbow:

```
my = tay > say ? (say + tay) / 2 : say + ELBOW_DROP        // ELBOW_DROP = 16
d  = `M${sax},${say} L${sax},${my} L${tax},${my} L${tax},${tay}`
```

`marker-end="url(#acm-arrow-import|call)"` — the arrowhead sits at the destination, giving
the direction convention of proposal Decision A. Colors: `.edge-import`/`.arrow-import`
`#4f9cf9`, `.edge-call`/`.arrow-call` `#c586c0` (mutually distinct), ambiguity `#f0883e`
(carried over from today's `.edge-label.resolution-*`).

Ambiguous, unresolved, and resolved-but-target-not-in-view edges have no destination anchor,
so they render as a downward stub from the source anchor,
`d="M${sax},${say} L${sax},${say + STUB_LEN}"` (`STUB_LEN = 28`), `stroke-dasharray="4 3"`,
**no** `marker-end`, class `resolution-ambiguous`/`resolution-unresolved`. The existing
`<title>` from `resolutionLabel` and `data-resolution` are retained verbatim, so the
ambiguity signal and its candidate list are not weakened. Ambiguous candidates do not fan
out (out of scope).

`contains` edges emit no element at all, but the loop still iterates `graph.edges` **by
array index**, so remaining edges keep their true `graph.edges[index]` value.

## Flat-Layout Degradation Threshold

```ts
export const NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 } as const;  // webview/graphView.ts
```

Checked at the top of `renderGraphSvg`; over the limit it returns `renderFlatSvg(...)`, which
keeps today's `y = 24 + index * 48` stack geometry but shares `renderNodeRect` and
`renderEdge` with the nested path, so outline-only styling, kind dash/stroke-width, drawn
elbow edges, and markers are all preserved. `60` is ~1/5 of `OVERSIZED_THRESHOLDS.nodes`
(300): at `NODE_MIN_W=200` plus per-level padding, a single-column nested tree of ~60 boxes
already exceeds ~2000px tall, past which geometric nesting stops helping.

The two gates are sequential and independent: `isOversized` (`OVERSIZED_THRESHOLDS`
300/600, host-side, in `loadComparison`/`sendGraph`) decides **whether to render at all**
and is answered by `confirmOversized`; `NESTED_LAYOUT_LIMITS` decides **nested vs. flat**
only after a graph message has been posted. Neither reads nor changes the other.

## data-* Contract Preservation (frozen)

| Attribute | Element | Value | Set at |
|---|---|---|---|
| `data-node-id` | `<g class="node">` | `escapeXml(node.id)` — unchanged | `place()`, per node `<g>` |
| `data-node-kind` | `<g class="node">` | `node.kind` — unchanged | `place()` |
| `data-change-status` | `<g class="node">` | `changeStatusFor(...)` — unchanged | `place()` |
| `data-edge-index` | `<g class="edge">` | index into `graph.edges` — unchanged | edge loop |
| `data-edge-kind` | `<g class="edge">` | `edge.kind` — unchanged | edge loop |
| `data-resolution` | `<g class="edge">` | `edge.resolution.kind` — unchanged | edge loop |

`webview/index.ts`'s `querySelectorAll("[data-node-id]")` / `("[data-edge-index]")` wiring and
its `graph.edges[index]` / `message.edgeSources[index]` lookups therefore require **zero**
changes. Any need to edit that wiring means the contract was broken.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/diff/lineDiff.ts` | Create | Vendored jsdiff line Myers, BSD-3-Clause header, `DiffOp` + `diffLines` |
| `src/webviewHost.ts` | Modify | Delete `affectedLinesForSources`/`contentLines`; call `diffLines` in `inspectSources` |
| `src/webviewProtocol.ts` | Modify | `sourcePair` gains `ops`, drops `affectedLines` |
| `webview/graphView.ts` | Rewrite | `measure`/`place`, kind encoding, defs/markers, elbow edges, flat fallback |
| `webview/index.ts` | Modify | `sourcePair` case only: `renderDiffPanel`, `expandedRuns`, `lastOps` |
| `webview/styles.css` | Modify | `fill:`→`stroke:` on `.node-box.status-*`; diff grid, ghost, muted, collapsed-run rules |
| `test/unit/lineDiff.test.ts` | Create | Diff classification cases |

## Testing Strategy (rewrite plan)

**Rewritten — assertions that encode replaced contracts:**

| File | Test | Change |
|---|---|---|
| `graphView.test.ts` L81-85 | `"lays relationship text below every node box"` | **Delete.** `.edge-label` text no longer exists. Replaced by the drawn-edge cases below. |
| `graphView.test.ts` L49-54 | `"explicitly marks ambiguous and unresolved edges…"` | Keep `data-resolution` assertions; drop reliance on `<text class="edge-label">`; add "no `marker-end` on ambiguous/unresolved". |
| `graphView.test.ts` L41-47 | `"renders every node and edge…"` | Keep as the `data-node-id` stability test; assert `function:pkg.a.f`'s `<g>` is a descendant of `module:pkg.a`'s `<g>`. |
| `graphView.test.ts` L56-65 | `"distinguishes added, removed, and modified…"` | Keep `data-change-status`; add `fill="none"` on every rect. |
| `webviewHost.test.ts` L98-108 | `"marks every extant line affected when a source has no counterpart"` | Rewrite to assert `ops` are all `{ op: "added", rightLine: 1 }` and that no `affectedLines` key is posted. |
| `webviewDom.test.ts` L109-122 | `"identifies affected comparison lines and navigates…"` | Split: drop `toContain("Affected lines: 1")` and the flat `<pre>` expectations; assert `.diff-row.op-removed`/`.op-added` content. The edge-navigation half is unchanged and must stay green untouched (contract proof). |
| `webviewDom.test.ts` L100-107 | oversized/section test | Unchanged; guards that the 300-node host gate still precedes rendering. |

**New coverage (one RED test each, per the proposal's list):**

1. `lineDiff`: identical sides → all `unchanged`; pure insertion; pure deletion; empty side; one-side-missing; correct `leftLine`/`rightLine` offsets from non-1 start lines.
2. Nested geometry: child `<g>` transform + measured box lies fully inside the parent's rect bounds; three-level nesting (module → class → method).
3. Kind encoding: `stroke-width`/`stroke-dasharray`/`rx` per the table; containers strictly thinner than entities; `class` ≠ `function`.
4. Outline-only: every `<rect class="node-box">` has `fill="none"`; status class present.
5. Arrowhead: resolved `import`/`call` carry `marker-end`; ambiguous/unresolved do not.
6. `contains` contributes no `<g class="edge">`, while surviving edges keep their original `graph.edges` indices.
7. Orphan node (container filtered out by `filterGraph`) renders as a loose root, no placeholder.
8. Degradation: 61-node graph renders the flat stack yet still outline-only with drawn edges.
9. `data-*` stability: full attribute set present with exact current values.
10. Click-to-expand: collapsed run toggles open then closed; a second `sourcePair` message resets it to collapsed.
11. Ghost column: one-sided pair still emits both `.side` cells per row.

Integration/e2e: existing `test/e2e/scenarios.ts` diagram and navigation scenarios must pass
unchanged — that is the click-contract proof at the top layer.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary is touched. `diffLines` is pure computation over already-resolved
snapshot content; the diff panel is DOM-built with `textContent` only, and the CSP meta tag
from `buildCspMetaTag` is unmodified.

## Migration / Rollout

No migration. No stored state, no persisted schema. Host and webview ship in one build, so the
`sourcePair` shape change cannot skew. Each slice reverts independently.

## Open Questions

None. (Flagged for `sdd-apply`: the vendored header must be jsdiff's **BSD-3-Clause** text —
the proposal's "MIT" wording matches `vscode-diff`, which decision 1 rejects.)
