# Design: Graph Layout and Interaction

## Technical Approach

Three presentation-layer slices over the existing containment layout, which is preserved, not
replaced. Slice A extracts every anchor/obstacle/path formula out of `webview/graphView.ts`
into one pure, DOM-free `webview/edgeGeometry.ts` (dual-compiled), adds bounded waypoint detour
routing and a deterministic sibling ordering. Slice B adds pointer drag in `webview/index.ts`
backed by a bounded `webview/positionOverrides.ts`, recomputing affected edge `d` attributes
per tick through the *same* `edgeGeometry` entry point. Slice C adds a `viewBox` to both SVG
roots and one `#graph`-scoped wheel handler.

Constraints frozen by the proposal and honoured here: `KIND_STYLE`, the outline-only /
status-stroke scheme, the `measure()`/`place()` mechanism, the `data-*` contract, and the CSP.

**Host/protocol verification (explicitly requested)**: none needed, confirmed against source.
`src/webviewProtocol.ts:59` already delivers `graph`, `diff`, `sourceIndex`, `edgeSources`,
`untrackedPaths` on the `graph` message, and `webview/index.ts` already retains `graph` in
module state (`let graph: AnalysisGraph | undefined`). Everything drag/route/zoom needs is
already webview-side. `src/webviewHost.ts` and `src/webviewProtocol.ts` are byte-unchanged.

Deviation note: this design exceeds the 800-word phase budget. Precedent is the two archived
designs in `openspec/changes/archive/`, both far longer; the phase brief required eight items
resolved concretely rather than restated.

## Architecture Decisions

