/**
 * Pure edge-geometry module: anchors, obstacle testing, bounded waypoint detour routing, and
 * coordinated batch routing used by `graphView.ts`. Dual-compiled alongside the host tree
 * (see `tsconfig.build.json`) and the webview-only tree (`tsconfig.webview.json`).
 *
 * `edgePathsFor` (the coordinated multi-edge pass) is implemented on top of `routingGraph.ts`'s
 * shared visibility graph and `routeSearch.ts`'s per-edge A* search (see
 * `openspec/changes/edge-router-performance/design.md`), replacing the old per-edge
 * candidate-enumeration + `routeCost` scoring loop. Everything else in this file — anchors,
 * `edgePathFor` (the single-edge fallback), `routeWaypoints`, `outerLaneEdgePath`,
 * `roundedPolylinePath`, `obstaclesFor`, `clipSegment` — is untouched and reused, including as
 * `edgePathsFor`'s own fallback when the new router finds no valid route for an edge.
 */

import { buildRoutingGraph, allocatePort, createOccupancyIndex, type PortSide, type PortSlot, type RoutingGraph } from "./routingGraph.js";
import { routeOne, type EdgeContext } from "./routeSearch.js";

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

/** Renders a polyline of `points` as an SVG path `d` string (`M` for the first point, `L` for
 * every following one). */
