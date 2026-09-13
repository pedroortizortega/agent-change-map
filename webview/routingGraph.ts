/**
 * Visibility-graph construction for the coordinated router (see
 * `openspec/changes/edge-router-performance/design.md`, Blocks D-3/D-4/D-5). Pure geometry, no
 * DOM, dual-compiled alongside `edgeGeometry.ts`. This module builds the shared lane graph ONCE
 * per `edgePathsFor` pass; `routeSearch.ts` (PR2) runs A* over the `RoutingGraph` this module
 * returns. No search logic lives here.
 *
 * Two implementation bugs measured and fixed during the pre-implementation spike (see
 * `apply-progress.md` Addendum 3) are deliberately designed out from the start:
 *  1. Container boxes are EXCLUDED from the obstacle set used to clip visibility edges — a
 *     container is hollow by construction (D-3); only leaf boxes without descendants ever block
 *     a lane segment. Treating containers as solid obstacles silently produces a graph that can
 *     never route anything, since a leaf's own escape lane sits inside its container's rect.
 *  2. Visibility-edge clipping never checks every candidate segment against every box (an
 *     `O(|X|*|Y|*boxes)` scan that hung even at `{60,120}`). Obstacle checks are pruned per row/
 *     column (filter boxes relevant to that row/column once, then sweep candidates against a
 *     sorted, pointer-advanced subset), keeping construction linear-ish in practice.
 */

import type { Point, Rect } from "./edgeGeometry.js";

/** Matches `edgeGeometry.ts`'s own `LANE_GAP` (kept independent — this module owns construction,
 * `edgeGeometry.ts` is untouched by this PR). */
export const LANE_GAP = 12;
/** D-5's lane count `L` — the dominant performance/richness knob for crossing-avoidance. */
export const LANE_COUNT = 3;

const EPS = 1e-6;

/** A single directed traversal of a graph edge from some node. `id` is the edge's stable
 * identity (independent of traversal direction), used as the `OccupancyIndex` key. */
export interface GraphEdgeRef {
  id: number;
  to: number;
}

export interface RoutingGraph {
  /** Sorted, deduped, integer lane-line X coordinates. */
  xs: Int32Array;
  /** Sorted, deduped, integer lane-line Y coordinates. */
  ys: Int32Array;
  /** `xi * ys.length + yi` — a pure function of lane indices, per design.md D-1. */
  nodeId(xi: number, yi: number): number;
  /** Every graph edge incident to `nodeId`, precomputed once at construction time. */
  neighbours(nodeId: number): readonly GraphEdgeRef[];
  /** D-3b: container indices whose x-band contains this (vertical) edge's column. Empty for
   * horizontal edges. */
  containerTagsOf(edgeRef: number): readonly number[];
}

export interface OccupancyIndex {
  owners(edgeRef: number): number;
  claim(path: readonly number[]): void;
  release(path: readonly number[]): void;
  snapshot(): OccupancyIndex;
}

class OccupancyIndexImpl implements OccupancyIndex {
  constructor(private readonly counts: Map<number, number> = new Map()) {}

  owners(edgeRef: number): number {
    return this.counts.get(edgeRef) ?? 0;
  }

  claim(path: readonly number[]): void {
    for (const id of path) this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  release(path: readonly number[]): void {
    for (const id of path) {
      const next = (this.counts.get(id) ?? 0) - 1;
      if (next <= 0) this.counts.delete(id);
      else this.counts.set(id, next);
    }
  }

  snapshot(): OccupancyIndex {
    return new OccupancyIndexImpl(new Map(this.counts));
  }
}

export function createOccupancyIndex(): OccupancyIndex {
  return new OccupancyIndexImpl();
}

/** True when `inner` sits fully inside `outer` (used to identify container boxes). */
function rectFullyInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Reserved label-row rect, matching `edgePathsFor`'s own convention exactly (kept independent
 * of `edgeGeometry.ts` since that file is untouched by this PR). */
function labelRect(box: Rect): Rect {
  return { x: box.x + 4, y: box.y + 6, w: Math.max(0, box.w - 8), h: Math.min(18, Math.max(0, box.h - 6)) };
}

export type PortSide = "top" | "bottom" | "left" | "right";

