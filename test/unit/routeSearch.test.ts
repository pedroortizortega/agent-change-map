import { describe, expect, it } from "vitest";
import type { Point, Rect } from "../../webview/edgeGeometry.js";
import { allocatePort, buildRoutingGraph, createOccupancyIndex } from "../../webview/routingGraph.js";
import type { GraphEdgeRef, PortSlot, RoutingGraph } from "../../webview/routingGraph.js";
import { BEND_COST, CROSSING_BASE, CROSSING_STEP, crossingPenaltyFor, routeOne } from "../../webview/routeSearch.js";
import type { EdgeContext } from "../../webview/routeSearch.js";

const noAncestors: EdgeContext = { ancestorContainers: new Set() };

function isOrthogonal(points: readonly Point[]): boolean {
  return points.slice(1).every((p, i) => {
    const a = points[i];
    return a.x === p.x || a.y === p.y;
  });
}

function segmentAvoidsRectInterior(a: Point, b: Point, rect: Rect): boolean {
  // Orthogonal-only segments: a horizontal or vertical run must not pass through the strict
  // interior of `rect`.
  if (a.y === b.y) {
    if (a.y <= rect.y || a.y >= rect.y + rect.h) return true;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return hi <= rect.x || lo >= rect.x + rect.w;
  }
  if (a.x <= rect.x || a.x >= rect.x + rect.w) return true;
  const lo = Math.min(a.y, b.y);
  const hi = Math.max(a.y, b.y);
  return hi <= rect.y || lo >= rect.y + rect.h;
}

function pathAvoidsRect(points: readonly Point[], rect: Rect): boolean {
  return points.slice(1).every((p, i) => segmentAvoidsRectInterior(points[i], p, rect));
}

/**
 * Hand-built minimal graph mocks below give full, exact control over topology, so the
 * deterministic tie-break / occupancy-penalty / bend-minimization tests can be verified by
 * independent hand computation instead of depending on `buildRoutingGraph`'s emergent geometry.
 */
function makeGraph(xs: number[], ys: number[], edges: { a: [number, number]; b: [number, number]; tags?: number[] }[]): RoutingGraph {
  const xsArr = Int32Array.from(xs);
  const ysArr = Int32Array.from(ys);
  const nodeId = (xi: number, yi: number): number => xi * ysArr.length + yi;
  const adjacency = new Map<number, GraphEdgeRef[]>();
  const tagsById = new Map<number, number[]>();
  const axisById = new Map<number, 0 | 1>();
  const nodesById = new Map<number, [number, number]>();
  edges.forEach(({ a, b, tags }, id) => {
    const na = nodeId(a[0], a[1]);
    const nb = nodeId(b[0], b[1]);
    if (!adjacency.has(na)) adjacency.set(na, []);
    if (!adjacency.has(nb)) adjacency.set(nb, []);
    adjacency.get(na)!.push({ id, to: nb });
    adjacency.get(nb)!.push({ id, to: na });
    tagsById.set(id, tags ?? []);
    // Same convention as `buildRoutingGraph`: axis 0 = horizontal (same yi, different xi), axis 1
    // = vertical (same xi, different yi).
    axisById.set(id, a[1] === b[1] ? 0 : 1);
    nodesById.set(id, [na, nb]);
  });
  return {
    xs: xsArr,
    ys: ysArr,
    nodeId,
    neighbours: (id: number): readonly GraphEdgeRef[] => adjacency.get(id) ?? [],
    containerTagsOf: (edgeRef: number): readonly number[] => tagsById.get(edgeRef) ?? [],
    edgeAxis: (edgeRef: number): 0 | 1 => axisById.get(edgeRef) ?? 0,
    edgeNodes: (edgeRef: number): readonly [number, number] => nodesById.get(edgeRef) ?? [0, 0],
  };
}

function slot(anchor: Point, escape: Point, laneIndex = 0): PortSlot {
  return { anchor, escape, laneIndex };
}

describe("routeSearch: D-5 crossing-penalty formula", () => {
  it("matches penalty(o) = o===0 ? 0 : 60+(o-1)*60", () => {
    expect(CROSSING_BASE).toBe(60);
    expect(CROSSING_STEP).toBe(60);
    expect(BEND_COST).toBe(16);
    expect(crossingPenaltyFor(0)).toBe(0);
    expect(crossingPenaltyFor(1)).toBe(60);
    expect(crossingPenaltyFor(2)).toBe(120);
    expect(crossingPenaltyFor(4)).toBe(240);
  });
});

