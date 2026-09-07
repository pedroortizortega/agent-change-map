/**
 * Pure edge-geometry module: anchors, obstacle testing, bounded waypoint detour routing, and
 * the single `d`-string entry point shared by both `graphView.ts` (static render) and
 * `index.ts` (live drag re-route). No DOM, no imports — dual-compiled alongside the host tree
 * (see `tsconfig.build.json`) and the webview-only tree (`tsconfig.webview.json`).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Minimum vertical offset for a Bezier edge's control points (edges never point upward flat). */
export const CURVE_MIN_DROP = 16;
/** Length of the dashed stub drawn for ambiguous/unresolved/target-not-in-view edges. */
export const STUB_LEN = 28;
/** Gap kept between a detour waypoint and the obstacle edge it routes around. */
export const DETOUR_CLEARANCE = 12;
/** Hard bound on the number of detour waypoints computed per edge. */
export const MAX_DETOURS = 3;
/** Vertical inset (from a box's own top edge) used by the outer-lane fallback's side anchors,
 * so the fallback's arrowhead/exit point lands clear of the node label, which is always drawn
 * at a fixed local `y="20"` (see `<text class="node-label" ...>` in `graphView.ts`) - for
 * typical leaf-node box heights that sits very close to vertical dead-center, which is where
 * `sourceSideAnchor`/`targetSideAnchor` used to land, visually overlapping the label text. This
 * mirrors how the ordinary top-center `targetAnchor` already always arrives near a box's top
 * edge, away from the label. Clamped to half the box's own height so a very short box never
 * gets an anchor point below its own vertical center. */
export const SIDE_ANCHOR_INSET = 8;

const EPS = 1e-6;

/** Bottom-center anchor of a source box. */
export function sourceAnchor(source: Rect): Point {
  return { x: source.x + source.w / 2, y: source.y + source.h };
}

/** Top-center anchor of a target box. */
export function targetAnchor(target: Rect): Point {
  return { x: target.x + target.w / 2, y: target.y };
}

/** Side anchor's `y`: `SIDE_ANCHOR_INSET` below the box's own top edge, clamped so a very short
 * box never gets an anchor point past its own vertical center. */
function sideAnchorY(box: Rect): number {
  return box.y + Math.min(SIDE_ANCHOR_INSET, box.h / 2);
}

/** Side anchor of a source box, used only by the outer-lane fallback, so an edge leaving via
 * the shared lane exits sideways rather than downward into whatever sits below. `laneSide`
 * picks which side the shared lane sits on ("right" or "left" of every box in the graph); the
 * exit point is always on that same near-lane side. `y` sits near the box's own top edge (see
 * `SIDE_ANCHOR_INSET`), clear of the label row, rather than dead vertical center. */
export function sourceSideAnchor(source: Rect, laneSide: "left" | "right"): Point {
  const x = laneSide === "right" ? source.x + source.w : source.x;
  return { x, y: sideAnchorY(source) };
}

/** Side anchor of a target box, used only by the outer-lane fallback, so an edge arriving via
 * the shared lane enters sideways rather than through the target's top, which could otherwise
 * mean re-entering through whatever box is stacked directly above it. Enters on the side AWAY
 * from the lane (mirroring the existing right-lane behavior: lane on the right, entry from the
 * left) so the final approach lands on the box's far edge rather than immediately re-crossing
 * back toward the lane. `y` sits near the box's own top edge (see `SIDE_ANCHOR_INSET`), clear
 * of the label row, rather than dead vertical center. */
export function targetSideAnchor(target: Rect, laneSide: "left" | "right"): Point {
  const x = laneSide === "right" ? target.x : target.x + target.w;
  return { x, y: sideAnchorY(target) };
}

/**
 * Liang-Barsky slab clipping of segment `a`->`b` against axis-aligned rect `r`. Returns the
 * clipped parameter interval `[t0, t1]` within `[0, 1]`, or `undefined` when there is none.
 * A mere boundary touch clips to a near-zero-length interval, which callers must treat as
 * "not intersecting" via the `EPS` threshold.
 */
function clipSegment(a: Point, b: Point, r: Rect): { t0: number; t1: number } | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    const pi = p[i];
    const qi = q[i];
    if (pi === 0) {
      if (qi < 0) return undefined;
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return undefined;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return undefined;
        if (t < t1) t1 = t;
      }
    }
  }
  return { t0, t1 };
}

