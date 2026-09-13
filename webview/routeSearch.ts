/**
 * Per-edge A* search over the shared `RoutingGraph` (see `webview/routingGraph.ts` and
 * `openspec/changes/edge-router-performance/design.md`, Block D, decisions D-1/D-3b/D-5). Pure
 * geometry, no DOM. `buildRoutingGraph` runs ONCE per `edgePathsFor` pass; `routeOne` (this
 * module) is called once per edge over that same shared graph.
 *
 * Not wired into any production caller yet (PR3a's job). `edgeGeometry.ts` is untouched by this
 * PR; `routeOne`'s only currently-known contract is D-2's confirmed fallback: when it returns
 * `undefined`, the caller must fall back to the unchanged `edgePathFor`.
 */

import type { Point } from "./edgeGeometry.js";
import type { GraphEdgeRef, OccupancyIndex, PortSlot, RoutingGraph } from "./routingGraph.js";

/** Matches `routeCost`'s existing bend cost in `edgeGeometry.ts` (kept independent — this module
 * owns the new search, `edgeGeometry.ts` is untouched by this PR). */
export const BEND_COST = 16;
/** D-5: calibrated against `LANE_GAP`/`BEND_COST` so that detouring to an empty adjacent lane
 * (`2*LANE_GAP` length + 2 bends ≈ 56 cost units) is always strictly cheaper than sharing a
 * segment with one other route. */
export const CROSSING_BASE = 60;
export const CROSSING_STEP = 60;

/** `penalty(o) = o===0 ? 0 : CROSSING_BASE + (o-1)*CROSSING_STEP` (D-5), exported standalone so
 * its exact formula is independently unit-testable without needing to reverse-engineer it from
 * `routeOne`'s black-box routing decisions. */
export function crossingPenaltyFor(owners: number): number {
  return owners === 0 ? 0 : CROSSING_BASE + (owners - 1) * CROSSING_STEP;
}

/**
 * D-3b: container indices that are ancestors of THIS edge's own source/target box. A graph edge
 * tagged with one of these containers (via `RoutingGraph.containerTagsOf`) may only be used for a
 * short endpoint crossing near the edge's own ports, never as a long transit shortcut through the
 * container's interior gutters.
 */
export interface EdgeContext {
  ancestorContainers: ReadonlySet<number>;
}

/** Direction of travel used to arrive at a search node, needed for bend counting (D-1). Values
 * are an internal encoding only — no ordering significance beyond feeding `stateKey`. */
const enum Dir {
  East = 0,
  West = 1,
  South = 2,
  North = 3,
}

function dirOf(dx: number, dy: number): Dir {
  if (dx > 0) return Dir.East;
  if (dx < 0) return Dir.West;
  if (dy > 0) return Dir.South;
  return Dir.North;
}

function decode(nodeId: number, ysLength: number): { xi: number; yi: number } {
  return { xi: Math.floor(nodeId / ysLength), yi: nodeId % ysLength };
}

/** Nearest index in a sorted, deduped coordinate array (ties resolve to the lower index). Exact
 * matches are the common case (ports' escape coordinates are constructed to land exactly on a
 * lane line, see `routingGraph.ts`'s `allocatePort` doc comment) but the anchor-fixed axis of a
 * port is not itself a sampled lane line, so this always resolves to *some* real graph node
 * instead of requiring an exact hit on both axes. */
function nearestIndex(arr: Int32Array, value: number): number {
  if (arr.length === 0) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - value) <= Math.abs(arr[lo] - value)) return lo - 1;
  return lo;
}

function dedupeAdjacent(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    result.push(point);
  }
  return result;
}

/** Binary min-heap over a caller-supplied strict total order. Not the spike's naive linear-scan
 * open set (flagged in design.md/apply-progress.md's Addendum 3 as a confound to avoid
 * repeating) — real O(log n) push/pop. */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.items.length && this.less(this.items[l], this.items[smallest])) smallest = l;
        if (r < this.items.length && this.less(this.items[r], this.items[smallest])) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

interface QueueItem {
  f: number;
  h: number;
  bends: number;
  stateKey: number;
  node: number;
  dir: Dir;
  g: number;
}

/**
 * D-1: search state = `(node, incoming direction)`; `stateKey = nodeId*4 + dirIndex`. All costs
 * are integers (lane coordinates are already `Math.round`ed by `buildRoutingGraph`, and
 * `BEND_COST`/crossing penalties/Manhattan length are integers), so `f`/`h`/`bends` comparisons
 * are exact — no float associativity drift, `===` is safe. `stateKey` is unique per state, so the
 * comparator below is a strict total order: pop order is a pure function of the inserted set,
 * independent of heap array layout or sift implementation (design.md's determinism guarantee).
 */
function lessQueueItem(a: QueueItem, b: QueueItem): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  if (a.bends !== b.bends) return a.bends < b.bends;
  return a.stateKey < b.stateKey;
}

/**
 * A* over `g` from `start` to `goal`, folding D-5's occupancy penalty into edge relaxation (not a
 * post-hoc pairwise scan) and D-3b's per-edge container-tag admission predicate. Returns
 * `undefined` when no path exists (open set empties) — the caller's unchanged signal to fall back
 * to `edgePathFor` (D-2).
 */
