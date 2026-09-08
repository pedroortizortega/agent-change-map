/**
 * Pure edge-geometry module: anchors, obstacle testing, bounded waypoint detour routing, and
 * coordinated batch routing used by `graphView.ts`. No DOM, no imports — suitable for
 * future live re-routing and dual-compiled alongside the host tree
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
 * so the fallback's arrowhead/exit point lands clear of the node label. The label is always
 * drawn at a fixed local `y="20"` baseline (see `<text class="node-label" ...>` in
 * `graphView.ts`), which for a typical font puts the glyphs' own top edge around 9-11px above
 * that baseline - i.e. roughly `box.y + 9`. An earlier value of `8` here (chosen only by "half
 * of the leaf node height `NODE_H = 32`") left under 2px of clearance from that estimated glyph
 * top, which in practice still visibly touched the label - not the vertical dead-center this was
 * meant to fix, but not clearly separated either. `4` leaves a real margin from `box.y + 9` while
 * still landing well above a box's own vertical center for any realistically-sized node. Clamped
 * to half the box's own height so a very short box never gets an anchor point below its own
 * vertical center. */
export const SIDE_ANCHOR_INSET = 4;

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

/** Enter on the near-lane boundary, never sweep across the target interior. */
export function targetSideAnchor(target: Rect, laneSide: "left" | "right"): Point {
  const x = laneSide === "right" ? target.x + target.w : target.x;
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

/** Number of interior points sampled along a candidate Bezier curve for obstacle-clearance
 * checking - dense enough that the resulting micro-segments track the true curve closely. */
const CURVE_SAMPLE_COUNT = 12;

/** Points along the cubic Bezier `p0 -> c1 -> c2 -> p3` at `count` evenly-spaced interior
 * parameter values (excluding the endpoints themselves, which callers already have). */
function sampleCubicBezier(p0: Point, c1: Point, c2: Point, p3: Point, count: number): Point[] {
  const points: Point[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / (count + 1);
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    points.push({ x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y });
  }
  return points;
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
 * horizontally back in to `targetBox`'s near side. `from`/`to` (the ordinary bottom/top-center
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

/** True when some OTHER box in `boxes` sits fully inside `box` - i.e. `box` is a container
 * (module/class), not a leaf (function/method). */
function hasDescendant(box: Rect, ownId: string, boxes: ReadonlyMap<string, Rect>): boolean {
  for (const [id, other] of boxes) {
    if (id === ownId) continue;
    if (rectFullyInside(other, box)) return true;
  }
  return false;
}

/**
 * The `from` point an edge exits its source from. Ordinarily this is `sourceAnchor` (bottom-
 * center of the whole source box) - fine for a leaf source, or any source whose target sits
 * below it. But when the source is a CONTAINER (has its own nested descendants - see
 * `hasDescendant`) and the target sits above the container's own bottom edge (e.g. a module-
 * level call/import edge whose target is higher up the page, possibly even nested inside the
 * very same source, as with a module-level `Main(x)` call into a class defined in that module),
 * exiting from the bottom would force the path back up through the container's own other
 * descendants to reach a target above them - descendants deliberately excluded from
 * `obstaclesFor` as "the source's own children", so that backward sweep was never obstacle-
 * checked despite visibly cutting through them. Exiting from the container's own TOP edge
 * instead keeps this a short, local hop toward whatever sits above, with nothing of the
 * container's own to backtrack through.
 */
function sourceExitAnchor(sourceBox: Rect, sourceId: string, targetAnchorPoint: Point, boxes: ReadonlyMap<string, Rect>): Point {
  const targetIsAbove = targetAnchorPoint.y < sourceBox.y + sourceBox.h;
  if (targetIsAbove && hasDescendant(sourceBox, sourceId, boxes)) {
    return { x: sourceBox.x + sourceBox.w / 2, y: sourceBox.y };
  }
  return sourceAnchor(sourceBox);
}

/**
 * The final leg of every non-fallback path is a cubic Bezier from `tailStart` (either `from`
 * itself, when there are no waypoints, or the last waypoint) into `to`. Returns both the control
 * points (for building the `d` string) and points sampled along the curve (for clearance
 * checking) - the two must always be computed from the same control points, or a clearance check
 * could pass or fail against a curve shape that isn't actually the one rendered.
 */
function tailCurve(tailStart: Point, to: Point): { c1: Point; c2: Point; samples: Point[] } {
  const dy = Math.max(Math.round(Math.abs(to.y - tailStart.y) / 2), CURVE_MIN_DROP);
  const c1: Point = { x: tailStart.x, y: tailStart.y + dy };
  const c2: Point = { x: to.x, y: to.y - dy };
  return { c1, c2, samples: sampleCubicBezier(tailStart, c1, c2, to, CURVE_SAMPLE_COUNT) };
}

/**
 * Single-edge compatibility helper. The renderer uses `edgePathsFor` for coordinated routes.
 * Returns `undefined` when the source box is absent (caller renders nothing for that edge).
 * A missing target box always renders the dashed stub, never routed, even past intersecting
 * obstacles. When the local detour genuinely cannot clear (see `needsOuterLaneFallback`, or a
 * residual crossing survives `routeWaypoints`' `MAX_DETOURS` bound), routes through the shared
 * outer lane instead (see `outerLaneEdgePath`) - additive: every other case keeps exactly the
 * Bezier-blended local-detour path this function has always produced.
 *
 * The clearance check covers the FULL rendered path, not just its straight legs: the final leg
 * is always a Bezier curve (see `tailCurve`), whose control points can pull it outside the
 * straight line's own bounding box - most visibly for an edge whose target sits above its
 * source, where the curve dips below the source's own point before swinging up to the target.
 * An obstacle sitting in that dip was invisible to a straight-line-only check even though the
 * rendered curve plainly cut through it, so the sampled curve points are checked right alongside
 * the elbow legs, using the exact same control points the final `d` string is built from.
 */
export function edgePathFor(boxes: ReadonlyMap<string, Rect>, sourceId: string, targetId: string | undefined): string | undefined {
  const sourceBox = boxes.get(sourceId);
  if (!sourceBox) return undefined;
  const targetBox = targetId ? boxes.get(targetId) : undefined;
  if (!targetBox) {
    const from = sourceAnchor(sourceBox);
    return `M${from.x},${from.y} L${from.x},${from.y + STUB_LEN}`;
  }
  const to = targetAnchor(targetBox);
  const from = sourceExitAnchor(sourceBox, sourceId, to, boxes);
  const obstacles = obstaclesFor(boxes, sourceId, targetId);
  if (needsOuterLaneFallback(from, to, obstacles, boxes)) {
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to);
  }
  const waypoints = routeWaypoints(from, to, obstacles);
  const tailStart = waypoints.length > 0 ? waypoints[waypoints.length - 1] : from;
  const { c1, c2, samples } = tailCurve(tailStart, to);
  if (!pathClears([from, ...waypoints, ...samples, to], obstacles)) {
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to);
  }
  if (waypoints.length === 0) {
    return `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;
  }
  const lSegments = waypoints.map((wp) => `L${wp.x},${wp.y}`).join(" ");
  return `M${from.x},${from.y} ${lSegments} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;
}

/** A rendered relationship. Keep the caller's order to preserve data-edge-index identity. */
export interface RoutingEdge {
  source: string;
  target?: string;
}

interface Port { anchor: Point; escape: Point }
const LANE_GAP = 12;
/** Minimum gap kept between a routed segment and the actual boundary of an unrelated
 * (non-endpoint) obstacle box - a route may run right up to this margin, never inside it, so
 * a line never visually touches a box it has nothing to do with. Well under `LANE_GAP`, so it
 * never fights the port/escape spacing already reserved around every box. */
export const ROUTE_CLEARANCE = 2;

function simplifyRoute(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = result.at(-2);
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) {
      // Do not disguise a reversal through a box as a straight segment.
      const dot = (last.x - before.x) * (point.x - last.x) + (last.y - before.y) * (point.y - last.y);
      if (dot < 0) return [];
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function routingPorts(box: Rect, ordinal: number, count: number, inward: boolean): Port[] {
  const offset = ordinal - (count - 1) / 2;
  const x = box.x + box.w / 2 + offset * Math.min(12, (box.w - 16) / Math.max(1, count));
  const y = box.y + Math.min(16, box.h / 2) + offset * Math.min(8, Math.max(0, Math.min(16, box.h - 16)) / Math.max(1, count - 1));
  if (inward) {
    // Enter a containing endpoint below its title, rather than through the title row.
    const belowTitle = box.y + 26;
    return [
      { anchor: { x: box.x, y: belowTitle }, escape: { x: box.x + LANE_GAP, y: belowTitle } },
      { anchor: { x: box.x + box.w, y: belowTitle }, escape: { x: box.x + box.w - LANE_GAP, y: belowTitle } },
    ];
  }
  return [
    { anchor: { x, y: box.y }, escape: { x, y: box.y - LANE_GAP } },
    { anchor: { x, y: box.y + box.h }, escape: { x, y: box.y + box.h + LANE_GAP } },
    { anchor: { x: box.x, y }, escape: { x: box.x - LANE_GAP, y } },
    { anchor: { x: box.x + box.w, y }, escape: { x: box.x + box.w + LANE_GAP, y } },
  ];
}

function routeCost(points: Point[], occupied: readonly Point[][], limit: number): number {
  let cost = (points.length - 2) * 16;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]; const b = points[i];
    cost += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const horizontal = a.y === b.y;
    for (const route of occupied) for (let j = 1; j < route.length; j++) {
      if (cost >= limit) return cost;
      const c = route[j - 1]; const d = route[j];
      const otherHorizontal = c.y === d.y;
      if (horizontal === otherHorizontal) {
        const sameLine = horizontal ? a.y === c.y : a.x === c.x;
        const overlap = horizontal
          ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
          : Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
        if (sameLine && overlap > EPS) cost += 1000 + overlap * 10;
      } else {
        const h1 = horizontal ? a : c; const h2 = horizontal ? b : d;
        const v1 = horizontal ? c : a; const v2 = horizontal ? d : b;
        if (v1.x >= Math.min(h1.x, h2.x) && v1.x <= Math.max(h1.x, h2.x) && h1.y >= Math.min(v1.y, v2.y) && h1.y <= Math.max(v1.y, v2.y)) cost += 1000;
      }
    }
  }
  return cost;
}