export interface PortSlot {
  anchor: Point;
  escape: Point;
  /** `i % L` — the construction-guaranteed distinct escape lane for this ordinal, per D-4. */
  laneIndex: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * D-4 port allocation: `pitch = max(4, min(LANE_GAP, floor(usable/(n+1))))`,
 * `off = round((i-(n-1)/2)*pitch)`, escape lane `k = i % L` docked at `boundary ±
 * LANE_GAP*(k+1)` — never at the exact boundary coordinate. Docking a port at its exact
 * boundary (instead of an escape-lane offset) was the Addendum-3 bug that caused 100% route
 * failure: the raw port point can snap to a grid node whose only viable edges are blocked by the
 * port's own box.
 */
export function allocatePort(box: Rect, side: PortSide, i: number, n: number): PortSlot {
  const horizontal = side === "top" || side === "bottom";
  const usable = (horizontal ? box.w : box.h) - 16;
  const pitch = Math.max(4, Math.min(LANE_GAP, Math.floor(usable / (n + 1))));
  const off = Math.round((i - (n - 1) / 2) * pitch);
  const laneIndex = ((i % LANE_COUNT) + LANE_COUNT) % LANE_COUNT;
  const escapeOffset = LANE_GAP * (laneIndex + 1);

  if (side === "top") {
    const x = clamp(box.x + box.w / 2 + off, box.x + 8, box.x + box.w - 8);
    return { anchor: { x, y: box.y }, escape: { x, y: box.y - escapeOffset }, laneIndex };
  }
  if (side === "bottom") {
    const x = clamp(box.x + box.w / 2 + off, box.x + 8, box.x + box.w - 8);
    return { anchor: { x, y: box.y + box.h }, escape: { x, y: box.y + box.h + escapeOffset }, laneIndex };
  }
  const y = clamp(box.y + 16 + off, box.y + 8, box.y + box.h - 8);
  if (side === "left") {
    return { anchor: { x: box.x, y }, escape: { x: box.x - escapeOffset, y }, laneIndex };
  }
  return { anchor: { x: box.x + box.w, y }, escape: { x: box.x + box.w + escapeOffset, y }, laneIndex };
}

/** Boxes sorted ascending by their own start coordinate on `axis`, for the pointer-advanced
 * obstacle sweep below (Addendum-3 build-blowup fix). */
function sortedByStart(boxes: readonly Rect[], axis: "x" | "y"): Rect[] {
  return [...boxes].sort((p, q) => p[axis] - q[axis]);
}

/**
 * One sweep across ascending `coords`, testing each consecutive `[coords[k], coords[k+1]]`
 * segment for a blocking box among `sorted` (boxes whose relevant span already known to
 * intersect this row/column, sorted ascending by their start coordinate on the swept axis).
 * The obstacle-scan pointer only ever advances forward across the whole sweep, so this is a
 * single linear pass over `coords.length + sorted.length`, not a re-scan of every box per
 * segment — the exact class of fix the O(|X|*|Y|*boxes) build blow-up needed.
 */
function sweepBlocked(coords: readonly number[], sorted: readonly Rect[], startKey: "x" | "y", spanKey: "w" | "h"): boolean[] {
  const blocked: boolean[] = new Array(Math.max(0, coords.length - 1)).fill(false);
  let ptr = 0;
  for (let k = 0; k < coords.length - 1; k += 1) {
    const lo = coords[k];
    const hi = coords[k + 1];
    while (ptr < sorted.length && sorted[ptr][startKey] + sorted[ptr][spanKey] <= lo + EPS) ptr += 1;
    let j = ptr;
    while (j < sorted.length && sorted[j][startKey] < hi - EPS) {
      if (sorted[j][startKey] + sorted[j][spanKey] > lo + EPS) {
        blocked[k] = true;
      }
      j += 1;
    }
  }
  return blocked;
}

/**
 * Builds the shared orthogonal lane visibility graph for one `edgePathsFor` pass. Nodes are the
 * cross product of lane-line X/Y coordinates (obstacle-box corners grown by `LANE_GAP` clearance
 * at `LANE_GAP*{1..L}` offsets, plus label-row corners); edges are horizontal/vertical visibility
 * segments between coordinate-adjacent nodes, clipped at real (leaf-only) obstacles. Container
 * boxes contribute lane-line coordinates and D-3b tags but are never obstacles themselves (D-3,
 * Addendum-3 bug #1). Called ONCE per pass — every edge's A* search (PR2) reuses this same graph.
 */
export function buildRoutingGraph(boxes: ReadonlyMap<string, Rect>): RoutingGraph {
  const boxList = [...boxes.values()];
  const isContainer = (box: Rect): boolean => boxList.some((other) => other !== box && rectFullyInside(other, box));
  const containers = boxList.filter(isContainer);
  // D-3, Addendum-3 bug #1: containers are hollow — only non-container leaves ever block a lane.
  const leaves = boxList.filter((box) => !isContainer(box));

  const xsSet = new Set<number>();
  const ysSet = new Set<number>();
  for (const box of boxList) {
    for (let k = 1; k <= LANE_COUNT; k += 1) {
      xsSet.add(Math.round(box.x - LANE_GAP * k));
      xsSet.add(Math.round(box.x + box.w + LANE_GAP * k));
      ysSet.add(Math.round(box.y - LANE_GAP * k));
      ysSet.add(Math.round(box.y + box.h + LANE_GAP * k));
    }
    const label = labelRect(box);
    xsSet.add(Math.round(label.x - 4));
    xsSet.add(Math.round(label.x + label.w + 4));
    ysSet.add(Math.round(label.y - 4));
    ysSet.add(Math.round(label.y + label.h + 4));
  }

  // D-3a: never emit a Y lane line within LANE_GAP of ANY container's top/bottom boundary —
  // checked against every container, not just the box that proposed the coordinate, so two
  // containers sitting close together can't accidentally reintroduce a forbidden-band line.
  const ysFiltered = [...ysSet].filter((y) =>
    containers.every((container) => {
      const distTop = Math.abs(y - container.y);
      const distBottom = Math.abs(y - (container.y + container.h));
      return distTop >= LANE_GAP - EPS && distBottom >= LANE_GAP - EPS;
    }),
  );

  const xs = Int32Array.from([...xsSet].sort((a, b) => a - b));
  const ys = Int32Array.from(ysFiltered.sort((a, b) => a - b));

  const leavesByX = sortedByStart(leaves, "x");
  const leavesByY = sortedByStart(leaves, "y");

  const nodeId = (xi: number, yi: number): number => xi * ys.length + yi;

  const adjacency = new Map<number, GraphEdgeRef[]>();
  const containerTagsById = new Map<number, number[]>();
  let nextEdgeId = 0;
  const addEdge = (a: number, b: number, containerTags: number[]): void => {
    const id = nextEdgeId;
    nextEdgeId += 1;
    containerTagsById.set(id, containerTags);
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push({ id, to: b });
    adjacency.get(b)!.push({ id, to: a });
  };

  // Horizontal visibility edges: for each row y, sweep the ascending xs against leaves whose
  // vertical interior strictly contains that row (obstacle relevance filtered ONCE per row,
  // then swept with a forward-only pointer across the sorted-by-x subset — never a per-segment
  // rescan of every box).
  for (let yi = 0; yi < ys.length; yi += 1) {
    const y = ys[yi];
    const active = leavesByX.filter((box) => box.y < y - EPS && y < box.y + box.h - EPS);
    const blocked = sweepBlocked(Array.from(xs), active, "x", "w");
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      if (!blocked[xi]) addEdge(nodeId(xi, yi), nodeId(xi + 1, yi), []);
    }
  }