describe("routeSearch: simple case, no obstacles", () => {
  it("finds a valid orthogonal path between two ports", () => {
    const boxes = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 100, h: 40 }],
      ["b", { x: 300, y: 0, w: 100, h: 40 }],
    ]);
    const g = buildRoutingGraph(boxes);
    const occ = createOccupancyIndex();
    const start = allocatePort(boxes.get("a")!, "right", 0, 1);
    const goal = allocatePort(boxes.get("b")!, "left", 0, 1);
    const route = routeOne(g, occ, start, goal, noAncestors);
    expect(route).toBeDefined();
    const path = route!;
    expect(path[0]).toEqual(start.anchor);
    expect(path.at(-1)).toEqual(goal.anchor);
    expect(isOrthogonal(path)).toBe(true);
  });
});

describe("routeSearch: obstacle avoidance", () => {
  it("routes a bent path around an obstacle instead of failing", () => {
    const boxes = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 60, h: 40 }],
      ["b", { x: 300, y: 0, w: 60, h: 40 }],
      ["obstacle", { x: 140, y: -40, w: 60, h: 120 }],
    ]);
    const g = buildRoutingGraph(boxes);
    const occ = createOccupancyIndex();
    const start = allocatePort(boxes.get("a")!, "right", 0, 1);
    const goal = allocatePort(boxes.get("b")!, "left", 0, 1);
    const route = routeOne(g, occ, start, goal, noAncestors);
    expect(route).toBeDefined();
    const path = route!;
    expect(isOrthogonal(path)).toBe(true);
    expect(pathAvoidsRect(path, boxes.get("obstacle")!)).toBe(true);
    // A real detour is required: a straight 2-point line would collide with the obstacle.
    expect(path.length).toBeGreaterThan(2);
  });
});