export function routeOne(
  g: RoutingGraph,
  occ: OccupancyIndex,
  start: PortSlot,
  goal: PortSlot,
  ctx: EdgeContext,
): Point[] | undefined {
  if (g.xs.length === 0 || g.ys.length === 0) return undefined;

  const xi0 = nearestIndex(g.xs, start.escape.x);
  const yi0 = nearestIndex(g.ys, start.escape.y);
  const xiG = nearestIndex(g.xs, goal.escape.x);
  const yiG = nearestIndex(g.ys, goal.escape.y);
  if (xi0 < 0 || yi0 < 0 || xiG < 0 || yiG < 0) return undefined;

  const startNode = g.nodeId(xi0, yi0);
  const goalNode = g.nodeId(xiG, yiG);
  const goalX = g.xs[xiG];
  const goalY = g.ys[yiG];

  // The entry direction into the graph is already fixed by the port's own anchor->escape
  // geometry (established before the search begins), needed here only for the first internal
  // bend comparison.
  const startDir = dirOf(start.escape.x - start.anchor.x, start.escape.y - start.anchor.y);

  const portYWindow = {
    min: Math.min(start.anchor.y, goal.anchor.y) - 12,
    max: Math.max(start.anchor.y, goal.anchor.y) + 12,
  };

  const heuristic = (node: number): number => {
    const { xi, yi } = decode(node, g.ys.length);
    return Math.abs(g.xs[xi] - goalX) + Math.abs(g.ys[yi] - goalY);
  };

  const startStateKey = startNode * 4 + startDir;
  const gScore = new Map<number, number>([[startStateKey, 0]]);
  const bendsOf = new Map<number, number>([[startStateKey, 0]]);
  const cameFrom = new Map<number, { parentStateKey: number }>();
  const closed = new Set<number>();

  const heap = new MinHeap<QueueItem>(lessQueueItem);
  heap.push({
    f: heuristic(startNode),
    h: heuristic(startNode),
    bends: 0,
    stateKey: startStateKey,
    node: startNode,
    dir: startDir,
    g: 0,
  });

  let goalStateKey = -1;

  while (heap.size > 0) {
    const current = heap.pop()!;
    if (closed.has(current.stateKey)) continue;
    closed.add(current.stateKey);

    if (current.node === goalNode) {
      goalStateKey = current.stateKey;
      break;
    }

    for (const edge of g.neighbours(current.node) as readonly GraphEdgeRef[]) {
      const nextNode = edge.to;
      const cur = decode(current.node, g.ys.length);
      const nxt = decode(nextNode, g.ys.length);
      const dx = g.xs[nxt.xi] - g.xs[cur.xi];
      const dy = g.ys[nxt.yi] - g.ys[cur.yi];
      const nextDir = dirOf(dx, dy);

      const tags = g.containerTagsOf(edge.id);
      if (tags.length > 0) {
        const edgeYLo = Math.min(g.ys[cur.yi], g.ys[nxt.yi]);
        const edgeYHi = Math.max(g.ys[cur.yi], g.ys[nxt.yi]);
        const withinWindow = edgeYLo >= portYWindow.min && edgeYHi <= portYWindow.max;
        const admissible = tags.every((c) => !ctx.ancestorContainers.has(c) || withinWindow);
        if (!admissible) continue;
      }

      const bendHere = nextDir === current.dir ? 0 : 1;
      const length = Math.abs(dx) + Math.abs(dy);
      const penalty = crossingPenaltyFor(occ.owners(edge.id));
      const stepCost = length + bendHere * BEND_COST + penalty;

      const nextStateKey = nextNode * 4 + nextDir;
      if (closed.has(nextStateKey)) continue;

      const ng = current.g + stepCost;
      const nBends = current.bends + bendHere;
      const existingG = gScore.get(nextStateKey);
      const existingBends = bendsOf.get(nextStateKey);

      let accept = false;
      if (existingG === undefined || ng < existingG) accept = true;
      else if (ng === existingG) {
        if (existingBends === undefined || nBends < existingBends) accept = true;
        else if (nBends === existingBends) {
          const existingParent = cameFrom.get(nextStateKey);
          const currentParentKey = existingParent ? existingParent.parentStateKey : Number.POSITIVE_INFINITY;
          if (current.stateKey < currentParentKey) accept = true;
        }
      }
      if (!accept) continue;

      gScore.set(nextStateKey, ng);
      bendsOf.set(nextStateKey, nBends);
      cameFrom.set(nextStateKey, { parentStateKey: current.stateKey });

      heap.push({
        f: ng + heuristic(nextNode),
        h: heuristic(nextNode),
        bends: nBends,
        stateKey: nextStateKey,
        node: nextNode,
        dir: nextDir,
        g: ng,
      });
    }
  }

  if (goalStateKey < 0) return undefined;

  const nodeChain: number[] = [];
  let cursor: number | undefined = goalStateKey;
  while (cursor !== undefined) {
    nodeChain.push(Math.floor(cursor / 4));
    cursor = cameFrom.get(cursor)?.parentStateKey;
  }
  nodeChain.reverse();

  const points: Point[] = [start.anchor, start.escape];
  for (const node of nodeChain) {
    const { xi, yi } = decode(node, g.ys.length);
    points.push({ x: g.xs[xi], y: g.ys[yi] });
  }
  points.push(goal.escape, goal.anchor);

  return dedupeAdjacent(points);
}