  // Vertical visibility edges: symmetric sweep over columns. Every vertical edge additionally
  // carries D-3b container tags — which containers' x-band its column falls inside — for the
  // O(depth) relax-time admission predicate `routeSearch.ts` (PR2) applies. This is what lets
  // children inside a container still use its interior columns while ancestors of a DIFFERENT
  // edge stay excluded from long transit, without ever excluding the column from the graph.
  for (let xi = 0; xi < xs.length; xi += 1) {
    const x = xs[xi];
    const active = leavesByY.filter((box) => box.x < x - EPS && x < box.x + box.w - EPS);
    const blocked = sweepBlocked(Array.from(ys), active, "y", "h");
    const tags = containers.reduce<number[]>((acc, container, index) => {
      if (x >= container.x - LANE_GAP && x <= container.x + container.w + LANE_GAP) acc.push(index);
      return acc;
    }, []);
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      if (!blocked[yi]) addEdge(nodeId(xi, yi), nodeId(xi, yi + 1), tags);
    }
  }

  const emptyNeighbours: readonly GraphEdgeRef[] = [];
  const emptyTags: readonly number[] = [];
  return {
    xs,
    ys,
    nodeId,
    neighbours: (id: number): readonly GraphEdgeRef[] => adjacency.get(id) ?? emptyNeighbours,
    containerTagsOf: (edgeRef: number): readonly number[] => containerTagsById.get(edgeRef) ?? emptyTags,
  };
}
