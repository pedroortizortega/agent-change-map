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

const EPS = 1e-6;

/** Bottom-center anchor of a source box. */
export function sourceAnchor(source: Rect): Point {
  return { x: source.x + source.w / 2, y: source.y + source.h };
}

/** Top-center anchor of a target box. */
export function targetAnchor(target: Rect): Point {
  return { x: target.x + target.w / 2, y: target.y };
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
 * the way there. Each detour therefore inserts an L-elbow of *two* waypoints at a clear `x`
 * (`x - DETOUR_CLEARANCE` or `x + w + DETOUR_CLEARANCE`, whichever is closer to the original
 * `from`/`to` midpoint, a tie favouring the left side): one at the crossing segment's start
 * `y`, one at its end `y`. Because the elbow's vertical run sits at an `x` strictly outside the
 * obstacle's `[x, x+w]` span, it cannot re-enter that obstacle regardless of `y` - unlike a
 * single midline point, which offers no such guarantee for its approach/exit segments.
 *
 * At each of up to `MAX_DETOURS` iterations, the *entire* current path (from `from` through
 * every waypoint so far to `to`) is re-scanned for its first remaining crossing, so a detour
 * that resolves one obstacle is verified rather than assumed - including against obstacles a
 * prior detour hasn't touched. Exhausting `MAX_DETOURS` is not an error: the collected
 * waypoints are returned and a residual crossing is accepted.
 */
export function routeWaypoints(from: Point, to: Point, obstacles: readonly Rect[]): Point[] {
  const path: Point[] = [from, to];
  const midX = (from.x + to.x) / 2;
  for (let iteration = 0; iteration < MAX_DETOURS; iteration += 1) {
    let hitIndex = -1;
    let hit: Rect | undefined;
    for (let i = 0; i < path.length - 1; i += 1) {
      const crossing = firstCrossing(path[i], path[i + 1], obstacles);
      if (crossing) {
        hitIndex = i;
        hit = crossing;
        break;
      }
    }
    if (!hit) break;
    const a = path[hitIndex];
    const b = path[hitIndex + 1];
    const leftX = hit.x - DETOUR_CLEARANCE;
    const rightX = hit.x + hit.w + DETOUR_CLEARANCE;
    const detourX = Math.round(Math.abs(leftX - midX) <= Math.abs(rightX - midX) ? leftX : rightX);
    path.splice(hitIndex + 1, 0, { x: detourX, y: a.y }, { x: detourX, y: b.y });
  }
  return path.slice(1, -1);
}

/**
 * The ONE entry point both `graphView.ts` and `index.ts` call to compute an edge's `d` string.
 * Returns `undefined` when the source box is absent (caller renders nothing for that edge).
 * A missing target box always renders the dashed stub, never routed, even past intersecting
 * obstacles.
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
  const waypoints = routeWaypoints(from, to, obstacles);
  if (waypoints.length === 0) {
    const dy = Math.max(Math.round(Math.abs(to.y - from.y) / 2), CURVE_MIN_DROP);
    return `M${from.x},${from.y} C${from.x},${from.y + dy} ${to.x},${to.y - dy} ${to.x},${to.y}`;
  }
  const last = waypoints[waypoints.length - 1];
  const dy = Math.max(Math.round(Math.abs(to.y - last.y) / 2), CURVE_MIN_DROP);
  const lSegments = waypoints.map((wp) => `L${wp.x},${wp.y}`).join(" ");
  return `M${from.x},${from.y} ${lSegments} C${last.x},${last.y + dy} ${to.x},${to.y - dy} ${to.x},${to.y}`;
}