describe("routeSearch: deterministic tie-break (D-1: f -> h -> bends -> stateKey)", () => {
  // Diamond: S(0,0) -> A(10,0) -> D(10,10)  and  S(0,0) -> B(0,10) -> D(10,10).
  // startDir = west (anchor east of escape) mismatches BOTH first moves (east, south) equally,
  // so both arms tie on g (20 length + 2*BEND_COST = 52), h (0 at goal) and bends (2). Only the
  // arrival-direction-derived stateKey at D can decide: arriving via B (east, dir=0) produces a
  // smaller stateKey than arriving via A (south, dir=2), so B's arm must win, deterministically.
  it("picks the same winning path every time, matching the stateKey tie-break", () => {
    const g = makeGraph(
      [0, 10],
      [0, 10],
      [
        { a: [0, 0], b: [1, 0] }, // S-A horizontal, id 0
        { a: [0, 0], b: [0, 1] }, // S-B vertical, id 1
        { a: [1, 0], b: [1, 1] }, // A-D vertical, id 2
        { a: [0, 1], b: [1, 1] }, // B-D horizontal, id 3
      ],
    );
    const occ = createOccupancyIndex();
    const start = slot({ x: 15, y: 0 }, { x: 0, y: 0 }); // anchor east of escape -> startDir = west
    const goal = slot({ x: 20, y: 10 }, { x: 10, y: 10 });

    const expected: Point[] = [
      { x: 15, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ];

    const first = routeOne(g, occ, start, goal, noAncestors);
    const second = routeOne(g, occ, start, goal, noAncestors);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });
});

describe("routeSearch: bend-count as secondary cost", () => {
  // Same diamond, but startDir = east now matches the S-A arm's first move (0 initial bend),
  // so the S-A-D arm (1 total bend) strictly beats the S-B-D arm (2 total bends) on total cost.
  it("prefers the path with fewer bends when raw lengths tie", () => {
    const g = makeGraph(
      [0, 10],
      [0, 10],
      [
        { a: [0, 0], b: [1, 0] },
        { a: [0, 0], b: [0, 1] },
        { a: [1, 0], b: [1, 1] },
        { a: [0, 1], b: [1, 1] },
      ],
    );
    const occ = createOccupancyIndex();
    const start = slot({ x: -15, y: 0 }, { x: 0, y: 0 }); // anchor west of escape -> startDir = east
    const goal = slot({ x: 20, y: 10 }, { x: 10, y: 10 });

    const route = routeOne(g, occ, start, goal, noAncestors);
    expect(route).toEqual([
      { x: -15, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ]);
  });
});

describe("routeSearch: D-5 occupancy penalty changes the winning route", () => {
  // Ladder: direct S(0,0)-D(100,0) edge (length 100, id 0) vs. a detour via S2(0,10)/D2(100,10)
  // (length 120, 2 bends -> +32). startDir = south matches the detour's first move, so with the
  // direct edge unoccupied the direct route (100+16=116) beats the detour (152); once the direct
  // edge is claimed once (owners=1, penalty=60), the direct route (176) is worse than the detour
  // (152), so the search must switch routes.
  function ladder(): RoutingGraph {
    return makeGraph(
      [0, 100],
      [0, 10],
      [
        { a: [0, 0], b: [1, 0] }, // direct S-D, id 0
        { a: [0, 0], b: [0, 1] }, // S-S2, id 1
        { a: [0, 1], b: [1, 1] }, // S2-D2, id 2
        { a: [1, 1], b: [1, 0] }, // D2-D, id 3
      ],
    );
  }

  const start = slot({ x: 0, y: -10 }, { x: 0, y: 0 }); // anchor north of escape -> startDir = south
  const goal = slot({ x: 100, y: 0 }, { x: 100, y: 0 });

  it("takes the direct edge when it is unoccupied", () => {
    const g = ladder();
    const occ = createOccupancyIndex();
    const route = routeOne(g, occ, start, goal, noAncestors);
    expect(route).toEqual([
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it("switches to the detour once the direct edge is occupied, per the calibrated CROSSING_BASE", () => {
    const g = ladder();
    const occ = createOccupancyIndex();
    occ.claim([0]); // claim the direct S-D edge (id 0) -> owners(0) === 1 -> penalty 60
    expect(occ.owners(0)).toBe(1);
    const route = routeOne(g, occ, start, goal, noAncestors);
    expect(route).toEqual([
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: 0 },
    ]);
  });
});

describe("routeSearch: node-crossing penalty (crossing-fix extension)", () => {
  // A already-committed edge A routes straight horizontally through node (2,1) (x=10,y=10),
  // claimed via `occ.claim([...A's edge ids], g)` — the crossing-fix `graph` argument that
  // populates NODE-axis occupancy, not just same-edge `owners`. Edge B's direct path would run
  // straight VERTICALLY through that exact same node (2,1), a genuine perpendicular crossing this
  // extension exists to discourage. A disjoint detour column (x=-10) gives B a real, more
  // expensive alternative that touches none of A's claimed nodes.
  function crossingGraph(): RoutingGraph {
    return makeGraph(
      [-10, 0, 10, 20],
      [0, 10, 20],
      [
        { a: [1, 1], b: [2, 1] }, // id0: A, H y=10, x:0->10
        { a: [2, 1], b: [3, 1] }, // id1: A, H y=10, x:10->20
        { a: [2, 0], b: [2, 1] }, // id2: B direct, V x=10, y:0->10
        { a: [2, 1], b: [2, 2] }, // id3: B direct, V x=10, y:10->20
        { a: [2, 0], b: [0, 0] }, // id4: B detour, H y=0, x:10->-10
        { a: [0, 0], b: [0, 1] }, // id5: B detour, V x=-10, y:0->10
        { a: [0, 1], b: [0, 2] }, // id6: B detour, V x=-10, y:10->20
        { a: [0, 2], b: [2, 2] }, // id7: B detour, H y=20, x:-10->10
      ],
    );
  }

  const bStart = slot({ x: 10, y: -10 }, { x: 10, y: 0 }); // anchor north of escape -> startDir = south
  const bGoal = slot({ x: 10, y: 30 }, { x: 10, y: 20 });

  it("takes the direct straight-through path when node (2,1) carries no perpendicular occupancy", () => {
    const g = crossingGraph();
    const occ = createOccupancyIndex();
    const route = routeOne(g, occ, bStart, bGoal, noAncestors);
    expect(route).toEqual([
      { x: 10, y: -10 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 10, y: 30 },
    ]);
  });

  it("switches to the disjoint detour once A's horizontal route is claimed WITH the graph argument (node-axis occupancy)", () => {
    const g = crossingGraph();
    const occ = createOccupancyIndex();
    occ.claim([0, 1], g); // A's route: ids 0,1 — bumps horizontal-axis occupancy at nodes (2,1) (x=10,y=10) among others
    expect(occ.nodeAxisOwners(g.nodeId(2, 1), 0)).toBe(2); // node (2,1) is an endpoint of BOTH id0 and id1
    const route = routeOne(g, occ, bStart, bGoal, noAncestors);
    expect(route).toEqual([
      { x: 10, y: -10 },
      { x: 10, y: 0 },
      { x: -10, y: 0 },
      { x: -10, y: 10 },
      { x: -10, y: 20 },
      { x: 10, y: 20 },
      { x: 10, y: 30 },
    ]);
  });

  it("claim WITHOUT the graph argument does not populate node-axis occupancy — the search stays on the direct path (backward-compat no-op)", () => {
    const g = crossingGraph();
    const occ = createOccupancyIndex();
    occ.claim([0, 1]); // no graph passed — same-edge `owners` update only, no node-axis effect
    expect(occ.nodeAxisOwners(g.nodeId(2, 1), 0)).toBe(0);
    const route = routeOne(g, occ, bStart, bGoal, noAncestors);
    expect(route).toEqual([
      { x: 10, y: -10 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 10, y: 30 },
    ]);
  });
});

describe("routeSearch: D-3b container-tag admission predicate", () => {
  it("blocks a non-ancestor's long vertical transit tagged edge outside the port-Y window", () => {
    // Only one edge exists at all: S(y=0)-D(y=100), tagged with container 7. Both ports' TRUE
    // attachment points (anchors) sit close together near y=50 — only the graph's sparse y
    // sampling happens to be far apart — so `portYWindow` (derived from the anchors, per D-3b) is
    // a narrow band around y=50, not the edge's own [0,100] span. Container 7 is an ancestor, so
    // this edge is a long transit through its gutter relative to where the ports actually are,
    // not a short endpoint crossing, and must be inadmissible — leaving no path at all.
    const g = makeGraph(
      [0],
      [0, 100],
      [{ a: [0, 0], b: [0, 1], tags: [7] }],
    );
    const occ = createOccupancyIndex();
    const start = slot({ x: 0, y: 48 }, { x: 0, y: 48 });
    const goal = slot({ x: 0, y: 52 }, { x: 0, y: 52 });
    const ctx: EdgeContext = { ancestorContainers: new Set([7]) };
    const route = routeOne(g, occ, start, goal, ctx);
    expect(route).toBeUndefined();
  });

  it("admits the same edge for a genuinely short endpoint crossing within the port window", () => {
    const g = makeGraph(
      [0],
      [0, 20],
      [{ a: [0, 0], b: [0, 1], tags: [7] }],
    );
    const occ = createOccupancyIndex();
    const start = slot({ x: 0, y: -10 }, { x: 0, y: 0 });
    const goal = slot({ x: 0, y: 30 }, { x: 0, y: 20 });
    const ctx: EdgeContext = { ancestorContainers: new Set([7]) };
    const route = routeOne(g, occ, start, goal, ctx);
    expect(route).toBeDefined();
  });

  it("ignores containerTags for a container that is not an ancestor of this edge", () => {
    const g = makeGraph(
      [0],
      [0, 100],
      [{ a: [0, 0], b: [0, 1], tags: [7] }],
    );
    const occ = createOccupancyIndex();
    const start = slot({ x: 0, y: -10 }, { x: 0, y: 0 });
    const goal = slot({ x: 0, y: 110 }, { x: 0, y: 100 });
    const ctx: EdgeContext = { ancestorContainers: new Set() }; // container 7 is not an ancestor here
    const route = routeOne(g, occ, start, goal, ctx);
    expect(route).toBeDefined();
  });
});

describe("routeSearch: no path found", () => {
  it("returns undefined (not throws, not a degenerate path) when the graph has no edges at all", () => {
    const g = makeGraph([0, 100], [0, 100], []);
    const occ = createOccupancyIndex();
    const start = slot({ x: 0, y: -10 }, { x: 0, y: 0 });
    const goal = slot({ x: 100, y: 110 }, { x: 100, y: 100 });
    expect(() => routeOne(g, occ, start, goal, noAncestors)).not.toThrow();
    expect(routeOne(g, occ, start, goal, noAncestors)).toBeUndefined();
  });

  it("returns undefined when a full-height obstacle wall severs every visibility edge between the ports", () => {
    // A single leaf spanning far beyond both boxes' own y-range blocks every horizontal lane row
    // near either box at every x in [19, 501] — which covers both boxes' own escape lanes on the
    // side facing each other — so no horizontal (or, since the wall's y-range dwarfs everything
    // else, vertical-then-horizontal) route can cross from one side to the other.
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 500, y: 0, w: 20, h: 20 }],
      ["wall", { x: 19, y: -10000, w: 482, h: 20000 }],
    ]);
    const g = buildRoutingGraph(boxes);
    const occ = createOccupancyIndex();
    const start = allocatePort(boxes.get("source")!, "right", 0, 1);
    const goal = allocatePort(boxes.get("target")!, "left", 0, 1);
    expect(routeOne(g, occ, start, goal, noAncestors)).toBeUndefined();
  });
});

describe("routeSearch: determinism", () => {
  it("produces byte-identical results across repeated runs on the same graph", () => {
    const boxes = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 60, h: 40 }],
      ["b", { x: 300, y: 0, w: 60, h: 40 }],
      ["obstacle", { x: 140, y: -40, w: 60, h: 120 }],
    ]);
    const g = buildRoutingGraph(boxes);
    const occ = createOccupancyIndex();
    const start = allocatePort(boxes.get("a")!, "right", 0, 1);
    const goal = allocatePort(boxes.get("b")!, "left", 0, 1);
    const runs = Array.from({ length: 5 }, () => routeOne(g, occ, start, goal, noAncestors));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });
});