/**
 * Coordinates all visible relationships: reserve ports, then choose a short orthogonal route
 * with bend, crossing and shared-segment penalties. This is a deterministic heuristic, not a
 * planarity guarantee. Ancestor containers may be crossed; unrelated boxes and descendants
 * remain obstacles. Unresolved stubs retain their existing explicit rendering contract.
 */
export function edgePathsFor(boxes: ReadonlyMap<string, Rect>, edges: readonly RoutingEdge[]): (string | undefined)[] {
  // Reserve the full label row, independent of font metrics/name length. Ancestor and
  // endpoint exclusions below apply to box interiors only, never to these title obstacles.
  const labels = [...boxes.values()].map(box => ({ x: box.x + 4, y: box.y + 6, w: Math.max(0, box.w - 8), h: Math.min(18, Math.max(0, box.h - 6)) }));
  const counts = new Map<string, number>();
  for (const edge of edges) if (boxes.has(edge.source) && edge.target && boxes.has(edge.target)) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  const occupied: Point[][] = [];
  const ordinal = (id: string): number => { const next = used.get(id) ?? 0; used.set(id, next + 1); return next; };
  const paths: (string | undefined)[] = Array.from({ length: edges.length });
  const ordered = edges.map((edge, index) => {
    const resolved = boxes.has(edge.source) && edge.target !== undefined && boxes.has(edge.target);
    return { edge, index, sourceSlot: resolved ? ordinal(edge.source) : 0, targetSlot: resolved ? ordinal(edge.target!) : 0 };
  });
  const span = (edge: RoutingEdge): number => Math.abs((boxes.get(edge.source)?.y ?? 0) - (boxes.get(edge.target ?? "")?.y ?? 0));
  // Reserve short local hops first; longer relationships can take the outer free lanes.
  ordered.sort((a, b) => span(a.edge) - span(b.edge) || a.index - b.index);
  for (const { edge, index, sourceSlot, targetSlot } of ordered) {
    const source = boxes.get(edge.source);
    const target = edge.target ? boxes.get(edge.target) : undefined;
    if (!source || !target) { paths[index] = edgePathFor(boxes, edge.source, edge.target); continue; }
    const sourceContainsTarget = source !== target && rectFullyInside(target, source);
    const targetContainsSource = source !== target && rectFullyInside(source, target);
    const sources = routingPorts(source, sourceSlot, counts.get(edge.source)!, sourceContainsTarget);
    const targets = routingPorts(target, targetSlot, counts.get(edge.target!)!, targetContainsSource);
    // The edge's own source/target box is kept at the near-zero EPS margin: a port's anchor
    // sits exactly on that box's own boundary, so shrinking it further would falsely flag the
    // route's own first/last segment as "entering" its own endpoint. Every genuinely unrelated
    // box instead gets a real ROUTE_CLEARANCE margin grown OUTWARD, not shrunk inward, so a
    // route must stay clear of the box's actual boundary by a visible amount - not just avoid
    // literally crossing into its interior, which still let a route visually touch or graze an
    // unrelated box's edge.
    const obstacles = [...boxes.values()].flatMap(box => {
      let margin: number;
      if (box === source) { if (sourceContainsTarget) return []; margin = EPS; }
      else if (box === target) { if (targetContainsSource) return []; margin = EPS; }
      else { if (rectFullyInside(source, box) || rectFullyInside(target, box)) return []; margin = -ROUTE_CLEARANCE; }
      return [{ x: box.x + margin, y: box.y + margin, w: box.w - 2 * margin, h: box.h - 2 * margin }];
    });
    const containers = [...boxes.values()].filter(box =>
      (box !== source && rectFullyInside(source, box)) || (box !== target && rectFullyInside(target, box)));
    // Ancestors permit short endpoint crossings, not long transit through their gutters.
    const clearsContainerLanes = (route: Point[]): boolean => route.slice(1).every((b, i) => {
      const a = route[i];
      if (a.y === b.y) return containers.every(box => {
        const overlap = Math.min(Math.max(a.x, b.x), box.x + box.w) - Math.max(Math.min(a.x, b.x), box.x);
        return overlap <= 32 || Math.min(Math.abs(a.y - box.y), Math.abs(a.y - box.y - box.h)) >= LANE_GAP;
      });
      return containers.every(box => {
        const overlap = Math.min(Math.max(a.y, b.y), box.y + box.h) - Math.max(Math.min(a.y, b.y), box.y);
        return overlap <= 32 || a.x <= box.x - LANE_GAP || a.x >= box.x + box.w + LANE_GAP;
      });
    });
    const xs = new Set<number>(); const ys = new Set<number>();
    for (const label of labels) {
      xs.add(label.x - 4); xs.add(label.x + label.w + 4);
      ys.add(label.y - 4); ys.add(label.y + label.h + 4);
    }
    for (const box of boxes.values()) {
      xs.add(box.x - LANE_GAP); xs.add(box.x + box.w + LANE_GAP);
      ys.add(box.y - LANE_GAP); ys.add(box.y + box.h + LANE_GAP);
    }
    const { leftX, rightX } = outerLaneXs(boxes);
    for (let lane = 0; lane <= occupied.length; lane++) {
      xs.add(leftX - lane * LANE_GAP); xs.add(rightX + lane * LANE_GAP);
    }
    let best: Point[] | undefined; let bestCost = Infinity;
    const consider = (candidate: Point[]): void => {
      const route = simplifyRoute(candidate);
      if (route.length < 2 || !pathClears(route, obstacles) || !pathClears(route, labels) || !clearsContainerLanes(route)) return;
      const cost = routeCost(route, occupied, bestCost);
      if (cost < bestCost) { best = route; bestCost = cost; }
    };
    for (const from of sources) for (const to of targets) {
      const a = from.escape; const b = to.escape;
      const middle = (points: Point[]): void => consider([from.anchor, a, ...points, b, to.anchor]);
      middle([{ x: a.x, y: b.y }]); middle([{ x: b.x, y: a.y }]);
      for (const x of xs) middle([{ x, y: a.y }, { x, y: b.y }]);
      for (const y of ys) middle([{ x: a.x, y }, { x: b.x, y }]);
    }
    // Complex/overlapping layouts can require more bends than this candidate family.
    // Preserve the relationship rather than hide it; ordinary stacked layouts find a route.
    if (!best) { paths[index] = edgePathFor(boxes, edge.source, edge.target); continue; }
    occupied.push(best);
    paths[index] = best.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  }
  return paths;
}