/** True when segment `a`->`b` crosses rect `r`'s interior (a boundary touch is not an intersection). */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  const clipped = clipSegment(a, b, r);
  if (!clipped) return false;
  return clipped.t1 - clipped.t0 > EPS;
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function rectFullyInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Every box that can act as an obstacle for the edge `sourceId` -> `targetId`: excludes the
 * source and target boxes themselves, any box containing either anchor point (this generically
 * excludes ancestor containers), and any box fully contained inside the source or target rect
 * (descendants).
 */
export function obstaclesFor(boxes: ReadonlyMap<string, Rect>, sourceId: string, targetId: string | undefined): Rect[] {
  const sourceBox = boxes.get(sourceId);
  const targetBox = targetId ? boxes.get(targetId) : undefined;
  const sourceAnchorPt = sourceBox ? sourceAnchor(sourceBox) : undefined;
  const targetAnchorPt = targetBox ? targetAnchor(targetBox) : undefined;
  const obstacles: Rect[] = [];
  for (const [id, box] of boxes) {
    if (id === sourceId || id === targetId) continue;
    if (sourceAnchorPt && pointInRect(sourceAnchorPt, box)) continue;
    if (targetAnchorPt && pointInRect(targetAnchorPt, box)) continue;
    if (sourceBox && rectFullyInside(box, sourceBox)) continue;
    if (targetBox && rectFullyInside(box, targetBox)) continue;
    obstacles.push(box);
  }
  return obstacles;
}

/** Finds the obstacle crossing segment `a`->`b` with the smallest entry parameter `t` (ties
 * broken by ascending obstacle `y`, then ascending `x`), or `undefined` when none crosses. */
function firstCrossing(a: Point, b: Point, obstacles: readonly Rect[]): Rect | undefined {
  let hit: Rect | undefined;
  let bestT = Infinity;
  for (const obstacle of obstacles) {
    const clipped = clipSegment(a, b, obstacle);
    if (!clipped || clipped.t1 - clipped.t0 <= EPS) continue;
    const t = clipped.t0;
    const better =
      hit === undefined ||
      t < bestT - EPS ||
      (Math.abs(t - bestT) <= EPS && (obstacle.y < hit.y || (obstacle.y === hit.y && obstacle.x < hit.x)));
    if (better) {
      bestT = t;
      hit = obstacle;
    }
  }
  return hit;
}

/**
 * Bounded L-shaped detour routing from `from` to `to` around `obstacles`. A single midline
 * waypoint only guarantees *that point* clears the obstacle - not the straight segments
 * leading to and from it, which can still cut back through the same box (or another one) on
 * the way there. Each detour therefore inserts an L-elbow of *two* waypoints: one at the
 * crossing segment's start `y`, one at its end `y`, both at one detour `x`.
 *
 * `obstacles` is first narrowed to boxes whose vertical extent actually overlaps `from`/`to`'s
 * span - a wide box nowhere near this particular edge's path still counts as an obstacle for
 * *some* edge, but forcing every edge to detour around it regardless of where it sits produces
 * a needlessly enormous swing. That `x` is then committed **once**, from the combined bounding
 * extent of every *relevant* obstacle (`min(x) - DETOUR_CLEARANCE` or `max(x+w) +
 * DETOUR_CLEARANCE`, whichever is closer to the original `from`/`to` midpoint, a tie favouring
 * the left side) - not recomputed per obstacle as an earlier version of this function did.
 * Picking a fresh side against whichever obstacle happens to be hit first let successive
 * detours flip sides against different obstacles, producing a visible zigzag that could cut
 * back through an already-cleared box or a still-excluded ancestor container on the way; a
 * single side, wide enough to clear every relevant obstacle in one elbow, has no such
 * back-and-forth to go wrong. Because the elbow's vertical run sits at an `x` strictly outside
 * every relevant obstacle's `[x, x+w]` span, it cannot re-enter any of them regardless of `y`.
 *
 * At each of up to `MAX_DETOURS` iterations, the *entire* current path (from `from` through
 * every waypoint so far to `to`) is re-scanned for its first remaining crossing, so a detour
 * that resolves one obstacle is verified rather than assumed. Exhausting `MAX_DETOURS` is not
 * an error: the collected waypoints are returned and a residual crossing is accepted.
 */