function polylinePath(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/** Default corner-rounding radius used by `roundedPolylinePath` (visual redesign, post-PR4):
 * small enough to read as a gentle bend rather than an actual curve replacing the router's
 * orthogonal shape, matching the reference image's softened node-editor connector style. */
export const CORNER_RADIUS = 8;

/**
 * Renders a polyline of `points` as an SVG path `d` string whose interior corners (every point
 * strictly between the first and last) are smoothed with a small quadratic-Bezier blend instead
 * of a sharp `L,L` turn - purely a rendering change over `polylinePath`: the exact same waypoints
 * are visited in the exact same order, so the router's obstacle-avoidance decisions (port
 * allocation, crossing-penalty cost function, outer-lane fallback) are entirely unaffected. This
 * is deliberately applied only to the FINAL rendered `d` string, not to the waypoint arrays the
 * router itself reasons about, so `edgePathFor`'s (single-edge fallback) own geometry and its
 * existing exact-string unit tests are untouched.
 *
 * For each interior corner, both adjacent straight segments are shortened by `r` (clamped to
 * half the SHORTER of the two segments, so two waypoints closer together than `2r` never produce
 * a self-intersecting curve) and a `Q` command curves from the shortened end of the incoming leg,
 * through the original corner point (as the quadratic control point), to the shortened start of
 * the outgoing leg. The path's own start/end points, and therefore the edge's visual anchor onto
 * its source/target box, are unchanged - only points strictly between them are ever rounded.
 */
export function roundedPolylinePath(points: readonly Point[], radius: number = CORNER_RADIUS): string {
  if (points.length <= 2) return polylinePath(points);
  const parts: string[] = [`M${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const lenIn = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const lenOut = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    if (r <= EPS) {
      parts.push(`L${corner.x},${corner.y}`);
      continue;
    }
    const inX = corner.x + (r / lenIn) * (prev.x - corner.x);
    const inY = corner.y + (r / lenIn) * (prev.y - corner.y);
    const outX = corner.x + (r / lenOut) * (next.x - corner.x);
    const outY = corner.y + (r / lenOut) * (next.y - corner.y);
    parts.push(`L${inX},${inY}`, `Q${corner.x},${corner.y} ${outX},${outY}`);
  }
  const last = points[points.length - 1];
  parts.push(`L${last.x},${last.y}`);
  return parts.join(" ");
}

/**
 * Extracts an edge path's rendered start and end coordinates directly from its `d` string's
 * first and last numeric coordinate pair (the `M` point and the final segment's destination
 * point, whichever command produced it - `L`, `Q`, or `C` all end with a plain `x,y` pair).
 * `roundedPolylinePath`/`edgePathFor`'s corner-rounding and Bezier tails never move the path's
 * own start/end anchors (see `roundedPolylinePath`'s doc comment), so these two numbers are
 * exactly the same anchor coordinates the router itself computed - reading them back off the
 * final string is a pragmatic alternative to plumbing a second parallel return value through
 * every routing call site, not a reconstruction/estimate of the path's shape. */
export function pathEndpoints(d: string): { start: Point; end: Point } {
  const matches = Array.from(d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g));
  const first = matches[0]!;
  const last = matches[matches.length - 1]!;
  return {
    start: { x: Number(first[1]), y: Number(first[2]) },
    end: { x: Number(last[1]), y: Number(last[2]) },
  };
}

/**
 * The `y` `escapeSafeY` climbs/drops a side anchor to: whichever of "above the topmost box in
 * the whole diagram" or "below the bottommost box in the whole diagram" is closer to `y` (a tie
 * favouring the top, matching this module's other left/tie conventions). A horizontal run at
 * this `y` cannot cross ANY box's vertical extent, by construction - no box in `boxes` reaches
 * this far up (or down), so this is a hard geometric guarantee, not a per-box check that could
 * fail with nowhere left to fall back to.
 */
function escapeSafeY(y: number, boxes: ReadonlyMap<string, Rect>): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    minY = Math.min(minY, box.y);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const topY = minY - DETOUR_CLEARANCE;
  const bottomY = maxY + DETOUR_CLEARANCE;
  return Math.abs(y - topY) <= Math.abs(y - bottomY) ? topY : bottomY;
}

/**
 * Outer-lane fallback path: exits `sourceBox` from its near-lane side, travels horizontally to
 * the shared lane, travels vertically in the lane to the target's row, then travels
 * horizontally back in to `targetBox`'s near side. `from`/`to` (the ordinary bottom/top-center
 * anchors) decide which of the two lanes (`outerLaneXs`) is closer via `pickLaneSide`. Plain
 * straight segments, no Bezier blending: unlike the local-detour case, this path does not end by
 * dropping into the target from directly above it.
 *
 * The lane's own vertical run is safe by construction (`laneX` sits outside every box's
 * horizontal span - see `outerLaneXs`), but the two horizontal escape/entry legs - from the
 * source's/target's own side anchor across to the lane - are not: side anchors keep those legs
 * at the source's/target's own row, which is only guaranteed clear of their own ancestor chains
 * (already excluded from `obstacles`), not of some unrelated box that happens to sit at that
 * exact row after a drag. This is checked directly: the cheap direct path (four points, matching
 * this fallback's original shape) is tried first and used as-is whenever it genuinely clears
 * every obstacle, which covers the overwhelming common case and keeps this fallback's output
 * unchanged for it. Only when that direct path does NOT clear does this fall back further to a
 * geometrically-guaranteed detour: each side anchor first climbs/drops vertically (still along
 * the source's/target's own edge `x`, only over its own local vertical extent, since the
 * intervening obstacle plainly cannot occupy the same row as the endpoint it can also reach a
 * mutually clear `y` from without moving sideways first) to `escapeSafeY`, then travels
 * horizontally to the lane at that safe row - a row no box in the diagram reaches, by
 * construction, so this horizontal leg cannot cross anything regardless of what obstacle
 * triggered the fallback. There is no further fallback past this: if this geometrically-safe
 * variant somehow still fails to clear (accepted as a residual, best-effort case, consistent
 * with `routeWaypoints`' own `MAX_DETOURS` exhaustion), it is still the best available route and
 * is returned rather than producing no edge at all.
 */
function outerLaneEdgePath(
  boxes: ReadonlyMap<string, Rect>,
  sourceBox: Rect,
  targetBox: Rect,
  from: Point,
  to: Point,
  obstacles: readonly Rect[],
): string {
  const { leftX, rightX } = outerLaneXs(boxes);
  const laneSide = pickLaneSide(from, to, leftX, rightX);
  const laneX = laneSide === "right" ? rightX : leftX;
  const sideFrom = sourceSideAnchor(sourceBox, laneSide);
  const sideTo = targetSideAnchor(targetBox, laneSide);
  const direct = [sideFrom, { x: laneX, y: sideFrom.y }, { x: laneX, y: sideTo.y }, { x: sideTo.x, y: sideTo.y }];
  if (pathClears(direct, obstacles)) return polylinePath(direct);
  const fromSafeY = escapeSafeY(sideFrom.y, boxes);
  const toSafeY = escapeSafeY(sideTo.y, boxes);
  const safe = [
    sideFrom,
    { x: sideFrom.x, y: fromSafeY },
    { x: laneX, y: fromSafeY },
    { x: laneX, y: toSafeY },
    { x: sideTo.x, y: toSafeY },
    sideTo,
  ];
  return polylinePath(safe);
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
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to, obstacles);
  }
  const waypoints = routeWaypoints(from, to, obstacles);
  const tailStart = waypoints.length > 0 ? waypoints[waypoints.length - 1] : from;
  const { c1, c2, samples } = tailCurve(tailStart, to);
  if (!pathClears([from, ...waypoints, ...samples, to], obstacles)) {
    return outerLaneEdgePath(boxes, sourceBox, targetBox, from, to, obstacles);
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

const LANE_GAP = 12;
/** Minimum gap kept between a routed segment and the actual boundary of an unrelated
 * (non-endpoint) obstacle box - a route may run right up to this margin, never inside it, so
 * a line never visually touches a box it has nothing to do with. Well under `LANE_GAP`, so it
 * never fights the port/escape spacing already reserved around every box. */
export const ROUTE_CLEARANCE = 2;

const BEND_COST = 16;
const PORT_SIDES = ["bottom", "top", "right", "left"] as const;

/**
 * The single "obvious" side pairing for a non-containment edge, based on which axis dominates the
 * center-to-center displacement between `source` and `target` (below/above -> bottom/top,
 * left/right otherwise). Tried FIRST, alone, before ever paying for the full 4-sides x 4-sides
 * search: for the overwhelming common case (two boxes with no lane contention between them) this
 * one pairing is exactly what `routeOne`'s own A* would have picked as cheapest anyway, so trying
 * it alone keeps the typical per-edge cost at one `routeOne` call - the full cross-product search
 * is reserved for edges that actually need the extra route diversity (self-loops, and edges whose
 * natural pairing conflicts with an already-accepted route or an ancestor's gutter). Measured
 * necessary: an unconditional 4x4 search on every edge reintroduces cubic-ish scaling on a
 * flat/dense fixture (occupancy-penalised A* explores much more of the graph as contention grows),
 * even though `routeOne` itself is cheap in isolation - see PR3a's own apply-progress notes.
 */
function naturalSides(source: Rect, target: Rect): { sourceSide: PortSide; targetSide: PortSide } {
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0 ? { sourceSide: "bottom", targetSide: "top" } : { sourceSide: "top", targetSide: "bottom" };
  }
  return dx >= 0 ? { sourceSide: "right", targetSide: "left" } : { sourceSide: "left", targetSide: "right" };
}

/**
 * Same anchor as `allocatePort(box, side, ordinal, count)` (the ordinal-driven position D-4 ties
 * to visual port distinctness), but an EXPLICIT escape-lane depth instead of the one
 * `allocatePort` derives from `ordinal % LANE_COUNT`. Needed because `allocatePort`'s escalating
 * per-ordinal depths (`LANE_GAP*{1,2,3}` = 12/24/36px) can overshoot a densely-stacked layout's
 * own gap between consecutive boxes (measured: `layoutGraph`'s real flat-fallback rendering packs
 * boxes with a 16px gap, so a `laneIndex=2` (36px) escape lands inside the NEXT box, well past
 * where any graph lane could legally clear it) - a real, previously-undiscovered interaction
 * between D-4's port math and the actual production single-column layout, not a hypothetical
 * edge case. Trying the shallowest lane (`laneIndex=0`, 12px, fits every gap `layoutGraph` itself
 * produces) first keeps the common case at one clean `routeOne` call; the full 4-sides x
 * escalating-depth search remains available as tier 2 for edges that still need it.
 */
function portAtLane(box: Rect, side: PortSide, ordinal: number, count: number, laneIndex: number): PortSlot {
  const { anchor } = allocatePort(box, side, ordinal, count);
  const escapeOffset = LANE_GAP * (laneIndex + 1);
  if (side === "top") return { anchor, escape: { x: anchor.x, y: box.y - escapeOffset }, laneIndex };
  if (side === "bottom") return { anchor, escape: { x: anchor.x, y: box.y + box.h + escapeOffset }, laneIndex };
  if (side === "left") return { anchor, escape: { x: box.x - escapeOffset, y: anchor.y }, laneIndex };
  return { anchor, escape: { x: box.x + box.w + escapeOffset, y: anchor.y }, laneIndex };
}

/** Inward containment ports: enter a containing endpoint below its title, rather than through
 * the title row or the outer boundary a normal `allocatePort` side would use. Kept as a small,
 * local port constructor (mirrors the old `routingPorts`' inward branch exactly) rather than a
 * new `allocatePort` mode, since it is only ever used for the containment case and is not part
 * of `routingGraph.ts`'s general D-4 side/lane scheme. `laneIndex` is unused by `routeOne`, so
 * `0`/`1` are placeholders distinguishing the two candidates. */
function inwardPorts(box: Rect): PortSlot[] {
  const belowTitle = box.y + 26;
  return [
    { anchor: { x: box.x, y: belowTitle }, escape: { x: box.x + LANE_GAP, y: belowTitle }, laneIndex: 0 },
    { anchor: { x: box.x + box.w, y: belowTitle }, escape: { x: box.x + box.w - LANE_GAP, y: belowTitle }, laneIndex: 1 },
  ];
}

/** Approximate total cost of a fully-resolved route (fixed anchor/escape legs plus every graph
 * hop), for comparing across different port-side candidates. Mirrors `routeOne`'s own bend cost
 * (`BEND_COST` per direction change) and Manhattan length; occupancy penalty is intentionally
 * excluded here since it is already folded into which graph-internal path `routeOne` found for
 * each candidate. */
function routeCandidateCost(points: readonly Point[]): number {
  let cost = 0;
  let prevDir: "H" | "V" | undefined;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    cost += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const dir: "H" | "V" = a.y === b.y ? "H" : "V";
    if (prevDir && dir !== prevDir) cost += BEND_COST;
    prevDir = dir;
  }
  return cost;
}

/** Collapses consecutive collinear points (three or more points in a row sharing an axis) down to
 * just their endpoints. `routeOne`'s output walks the shared lane graph one small hop at a time
 * (dense, many points), unlike the old candidate-enumeration router's few big elbow waypoints;
 * `crossesAny` below is only cheap enough to run per-candidate when it operates on the collapsed,
 * "real corner" shape instead of every individual lane hop. */
function collapseCollinear(points: readonly Point[]): Point[] {
  if (points.length <= 2) return [...points];
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = result[result.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const collinear = (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!collinear) result.push(cur);
  }
  result.push(points[points.length - 1]);
  return result;
}

/**
 * True when `route` transversally crosses any already-accepted route from earlier in the same
 * `edgePathsFor` call (one segment horizontal, the other vertical, genuinely intersecting rather
 * than merely touching). `OccupancyIndex` only tracks ownership of the SAME shared graph edge
 * (parallel sharing, D-5's actual mechanism); it has no concept of two perpendicular graph edges
 * meeting at a node, so a horizontal detour from one edge's own port can still transit straight
 * through a completely unrelated edge's already-claimed vertical corridor without either edge's
 * occupancy penalty ever registering it. This is a real, disclosed gap in the D-5 mechanism as
 * landed (occupancy = edge-sharing only, not node-crossing) - checked explicitly here, at the
 * wiring layer, since it is the exact property the "avoids crossings" regression test asserts.
 * Cost: `O(acceptedRoutes x collapsedPathLength^2)` per candidate, on `collapseCollinear`'d input
 * (a handful of real corners, not every individual lane hop) - reintroduces some of the pairwise
 * scanning the new architecture set out to eliminate, but bounded by a small, fixed candidate
 * count and the collapsed corner count (both roughly the old algorithm's own waypoint scale),
 * NOT by lane-graph density; measured to keep the flat-fixture perf benchmark's shape intact
 * (still far below the old O(N^3)-ish curve). Flagged as a follow-up for PR3b: a node-occupancy
 * extension to `OccupancyIndex` (claim/check the NODES a route passes through, not just the
 * edges) would let this collapse back to O(1) per relaxation instead of a wiring-layer re-check.
 */
function crossesAny(route: readonly Point[], accepted: readonly (readonly Point[])[]): boolean {
  for (const other of accepted) {
    for (let a = 1; a < route.length; a += 1) for (let b = 1; b < other.length; b += 1) {
      const p = route[a - 1]; const q = route[a];
      const r = other[b - 1]; const t = other[b];
      const pVertical = p.x === q.x; const rVertical = r.x === t.x;
      if (pVertical === rVertical) continue;
      const [v1, v2, h1, h2] = pVertical ? [p, q, r, t] : [r, t, p, q];
      const crosses = v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x)
        && h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
      if (crosses) return true;
    }
  }
  return false;
}

/** Exact index of `value` in the sorted, deduped `arr`, or `-1` when absent. Used to recognise
 * which points in a `routeOne` result are real graph-lane coordinates (as opposed to a port's
 * fixed anchor/escape geometry), so the graph edges a route actually claims can be recovered
 * without `routeSearch.ts` needing to expose them directly (its `Point[] | undefined` return
 * shape is fixed by PR2's landed tests). */
function exactLaneIndex(arr: Int32Array, value: number): number {
  let lo = 0; let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === value) return mid;
    if (arr[mid] < value) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** Every graph edge id a `routeOne` result actually traverses, recovered by matching consecutive
 * point pairs that both land exactly on a graph lane coordinate (see `exactLaneIndex`) back to
 * `RoutingGraph.neighbours`. A port's anchor/escape points generally fail this match on at least
 * one axis (the anchor-fixed axis is not itself a sampled lane line, per `routeSearch.ts`'s own
 * design notes), so this naturally isolates the graph-internal segments `OccupancyIndex` cares
 * about, without needing `routeOne` to return anything beyond its existing `Point[]`. */
function graphEdgeIdsAlong(graph: RoutingGraph, points: readonly Point[]): number[] {
  const ids: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const axA = exactLaneIndex(graph.xs, a.x); const ayA = exactLaneIndex(graph.ys, a.y);
    const axB = exactLaneIndex(graph.xs, b.x); const ayB = exactLaneIndex(graph.ys, b.y);
    if (axA < 0 || ayA < 0 || axB < 0 || ayB < 0) continue;
    const nodeB = graph.nodeId(axB, ayB);
    const found = graph.neighbours(graph.nodeId(axA, ayA)).find(ref => ref.to === nodeB);
    if (found) ids.push(found.id);
  }
  return ids;
}

/**
 * Coordinates all visible relationships over ONE shared visibility graph (`buildRoutingGraph`,
 * built once per call) and ONE shared `OccupancyIndex`: each edge is routed independently by
 * `routeOne` (A* + D-5 occupancy penalty + D-3b container-tag admission). Port-side search is
 * TIERED for performance (see `naturalSides`'/`portAtLane`'s doc comments): one cheap "obvious"
 * pairing first, escalating to the full 4-sides x 3-depths search only when that pairing doesn't
 * clear obstacles/labels/the ancestor-gutter rule; containment edges (one endpoint nested inside
 * the other) always search their own small, fixed port set. Whichever tier finds a candidate,
 * `edgePathsFor` keeps the cheapest one that also clears every unrelated box's `ROUTE_CLEARANCE`
 * margin, every label row, and (preferentially, degrading when unavoidable - see the doc comments
 * on `clearsContainerLanes` and `crossesAny`) the D-3 container-lane rule and transversal-crossing
 * avoidance. When no candidate for an edge both routes AND clears obstacles/labels at all, the
 * edge falls back to the existing, unchanged `edgePathFor` (D-2) — exactly today's "no candidate
 * clears" behavior.
 */
export function edgePathsFor(boxes: ReadonlyMap<string, Rect>, edges: readonly RoutingEdge[]): (string | undefined)[] {
  const graph = buildRoutingGraph(boxes);
  const occ = createOccupancyIndex();
  // Reserve the full label row, independent of font metrics/name length. Ancestor and
  // endpoint exclusions below apply to box interiors only, never to these title obstacles.
  const labels = [...boxes.values()].map(box => ({ x: box.x + 4, y: box.y + 6, w: Math.max(0, box.w - 8), h: Math.min(18, Math.max(0, box.h - 6)) }));
  const boxList = [...boxes.values()];
  // Same "has a descendant fully inside it" predicate `routingGraph.ts` uses to build its own
  // `containers` array — reproduced here (not imported) so the ancestor-container INDICES this
  // function derives per edge line up with `RoutingGraph.containerTagsOf`'s own numbering, which
  // is scoped to one `buildRoutingGraph` call and not otherwise exposed.
  const isContainerBox = (box: Rect): boolean => boxList.some(other => other !== box && rectFullyInside(other, box));
  const containersInOrder = boxList.filter(isContainerBox);

  const counts = new Map<string, number>();
  for (const edge of edges) if (boxes.has(edge.source) && edge.target && boxes.has(edge.target)) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  const ordinal = (id: string): number => { const next = used.get(id) ?? 0; used.set(id, next + 1); return next; };
  const paths: (string | undefined)[] = Array.from({ length: edges.length });
  const ordered = edges.map((edge, index) => {
    const resolved = boxes.has(edge.source) && edge.target !== undefined && boxes.has(edge.target);
    return { edge, index, sourceSlot: resolved ? ordinal(edge.source) : 0, targetSlot: resolved ? ordinal(edge.target!) : 0 };
  });
  const span = (edge: RoutingEdge): number => Math.abs((boxes.get(edge.source)?.y ?? 0) - (boxes.get(edge.target ?? "")?.y ?? 0));
  // Reserve short local hops first; longer relationships can take the outer free lanes.
  ordered.sort((a, b) => span(a.edge) - span(b.edge) || a.index - b.index);
  const acceptedRoutes: Point[][] = [];

  for (const { edge, index, sourceSlot, targetSlot } of ordered) {
    const source = boxes.get(edge.source);
    const target = edge.target ? boxes.get(edge.target) : undefined;
    if (!source || !target) { paths[index] = edgePathFor(boxes, edge.source, edge.target); continue; }

    const sourceContainsTarget = source !== target && rectFullyInside(target, source);
    const targetContainsSource = source !== target && rectFullyInside(source, target);

    // The edge's own source/target box is kept at the near-zero EPS margin (a port's anchor sits
    // exactly on that box's own boundary); every genuinely unrelated box gets a real
    // ROUTE_CLEARANCE margin grown OUTWARD, exactly as the old candidate loop enforced.
    const obstacles = [...boxes.values()].flatMap(box => {
      let margin: number;
      if (box === source) { if (sourceContainsTarget) return []; margin = EPS; }
      else if (box === target) { if (targetContainsSource) return []; margin = EPS; }
      else { if (rectFullyInside(source, box) || rectFullyInside(target, box)) return []; margin = -ROUTE_CLEARANCE; }
      return [{ x: box.x + margin, y: box.y + margin, w: box.w - 2 * margin, h: box.h - 2 * margin }];
    });
    // Container-index numbering matches `RoutingGraph.containerTagsOf`'s own scheme (both
    // derived from the same `boxes` map via the identical `isContainerBox` predicate above), so
    // `ancestorContainers` feeds `routeOne`'s own D-3b admission predicate directly.
    const ancestorContainers = new Set<number>();
    const ancestorBoxes: Rect[] = [];
    containersInOrder.forEach((box, containerIndex) => {
      const isAncestor = (box !== source && rectFullyInside(source, box)) || (box !== target && rectFullyInside(target, box));
      if (isAncestor) { ancestorContainers.add(containerIndex); ancestorBoxes.push(box); }
    });
    // Belt-and-suspenders re-check of the SAME "ancestors permit short endpoint crossings, not
    // long transit through their gutters" property, kept in ADDITION to `routeOne`'s own D-3b
    // admission predicate: D-3b's `portYWindow` is derived from the two ports' own anchors, which
    // for a genuinely long edge (its two ports far apart) can span nearly the edge's entire
    // length - making the admission predicate close to vacuous for exactly the "long transit"
    // case this rule exists to catch. This context-free re-check (no window, just the absolute
    // `LANE_GAP` clearance the old candidate-enumeration loop enforced) is used as a PREFERENCE,
    // not a hard requirement (see the tiered candidate search below) - degrading to routeOne's
    // own, looser guarantee when no stricter candidate exists is safer than forcing every such
    // edge to the label/container-unaware `edgePathFor` fallback.
    const clearsContainerLanes = (route: readonly Point[]): boolean => route.slice(1).every((b, i) => {
      const a = route[i];
      if (a.y === b.y) return ancestorBoxes.every(box => {
        const overlap = Math.min(Math.max(a.x, b.x), box.x + box.w) - Math.max(Math.min(a.x, b.x), box.x);
        return overlap <= 32 || Math.min(Math.abs(a.y - box.y), Math.abs(a.y - box.y - box.h)) >= LANE_GAP;
      });
      return ancestorBoxes.every(box => {
        const overlap = Math.min(Math.max(a.y, b.y), box.y + box.h) - Math.max(Math.min(a.y, b.y), box.y);
        return overlap <= 32 || a.x <= box.x - LANE_GAP || a.x >= box.x + box.w + LANE_GAP;
      });
    });

    const ctx: EdgeContext = { ancestorContainers };
    const containment = sourceContainsTarget || targetContainsSource;

    const buildCandidates = (sourcePorts: readonly PortSlot[], targetPorts: readonly PortSlot[]) => {
      const list: { route: Point[]; cost: number; collapsed: Point[] }[] = [];
      for (const sp of sourcePorts) for (const tp of targetPorts) {
        const route = routeOne(graph, occ, sp, tp, ctx);
        if (!route) continue;
        if (!pathClears(route, obstacles) || !pathClears(route, labels)) continue;
        list.push({ route, cost: routeCandidateCost(route), collapsed: collapseCollinear(route) });
      }
      list.sort((a, b) => a.cost - b.cost);
      return list;
    };
    const isGoodEnough = (c: { route: Point[]; collapsed: Point[] }): boolean => clearsContainerLanes(c.route);

    let candidates: { route: Point[]; cost: number; collapsed: Point[] }[];
    let bestCandidate: { route: Point[]; cost: number; collapsed: Point[] } | undefined;
    // Containment edges are rare and their port set is small either way (2 inward candidates on
    // the containing box x up to 4 sides on the plain endpoint = 8 combos) - always search that
    // full small set rather than adding a separate tier for them.
    if (containment) {
      const containmentSource = sourceContainsTarget ? inwardPorts(source)
        : PORT_SIDES.map(side => allocatePort(source, side, sourceSlot, counts.get(edge.source)!));
      const containmentTarget = targetContainsSource ? inwardPorts(target)
        : PORT_SIDES.map(side => allocatePort(target, side, targetSlot, counts.get(edge.target!)!));
      candidates = buildCandidates(containmentSource, containmentTarget);
      bestCandidate = candidates.find(isGoodEnough);
    } else {
      // Tier 1 (the common case): try only the one "obvious" side pairing, at the SHALLOWEST
      // escape depth (`laneIndex=0`, see `portAtLane`'s doc comment) - a single `routeOne` call
      // per endpoint side. See `naturalSides`' doc comment for why this pairing is expected to
      // already be optimal most of the time.
      const { sourceSide, targetSide } = naturalSides(source, target);
      const tier1Source = [portAtLane(source, sourceSide, sourceSlot, counts.get(edge.source)!, 0)];
      const tier1Target = [portAtLane(target, targetSide, targetSlot, counts.get(edge.target!)!, 0)];
      candidates = buildCandidates(tier1Source, tier1Target);
      bestCandidate = candidates.find(isGoodEnough);

      // Tier 2 (escalate only when tier 1 didn't clear cleanly): the full 4-sides x
      // 3-escape-depths search, exactly what the old candidate-enumeration loop and design.md's
      // D-4 both describe (every side offered; `allocatePort`'s own ordinal-driven depth is one
      // of the three depths tried here, not overridden away).
      if (!bestCandidate) {
        const depths = [0, 1, 2];
        const fullSource = PORT_SIDES.flatMap(side => depths.map(d => portAtLane(source, side, sourceSlot, counts.get(edge.source)!, d)));
        const fullTarget = PORT_SIDES.flatMap(side => depths.map(d => portAtLane(target, side, targetSlot, counts.get(edge.target!)!, d)));
        candidates = buildCandidates(fullSource, fullTarget);
        bestCandidate = candidates.find(isGoodEnough);
      }
    }
    // Final degrade order over whichever tier ran: clear just one extra guarantee, then just
    // obstacles/labels, before ever falling back to `edgePathFor`.
    bestCandidate = bestCandidate
      ?? candidates.find(c => !crossesAny(c.collapsed, acceptedRoutes))
      ?? candidates.find(c => clearsContainerLanes(c.route))
      ?? candidates[0];

    // No candidate both found a path AND cleared every geometric guarantee — fall back to the
    // unchanged single-edge router exactly as today's "no candidate clears" path does (D-2).
    if (!bestCandidate) { paths[index] = edgePathFor(boxes, edge.source, edge.target); continue; }
    const best = bestCandidate.route;
    acceptedRoutes.push(bestCandidate.collapsed);
    occ.claim(graphEdgeIdsAlong(graph, best));
    // Corner-rounding (visual redesign, post-PR4) is applied to the final rendered string only;
    // occupancy bookkeeping above keeps using the sharp-cornered `best` waypoints.
    paths[index] = roundedPolylinePath(best);
  }
  return paths;
}