| # | Question | Rejected | Decision & rationale |
|---|---|---|---|
| 1 | Shared-module boundary | `graphView` exports helpers that `index.ts` re-composes | `webview/edgeGeometry.ts` owns the *whole* `d` string via one `edgePathFor(boxes, sourceId, targetId)` call. Both consumers call that single function with the identical signature; neither ever composes anchors itself. Composition is exactly where duplication re-enters. |
| 2 | Live re-route scope (**deferred call #1**) | Full re-route of every edge on every `pointermove` | **Own-edges live, full pass on drop.** A full per-tick pass is O(E×N) ≈ 120 edges × 60 boxes ≈ 7 200 slab tests at pointer rate. Own-edges (source or resolved target inside the dragged DOM subtree) is O(k×N), k typically ≤ 5. On `pointerup` one full pass re-routes everything against settled boxes, so the picture the user keeps is fully consistent; only an unrelated edge's detour can be transiently stale mid-drag. The proposal's "edges follow live" requirement is about the *attached* edges — those are live, every tick. |
| 3 | Override value shape | Absolute `{x, y}` | `{dx, dy}` offset applied as `translate(baseX+dx, baseY+dy)`. Nested `<g>`s carry LOCAL transforms and a re-layout moves a node's base position when siblings change; an absolute override would fight the layout and could push a child outside its container frame. `dx/dy` is also literally what a drag produces. |
| 4 | Override bounding (**deferred call #2**) | Prune-on-render alone | **Prune-on-render *and* an LRU cap `MAX_POSITION_OVERRIDES = 200`.** Prune only fires at render, but a long-lived panel accumulates writes *between* renders. The cap mirrors the existing `SnapshotStore` bounded-map precedent (delete-then-set, evict `keys().next().value`), costs ~3 lines, and at 200 ≫ `NESTED_LAYOUT_LIMITS.nodes` (60) can never evict a live override. Unbounded growth is therefore not a real concern *after* this cap; without it, it would be. |
| 5 | Sibling order algorithm | Barycenter over edge endpoints | Kahn topological sort over the sibling-restricted non-`contains` subgraph, ties broken by original array index. Barycenter needs positions that do not exist yet at ordering time (ordering happens *before* `place()` assigns coordinates); a topological order is well-defined pre-layout, matches top-to-bottom stack semantics, and degenerates to **exact array order** when there are no arcs. |
| 6 | Cursor → user-space conversion | `getScreenCTM()` / `createSVGPoint()` | `getBoundingClientRect()` plus a zero-size fallback to the base viewBox dims. **Verified**: jsdom 30 implements *neither* SVG geometry API (`rg getScreenCTM\|createSVGPoint\|getBBox node_modules/jsdom/lib` → no matches), so committing to them forces SVG-DOM mocking in every zoom test. The rect path is correct in a real webview and deterministic under jsdom (rect is all-zero → fraction = `clientX / baseW`) with no mocks. This also rules out `getBBox()` as a source of live box geometry (Decision 8). |
| 7 | Pointer events in tests (**smoke-check resolved, not deferred**) | `MouseEvent` fallback | **jsdom 30.0.1 DOES construct `PointerEvent`** — verified in the installed tree: `node_modules/jsdom/lib/generated/idl/PointerEvent.js:93` declares `class PointerEvent extends globalObject.MouseEvent` and registers it in the ctor registry, wired at `lib/jsdom/living/interfaces.js:179`. Helpers use `new dom.window.PointerEvent(type, { clientX, clientY, bubbles: true })`. **But** `setPointerCapture` is *not* implemented anywhere in jsdom (verified: zero matches), so production code must feature-guard it and bind `pointermove`/`pointerup` on `document`, not rely on capture. The `MouseEvent` + `clientX`/`clientY` fallback stays documented but is not needed. |
| 8 | Where live boxes come from during a drag | Re-run layout in `index.ts`; export a box map from `renderGraphSvg`; `getBBox()` | Snapshot `readBoxes()` from the rendered DOM at `pointerdown`: absolute x/y = sum of ancestor `transform="translate(x,y)"` values parsed off each `<g>`; `w`/`h` read off the child `<rect>`'s `width`/`height` attributes. Then per tick, clone that snapshot and offset the dragged subtree by the accumulated delta. Reading attributes is not geometry math, so Decision 1 holds; it needs no new export or protocol field; and unlike `getBBox()` it works under jsdom. |
| 9 | Which nodes move with a container drag | Walk `Entity.containerId` chains in `graph.nodes` | Collect `movedIds` from the **DOM subtree** of the dragged `<g>`: `[dragged, ...dragged.querySelectorAll("[data-node-id]")]`. This is correct in both layouts — in `renderFlatSvg` there is no visual nesting, so a `containerId`-based walk would wrongly offset boxes that did not move on screen. |

## Interfaces / Contracts

### `webview/edgeGeometry.ts` (new — pure, no DOM, no imports)

```ts
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export const CURVE_MIN_DROP = 16;      // moved out of graphView.ts, value unchanged
export const STUB_LEN = 28;            // moved out of graphView.ts, value unchanged
export const DETOUR_CLEARANCE = 12;    // gap between a waypoint and the obstacle edge
export const MAX_DETOURS = 3;          // hard iteration bound

export function sourceAnchor(source: Rect): Point;          // bottom-center
export function targetAnchor(target: Rect): Point;          // top-center
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean;
export function obstaclesFor(
  boxes: ReadonlyMap<string, Rect>, sourceId: string, targetId: string | undefined,
): Rect[];
export function routeWaypoints(from: Point, to: Point, obstacles: readonly Rect[]): Point[];

/** The ONE entry point both consumers call. `undefined` when the source box is absent. */
export function edgePathFor(
  boxes: ReadonlyMap<string, Rect>, sourceId: string, targetId: string | undefined,
): string | undefined;
```

`graphView.ts` deletes its local `Rect`, `CURVE_MIN_DROP`, `STUB_LEN` and the whole `path`
computation inside `renderEdge`, replacing it with:

```ts
import { edgePathFor, type Rect } from "./edgeGeometry.js";
const path = edgePathFor(boxes, edge.source, targetId);
if (path === undefined) return undefined;
```

`index.ts` uses the identical call: `edgePathFor(liveBoxes, edge.source, targetIdOf(edge))`.
Any second implementation of anchor or routing math is a task violation (proposal Decision 1).

### Algorithm — obstacle test and waypoints

`segmentIntersectsRect` is Liang–Barsky slab clipping against the axis-aligned rect. The
clipped parameter interval must have length `> EPS (1e-6)`; a mere boundary touch is **not** an
intersection, so an edge landing on its target's top edge does not "hit" a neighbour.

`obstaclesFor` returns every box except: the source box, the target box, any box **containing
either anchor point** (this generically excludes ancestor containers), and any box fully
contained inside the source or target rect (descendants).

`routeWaypoints(from, to, obstacles)`:

```
waypoints = []; current = from; midX = (from.x + to.x) / 2
repeat at most MAX_DETOURS times:
  hit = the obstacle intersecting segment(current → to) with the smallest entry parameter t
        (ties broken by ascending y, then ascending x — deterministic)
  if no hit: break
  leftX  = hit.x - DETOUR_CLEARANCE
  rightX = hit.x + hit.w + DETOUR_CLEARANCE
  detourX = |leftX - midX| <= |rightX - midX| ? leftX : rightX     // tie → left
  wp = { x: round(detourX), y: round(hit.y + hit.h / 2) }
  waypoints.push(wp); current = wp
return waypoints
```

Exhausting `MAX_DETOURS` is **not** an error: the collected waypoints are returned and a
residual crossing is accepted — the proposal specifies *substantially fewer* crossings, not
zero. Cost is bounded at `MAX_DETOURS × |obstacles|` slab tests per edge.

### Path-string format (marker-end compatible)

| Case | `d` |
|---|---|
| No target box (stub) | `M{sax},{say} L{sax},{say+STUB_LEN}` — **never routed**, byte-identical to today |
| Target, no waypoints | `M{sax},{say} C{sax},{say+dy} {tax},{tay-dy} {tax},{tay}` with `dy = max(round(abs(tay-say)/2), CURVE_MIN_DROP)` — **byte-identical to today** (the explicit regression-proof requirement) |
| Target, N waypoints | `M{sax},{say} L{w1x},{w1y} … L{wNx},{wNy} C{wNx},{wNy+dy'} {tax},{tay-dy'} {tax},{tay}` with `dy' = max(round(abs(tay-wNy)/2), CURVE_MIN_DROP)` |

The final command is always a `C` arriving vertically at the target's top-center, so
`marker-end` arrowhead orientation is unchanged in every case.

### Sibling ordering (`webview/graphView.ts` only — never called from `index.ts`)

`computeChildrenOf(nodes: Entity[], edges: readonly Edge[] = [])`. It plugs in **after** the
existing bucketing loop (the orphan normalization and containment-cycle guard are untouched)
and **before** `place()` consumes `childrenOf.get(id)` — `measure()` is order-independent
(it sums child heights), so only `place()`'s emission order changes. Each bucket, including
the root `undefined` bucket, is reordered:

1. Map every node to its top-most ancestor **within its own bucket** (`siblingRootOf`).
2. For each non-`contains` edge with a `resolved` target, if `siblingRootOf(source) !==
   siblingRootOf(target)` and both are in this bucket, add arc `source→target`.
3. Kahn's algorithm; the ready queue always pops the **smallest original array index**.
4. On a cycle (queue empties with nodes remaining), emit the remaining node with the smallest
   original index and continue.

No arcs ⇒ output is exactly the input array order, so existing fixtures keep their geometry.
`renderFlatSvg` is untouched (array order stays).

### `webview/positionOverrides.ts` (new — pure, no DOM)

```ts
export const MAX_POSITION_OVERRIDES = 200;
export interface Offset { dx: number; dy: number }
export class PositionOverrides {
  get(id: string): Offset | undefined;
  set(id: string, offset: Offset): void;       // delete-then-set (LRU touch) + evict oldest
  pruneTo(presentIds: Iterable<string>): void; // silently drops absent ids
  readonly size: number;
}
```

**Stale-entry behaviour (explicitly requested)**: a stale id is never looked up — `applyPositionOverrides()`
iterates the *rendered* `[data-node-id]` elements and calls `get(id)`, so an override for an
absent node simply has no effect and is *not* an error path. `pruneTo(renderedIds)` then drops
it. The LRU cap (Decision 4) covers accumulation between renders.

### `webview/index.ts` module state (alongside `expandedRuns`/`preservedRuns`/`selectedNodeId`)

```ts
const DRAG_THRESHOLD = 5;                        // px, from the proposal's ~4–5px
const positionOverrides = new PositionOverrides();
const baseTransforms = new Map<string, Point>(); // layout-rendered translate, pre-override
let dragState: { nodeId: string; el: SVGGElement; startX: number; startY: number;
                 moved: boolean; base: Point; origin: Offset; movedIds: Set<string>;
                 boxes: Map<string, Rect>; edges: number[] } | undefined;
let suppressNextClick = false;
let viewBox: { x: number; y: number; w: number; h: number; baseW: number; baseH: number } | undefined;
const ZOOM_STEP = 1.1, ZOOM_MIN = 0.2, ZOOM_MAX = 5;
```

## Data Flow

    render (case "graph")
      innerHTML = renderGraphSvg(...)         graphView → edgeGeometry.edgePathFor
        │
        ├─ bind click + pointerdown per [data-node-id]
        ├─ resetViewBox()                     viewBox := "0 0 {width} {height}"
        └─ applyPositionOverrides()
             record baseTransforms · prune stale ids · re-apply dx/dy · full edge pass

    pointerdown → pointermove(>5px) → pointerup
      snapshot boxes + subtree     offset subtree by (dx,dy)      commit override
      + affected edge indices      set node transform             full edge pass
      suppressNextClick = false    edgePathFor per affected edge  suppressNextClick = true

    wheel over #graph → preventDefault → clamp → viewBox recentred on cursor

### Drag state machine (exact)

- **`pointerdown`** on a node `<g>`: `event.stopPropagation()` so the innermost node wins over
  its containers (click bubbling is left exactly as today). `suppressNextClick = false`.
  `movedIds` = the dragged element plus `dragged.querySelectorAll("[data-node-id]")`
  (Decision 9) — this set *is* the accumulated-delta mechanism the proposal requires.
  Snapshot `boxes = readBoxes()`; cache `edges` = indices of non-`contains` edges whose
  `source` or resolved `target` ∈ `movedIds`. Feature-guarded capture:
  `if (typeof el.setPointerCapture === "function") try { el.setPointerCapture(e.pointerId); } catch {}`.
  `pointermove`/`pointerup` are bound on `document` (works without capture, and under jsdom).
- **`pointermove`**: `dx = clientX - startX`, `dy = clientY - startY`. If `!moved &&
  hypot(dx,dy) < DRAG_THRESHOLD` → **return, nothing happens at all**. Otherwise `moved = true`,
  `el.classList.add("dragging")`; set the dragged `<g>`'s `transform` to
  `translate(base.x + origin.dx + dx, base.y + origin.dy + dy)`; build `liveBoxes` = clone of
  the snapshot with **every** rect whose id ∈ `movedIds` offset by `(origin.dx + dx, origin.dy + dy)`;
  for each cached edge index set its `<path>`'s `d` from `edgePathFor(liveBoxes, …)`.
  Descendant edges therefore re-anchor correctly on a container drag.
- **`pointerup`**: if `moved` → `positionOverrides.set(nodeId, {dx: origin.dx + dx, dy: origin.dy + dy})`,
  run the **full** edge pass over `liveBoxes` (Decision 2), `classList.remove("dragging")`, and
  `suppressNextClick = true`. If `!moved` → do nothing at all; the synthetic `click` fires and
  `choosePair` runs exactly as today. Release capture if held; `dragState = undefined`.
- The existing per-node click listener gains one guard, *without clearing the flag*:
  `if (suppressNextClick) return;` before `choosePair(...)`. The flag is cleared only by the
  next `pointerdown`. Clearing it inside the click handler would be wrong: a click on a nested
  node fires the child's *and* every ancestor's listener, so a consume-once flag would let the
  container navigate after a drag. In a real webview a genuine click is always preceded by a
  `pointerdown`; in tests the flag starts `false`, so the existing `click()` helper is unaffected.

### Zoom (exact)

`viewBox="0 0 {width} {height}"` is emitted by both `renderGraphSvg` and `renderFlatSvg` roots,
matching their existing `width`/`height` — no visual change at first paint. One listener bound
once in `initialize()` on `byId("graph")` with `{ passive: false }`:

```ts
if (!byId("graph").contains(event.target as Node) || !viewBox) return;  // scoping guard
event.preventDefault();
const factor = event.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
const w = clamp(viewBox.w * factor, viewBox.baseW / ZOOM_MAX, viewBox.baseW / ZOOM_MIN);
const h = w * (viewBox.baseH / viewBox.baseW);
const rect = svg.getBoundingClientRect();
const cw = rect.width  > 0 ? rect.width  : viewBox.baseW;   // jsdom fallback (Decision 6)
const ch = rect.height > 0 ? rect.height : viewBox.baseH;
const ux = (event.clientX - rect.left) / cw, uy = (event.clientY - rect.top) / ch;
viewBox.x += ux * (viewBox.w - w);   viewBox.y += uy * (viewBox.h - h);
viewBox.w = w; viewBox.h = h;
svg.setAttribute("viewBox", `${r2(x)} ${r2(y)} ${r2(w)} ${r2(h)}`);
```

Invariant: the user-space point under the cursor does not move. Reset lives at the end of
`case "graph":` — `resetViewBox()` reads the just-rendered `<svg>`'s `width`/`height` attributes
and rewrites `viewBox`. `case "graphSummary":` with `loadReason === "initial"` already clears
`#graph`; it additionally sets `viewBox = undefined`. Every render path goes through
`case "graph":`, so no other reset hook exists (Decision 3 of the proposal: reset always, both
initial and refresh). `WheelEvent` **is** implemented by jsdom, so tests construct it directly.

## `data-*` Contract Preservation (explicitly requested)

`data-node-id`, `data-node-kind`, `data-change-status`, `data-provenance`, `data-edge-index`,
`data-edge-kind`, `data-resolution` keep their **exact current names, values, and placement**;
no attribute is added, removed, or repurposed. The only DOM addition is the transient CSS
class `dragging`, added to the dragged `<g class="node">` via `classList.add` (preserving
`node`) between threshold-crossing and `pointerup`, purely for the `cursor: grabbing`
affordance. **No new `data-*` attribute is introduced**; all drag/zoom state lives in
module-level variables, not the DOM.

## File Changes

| File | Action | Description |
|---|---|---|
| `webview/edgeGeometry.ts` | Create | Anchors, slab intersection, `obstaclesFor`, `routeWaypoints`, `edgePathFor`, `Rect`/`Point`, `CURVE_MIN_DROP`/`STUB_LEN`/`DETOUR_CLEARANCE`/`MAX_DETOURS` |
| `webview/positionOverrides.ts` | Create | LRU + prune override map |
| `webview/graphView.ts` | Modify | Import `edgeGeometry`; delete local `Rect`/`CURVE_MIN_DROP`/`STUB_LEN` and `renderEdge`'s path math; `computeChildrenOf` edges param + Kahn order; `viewBox` on both SVG roots |
| `webview/index.ts` | Modify | Pointer drag wiring, `readBoxes`, `applyPositionOverrides`, click suppression, wheel handler, `resetViewBox` |
| `webview/styles.css` | Modify | `.node.dragging { cursor: grabbing; }` only (existing `.node, .edge { cursor: pointer; }` untouched) |
| `tsconfig.build.json` | Modify | `include` → `["src/**/*.ts", "webview/graphView.ts", "webview/edgeGeometry.ts"]`; `exclude` unchanged (`positionOverrides.ts` is webview-only, like `index.ts`) |
| `tsconfig.webview.json` | **None** | `include: ["webview/**/*.ts"]` already covers both new files — exactly how `graphView.ts` is covered today |
| `src/webviewHost.ts`, `src/webviewProtocol.ts` | **None** | Verified: no host or protocol change is needed |
| `test/unit/edgeGeometry.test.ts` | Create | Pure geometry cases |
| `test/unit/positionOverrides.test.ts` | Create | LRU/prune cases |
| `test/unit/graphView.test.ts` | Modify (additive) | Routing, ordering, `viewBox` cases |
| `test/unit/webviewDom.test.ts` | Modify (additive) | `drag()` helper, drag + zoom cases |
| `test/e2e/scenarios.ts` | **None** | Click-navigation scenario stays green untouched |

Build output is unaffected: `tsconfig.webview.json` emits `out/webview/webview/*.js` and the
relative `./edgeGeometry.js` specifier resolves in both emitted trees.
`scripts/copy-webview-assets.mjs` needs no change.

## Testing Strategy (Strict TDD — RED list)

Existing-test rewrite blast radius is expected **zero**: in both `graphView.test.ts` fixtures
the sibling subgraphs produce no arcs (`nestedGraph`'s module bucket has no cross-sibling edge;
the root bucket's single arc already matches array order), so every existing `transform`/`d`
assertion holds, and the non-crossing Bezier plus the stub strings are byte-identical by
construction. Any exact-coordinate assertion that *does* move is a legitimate rewrite to be
declared, not a silent edit.

**`test/unit/edgeGeometry.test.ts` (new, no DOM)**

1. `segmentIntersectsRect`: true through a box; false on a boundary touch; false for a box aside.
2. `edgePathFor`, no obstacles, resolved target → byte-identical Bezier golden.
3. Missing target box → unchanged dashed stub; never routed even with intersecting obstacles.
4. One intervening box → `M`/`L`/`C`; waypoint x is `DETOUR_CLEARANCE` clear of the obstacle.
5. Side choice: obstacle left of the line detours right; mirrored fixture detours left; centred tie → left (deterministic).
6. Two stacked obstacles → two waypoints in top-to-bottom encounter order.
7. More obstacles than `MAX_DETOURS` → terminates, ≤ `MAX_DETOURS` waypoints, well-formed `d`, residual crossing tolerated (no throw).
8. `obstaclesFor` excludes source/target boxes, any ancestor box containing an anchor, and any box fully inside source/target.
9. Every routed `d` ends with a `C` landing exactly on the target top-center anchor.

**`test/unit/positionOverrides.test.ts` (new)**

10. `set`/`get` round-trip; `set` on an existing id refreshes recency.
11. Exceeding `MAX_POSITION_OVERRIDES` evicts the least-recently-set id; `size` stays capped.
12. `pruneTo` drops ids absent from the present set, keeps present ones, never throws.

**`test/unit/graphView.test.ts` (additive)**

13. A fixture whose straight edge crosses an unrelated box renders a `d` containing `L` waypoints.
14. The existing non-crossing fixture's `d` is unchanged (majority-case regression proof).
15. Siblings with a `call` edge B→A place A above B (assert rendered `transform` y order).
16. Siblings with no non-`contains` edges keep exact array order.
17. A sibling cycle (A→B, B→A) emits every sibling exactly once, deterministically.
18. Root-level nodes obey the same ordering.
19. Both `renderGraphSvg` and `renderFlatSvg` roots carry `viewBox="0 0 {width} {height}"` matching their `width`/`height`.
20. `KIND_STYLE`, status classes, and every `data-*` attribute are unchanged on the routed fixture.

**`test/unit/webviewDom.test.ts` (additive)**

New helper, alongside the existing `click()` at line 24:

```ts
const drag = (selector: string, from: {x: number, y: number}, to: {x: number, y: number}) => {
  const el = element<Element>(selector);
  const pe = (type: string, p: {x: number, y: number}, target: EventTarget) =>
    target.dispatchEvent(new dom.window.PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true }));
  pe("pointerdown", from, el);
  pe("pointermove", to, dom.window.document);   // mid-drag assertions run between these
  pe("pointerup", to, dom.window.document);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));  // browser-faithful
};
```

Case 22 needs the steps individually, so `drag` is composed from an exported-in-test-file
`pointer(type, selector|document, x, y)` primitive that `drag` itself calls. `PointerEvent`
availability is **already verified** (Decision 7) — no smoke-check task is required; if it ever
regresses, swap `PointerEvent` for `MouseEvent` with the same `clientX`/`clientY` init.

21. Above-threshold drag updates the dragged node's `transform`.
22. An attached edge's `d` changes **after a `pointermove`, before `pointerup`** (live proof).
23. Below-threshold (2 px) sequence still fires click-to-navigate (`inspectSources` posted).
24. Above-threshold drag posts no `inspectSources` (click suppressed); a subsequent full pointerdown→click still navigates.
25. Container drag: a descendant's edge `d` equals `edgePathFor` over boxes offset by the accumulated delta.
26. A dragged position survives a simulated refresh render (`transform` = base + dx/dy).
27. An override for a node absent after refresh is dropped without error while a surviving node's override still applies.
28. First paint through the index render path carries a `viewBox` equal to `width`/`height`.
29. Wheel up over `#graph` shrinks `w`/`h` by `1/ZOOM_STEP` and keeps the cursor's user-space point fixed (exact numbers).
30. Wheel down zooms out; repeated ticks clamp at `ZOOM_MIN`; repeated up-ticks clamp at `ZOOM_MAX`.
31. A wheel targeting `#graph` is `defaultPrevented`.
32. A wheel dispatched on `#diff-panel` is **not** `defaultPrevented` and leaves `viewBox` unchanged.
33. A new `graph` render after zooming resets `viewBox` to the base.

| Layer | What to Test | Approach |
|---|---|---|
| Unit (pure) | `edgeGeometry`, `positionOverrides` | Plain function/class tests, no DOM |
| Unit (string) | `graphView` routing, ordering, `viewBox` | Existing `parseSvg` + attribute assertions |
| Unit (DOM) | drag, click disambiguation, override persistence, zoom | jsdom + existing `ChangeMapSession` harness, new `drag()` helper |
| Integration | None new | No host/protocol surface changes |
| E2E | Click-to-navigate | `test/e2e/scenarios.ts` untouched, must stay green |

## Threat Matrix

N/A — no request routing, shell command, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. Edge "routing" here is pure in-memory
geometry; the change is presentation-layer only, adds no dependency, and requires no CSP change.

## Review Workload Forecast

| PR | Scope | Est. authored lines |
|---|---|---|
| #1 | `edgeGeometry.ts`, `graphView` extraction + routing + sibling order, `tsconfig.build.json`, cases 1–9, 13–18, 20 | ~360 |
| #2 | `positionOverrides.ts`, drag wiring in `index.ts`, `styles.css` cursor, cases 10–12, 21–27 | ~340 |
| #3 | `viewBox` on both roots, wheel handler + reset, cases 19, 28–33 | ~170 |

PR #1 targets the feature/tracker branch, #2 targets #1, #3 targets #2. A single PR would land
~870 authored lines, well past the 400-line budget.

Decision needed before apply: Yes
Chained PRs recommended: Yes
400-line budget risk: High

## Migration / Rollout

No migration required. No host-side, wire-protocol, `data-*`, or persisted-state change; all
state lives in the live webview. Each slice reverts independently: dropping #3 removes the
`viewBox` and the wheel listener; dropping #2 removes the pointer wiring and the override map;
dropping #1 restores the inline fixed-anchor Bezier and array-order siblings.

## Open Questions

None. Both deferred `sdd-design` calls are resolved (Decisions 2 and 4), and the `jsdom`
`PointerEvent` smoke-check is resolved affirmatively against the installed package (Decision 7).