export function routeWaypoints(from: Point, to: Point, obstacles: readonly Rect[]): Point[] {
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  const relevant = obstacles.filter((o) => o.y < maxY && o.y + o.h > minY);
  if (relevant.length === 0) return [];
  const midX = (from.x + to.x) / 2;
  const leftX = Math.min(...relevant.map((o) => o.x)) - DETOUR_CLEARANCE;
  const rightX = Math.max(...relevant.map((o) => o.x + o.w)) + DETOUR_CLEARANCE;
  const detourX = Math.round(Math.abs(leftX - midX) <= Math.abs(rightX - midX) ? leftX : rightX);

  const path: Point[] = [from, to];
  for (let iteration = 0; iteration < MAX_DETOURS; iteration += 1) {
    let hitIndex = -1;
    for (let i = 0; i < path.length - 1; i += 1) {
      if (firstCrossing(path[i], path[i + 1], relevant)) {
        hitIndex = i;
        break;
      }
    }
    if (hitIndex === -1) break;
    const a = path[hitIndex];
    const b = path[hitIndex + 1];
    path.splice(hitIndex + 1, 0, { x: detourX, y: a.y }, { x: detourX, y: b.y });
  }
  return path.length > 2 ? path.slice(1, -1) : [];
}

/** True when no segment of the polyline `from -> ...points -> to` crosses any `obstacle`
 * (boundary touches don't count, matching `segmentIntersectsRect`). */
function pathClears(points: readonly Point[], obstacles: readonly Rect[]): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    for (const obstacle of obstacles) {
      if (segmentIntersectsRect(points[i], points[i + 1], obstacle)) return false;
    }
  }
  return true;
}

/** The horizontal extent of the smallest axis-aligned box enclosing every box in `boxes` - the
 * diagram's own overall width, used by `needsOuterLaneFallback` as the yardstick for "absurdly
 * wide" rather than any fixed pixel constant. */
function diagramWidth(boxes: ReadonlyMap<string, Rect>): number {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const box of boxes.values()) {
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.w);
  }
  return boxes.size === 0 ? 0 : maxX - minX;
}

/**
 * True when the local L-elbow detour `routeWaypoints` would compute for `from`->`to` around
 * `obstacles` has no free side to swing out to within the panel: the relevant obstacle group's
 * own combined width (`rightX - leftX`, the same bound `routeWaypoints` computes internally,
 * expanded by `DETOUR_CLEARANCE` on both sides) is already at least as wide as the whole
 * diagram's own measured extent (`diagramWidth`). When that holds, `leftX` sits at or beyond the
 * diagram's own left edge and `rightX` at or beyond its own right edge - both candidate detour
 * sides exit the panel, not just clear one obstacle - so a local detour is not the right tool for
 * this edge regardless of `MAX_DETOURS`. Compared directly against the diagram's own measured
 * width rather than a fixed pixel constant, so the check scales with whatever the graph actually
 * renders at.
 */
export function needsOuterLaneFallback(from: Point, to: Point, obstacles: readonly Rect[], boxes: ReadonlyMap<string, Rect>): boolean {
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  const relevant = obstacles.filter((o) => o.y < maxY && o.y + o.h > minY);
  if (relevant.length === 0) return false;
  const leftX = Math.min(...relevant.map((o) => o.x)) - DETOUR_CLEARANCE;
  const rightX = Math.max(...relevant.map((o) => o.x + o.w)) + DETOUR_CLEARANCE;
  return rightX - leftX >= diagramWidth(boxes);
}

/** `x` of both candidate shared outer vertical lanes: just past the left edge and just past the
 * right edge of every box in the whole graph, so either lane's vertical run can never cross any
 * of them regardless of which edge uses it. */
export function outerLaneXs(boxes: ReadonlyMap<string, Rect>): { leftX: number; rightX: number } {
  let minLeft = 0;
  let maxRight = 0;
  for (const box of boxes.values()) {
    minLeft = Math.min(minLeft, box.x);
    maxRight = Math.max(maxRight, box.x + box.w);
  }
  return { leftX: minLeft - DETOUR_CLEARANCE, rightX: maxRight + DETOUR_CLEARANCE };
}

/** Picks whichever outer lane sits closer to the edge's own `from`/`to` midpoint - the same
 * "closer side wins" logic `routeWaypoints` uses for its local detour (see its doc comment), so
 * the fallback exits toward whichever side the edge would naturally have swung out to anyway. A
 * tie favours the left side, again mirroring `routeWaypoints`. */
function pickLaneSide(from: Point, to: Point, leftX: number, rightX: number): "left" | "right" {
  const midX = (from.x + to.x) / 2;
  return Math.abs(midX - leftX) <= Math.abs(midX - rightX) ? "left" : "right";
}

/**
 * Outer-lane fallback path: exits `sourceBox` from its near-lane side, travels horizontally to
 * the shared lane, travels vertically in the lane to the target's row, then travels
 * horizontally back in to `targetBox`'s far side. `from`/`to` (the ordinary bottom/top-center
 * anchors) decide which of the two lanes (`outerLaneXs`) is closer via `pickLaneSide`; side
 * anchors (not the usual bottom/top-center ones) on both ends keep the horizontal legs at the
 * source's/target's own row, which - because this diagram nests children purely by vertical
 * stacking, never side by side - only ever overlaps their own ancestor chains (already excluded
 * from `obstacles`), never an unrelated box. Plain straight segments, no Bezier blending: unlike
 * the local-detour case, this path does not end by dropping into the target from directly above
 * it.
 */
function outerLaneEdgePath(boxes: ReadonlyMap<string, Rect>, sourceBox: Rect, targetBox: Rect, from: Point, to: Point): string {
  const { leftX, rightX } = outerLaneXs(boxes);
  const laneSide = pickLaneSide(from, to, leftX, rightX);
  const laneX = laneSide === "right" ? rightX : leftX;
  const sideFrom = sourceSideAnchor(sourceBox, laneSide);
  const sideTo = targetSideAnchor(targetBox, laneSide);
  return `M${sideFrom.x},${sideFrom.y} L${laneX},${sideFrom.y} L${laneX},${sideTo.y} L${sideTo.x},${sideTo.y}`;
}

/**
 * The ONE entry point both `graphView.ts` and `index.ts` call to compute an edge's `d` string.
 * Returns `undefined` when the source box is absent (caller renders nothing for that edge).
 * A missing target box always renders the dashed stub, never routed, even past intersecting
 * obstacles. When the local detour genuinely cannot clear (see `needsOuterLaneFallback`, or a
 * residual crossing survives `routeWaypoints`' `MAX_DETOURS` bound), routes through the shared
 * outer lane instead (see `outerLaneEdgePath`) - additive: every other case keeps exactly the
 * Bezier-blended local-detour path this function has always produced.
 */
export function edgePathFor(boxes: ReadonlyMap<string, Rect>, sourceId: string, targetId: string | undefined): string | undefined {
  const sourceBox = boxes.get(sourceId);
  if (!sourceBox) return undefined;
  const from = sourceAnchor(sourceBox);
  const targetBox = targetId ? boxes.get(targetId) : undefined;
  if (!targetBox) {
    return `M${from.x},${from.y} L${from.x},${from.y + STUB_LEN}`;
  }
  const to = targetAnchor(targetBox);
  const obstacles = obstaclesFor(boxes, sourceId, targetId);
  if (needsOuterLaneFallback(from, to, obstacles, boxes)) {
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to);
  }
  const waypoints = routeWaypoints(from, to, obstacles);
  if (!pathClears([from, ...waypoints, to], obstacles)) {
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to);
  }
  if (waypoints.length === 0) {
    const dy = Math.max(Math.round(Math.abs(to.y - from.y) / 2), CURVE_MIN_DROP);
    return `M${from.x},${from.y} C${from.x},${from.y + dy} ${to.x},${to.y - dy} ${to.x},${to.y}`;
  }
  const last = waypoints[waypoints.length - 1];
  const dy = Math.max(Math.round(Math.abs(to.y - last.y) / 2), CURVE_MIN_DROP);
  const lSegments = waypoints.map((wp) => `L${wp.x},${wp.y}`).join(" ");
  return `M${from.x},${from.y} ${lSegments} C${last.x},${last.y + dy} ${to.x},${to.y - dy} ${to.x},${to.y}`;
}
