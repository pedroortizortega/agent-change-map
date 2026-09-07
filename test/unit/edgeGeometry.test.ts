import { describe, expect, it } from "vitest";
import {
  CURVE_MIN_DROP,
  DETOUR_CLEARANCE,
  MAX_DETOURS,
  STUB_LEN,
  edgePathFor,
  obstaclesFor,
  routeWaypoints,
  segmentIntersectsRect,
  sourceAnchor,
  targetAnchor,
  type Point,
  type Rect,
} from "../../webview/edgeGeometry.js";

describe("segmentIntersectsRect", () => {
  it("returns true for a segment passing through a box's interior", () => {
    const rect: Rect = { x: 3, y: 3, w: 4, h: 4 };
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 10, y: 10 }, rect)).toBe(true);
  });

  it("returns false for a segment that only grazes a single boundary corner point", () => {
    const rect: Rect = { x: 4, y: 4, w: 4, h: 4 };
    expect(segmentIntersectsRect({ x: 0, y: 8 }, { x: 8, y: 0 }, rect)).toBe(false);
  });

  it("returns false for a box entirely aside the segment", () => {
    const rect: Rect = { x: 20, y: 20, w: 5, h: 5 };
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 10, y: 0 }, rect)).toBe(false);
  });
});

describe("edgePathFor", () => {
  it("matches the existing byte-identical Bezier golden when there are no obstacles", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 100, y: 200, w: 20, h: 20 }],
    ]);
    const from = sourceAnchor(boxes.get("source")!);
    const to = targetAnchor(boxes.get("target")!);
    const dy = Math.max(Math.round(Math.abs(to.y - from.y) / 2), CURVE_MIN_DROP);
    const expected = `M${from.x},${from.y} C${from.x},${from.y + dy} ${to.x},${to.y - dy} ${to.x},${to.y}`;
    expect(edgePathFor(boxes, "source", "target")).toBe(expected);
  });

  it("renders an unchanged dashed stub when the target box is missing, even with an intersecting obstacle", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 50, w: 20, h: 20 }],
    ]);
    const from = sourceAnchor(boxes.get("source")!);
    const expected = `M${from.x},${from.y} L${from.x},${from.y + STUB_LEN}`;
    expect(edgePathFor(boxes, "source", undefined)).toBe(expected);
    expect(edgePathFor(boxes, "source", "missing-target")).toBe(expected);
  });

  it("routes around one intervening box with a waypoint DETOUR_CLEARANCE clear of it", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 20, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    expect(d).toMatch(/^M[-\d.]+,[-\d.]+ L/);
    expect(d).toContain("C");
    const waypointMatch = /L(-?[\d.]+),(-?[\d.]+)/.exec(d);
    expect(waypointMatch).not.toBeNull();
    const wpX = Number(waypointMatch![1]);
    expect(wpX).toBe(0 - DETOUR_CLEARANCE);
  });

  it("chooses the detour side farther from the obstacle's bulk (left obstacle -> detour right)", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 40, y: 0, w: 20, h: 20 }],
      ["target", { x: 40, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 60, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    const waypointMatch = /L(-?[\d.]+),(-?[\d.]+)/.exec(d);
    const wpX = Number(waypointMatch![1]);
    expect(wpX).toBe(60 + DETOUR_CLEARANCE);
  });

  it("mirrors the side choice for an obstacle mostly right of the line (detour left)", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 40, y: 0, w: 20, h: 20 }],
      ["target", { x: 40, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 40, y: 100, w: 60, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    const waypointMatch = /L(-?[\d.]+),(-?[\d.]+)/.exec(d);
    const wpX = Number(waypointMatch![1]);
    expect(wpX).toBe(40 - DETOUR_CLEARANCE);
  });

  it("breaks a centred tie by detouring left", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 20, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    const waypointMatch = /L(-?[\d.]+),(-?[\d.]+)/.exec(d);
    const wpX = Number(waypointMatch![1]);
    expect(wpX).toBe(0 - DETOUR_CLEARANCE);
  });

  it("routes two stacked obstacles as two waypoints in top-to-bottom encounter order", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 50, y: 0, w: 20, h: 20 }],
      ["target", { x: 50, y: 300, w: 20, h: 20 }],
      ["obstacleTop", { x: 40, y: 100, w: 40, h: 20 }],
      ["obstacleBottom", { x: 40, y: 200, w: 40, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    const waypoints = Array.from(d.matchAll(/L(-?[\d.]+),(-?[\d.]+)/g)).map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
    expect(waypoints.length).toBe(2);
    expect(waypoints[0].y).toBeLessThan(waypoints[1].y);
  });

  it("terminates with at most MAX_DETOURS waypoints, well-formed d, and no throw for many obstacles", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 50, y: 0, w: 20, h: 20 }],
      ["target", { x: 50, y: 600, w: 20, h: 20 }],
      ["o1", { x: 40, y: 80, w: 40, h: 20 }],
      ["o2", { x: 40, y: 160, w: 40, h: 20 }],
      ["o3", { x: 40, y: 240, w: 40, h: 20 }],
      ["o4", { x: 40, y: 320, w: 40, h: 20 }],
      ["o5", { x: 40, y: 400, w: 40, h: 20 }],
    ]);
    let d: string | undefined;
    expect(() => {
      d = edgePathFor(boxes, "source", "target");
    }).not.toThrow();
    expect(d).toBeDefined();
    const waypoints = Array.from(d!.matchAll(/L(-?[\d.]+),(-?[\d.]+)/g));
    expect(waypoints.length).toBeLessThanOrEqual(MAX_DETOURS);
    expect(d).toMatch(/^M[-\d.]+,[-\d.]+( L[-\d.]+,[-\d.]+)* C[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+$/);
  });

  it("ends every routed d with a C landing exactly on the target's top-center anchor", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 40, y: 0, w: 20, h: 20 }],
      ["target", { x: 40, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 60, h: 20 }],
    ]);
    const to = targetAnchor(boxes.get("target")!);
    const d = edgePathFor(boxes, "source", "target")!;
    const match = /C[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ (-?[\d.]+),(-?[\d.]+)$/.exec(d);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(to.x);
    expect(Number(match![2])).toBe(to.y);
  });
});

describe("routeWaypoints — full-path clearance", () => {
  // Regression: a single midline waypoint only guarantees *that point* clears the obstacle,
  // not the straight approach/exit segments leading to and from it - those can still cut
  // straight back through the same box (or a different one), which is exactly the "line
  // enters the dashed box" bug found in hands-on testing. These assert every segment of the
  // full routed path (from -> ...waypoints -> to), not just the waypoints themselves.
  function assertPathClears(points: Point[], obstacles: readonly Rect[]): void {
    for (let i = 0; i < points.length - 1; i += 1) {
      for (const obstacle of obstacles) {
        expect(
          segmentIntersectsRect(points[i], points[i + 1], obstacle),
          `segment ${JSON.stringify(points[i])} -> ${JSON.stringify(points[i + 1])} crosses obstacle ${JSON.stringify(obstacle)}`,
        ).toBe(false);
      }
    }
  }

  it("a single wide obstacle: no segment of the full path crosses it", () => {
    const from: Point = { x: 10, y: 20 };
    const to: Point = { x: 10, y: 200 };
    const obstacles: Rect[] = [{ x: 0, y: 100, w: 20, h: 20 }];
    const waypoints = routeWaypoints(from, to, obstacles);
    assertPathClears([from, ...waypoints, to], obstacles);
    expect(waypoints.length).toBe(2); // one L-elbow: entry + exit, both at a clear x
  });

  it("two obstacles on opposite sides forcing two genuinely separate detours: no segment crosses either", () => {
    const from: Point = { x: 50, y: 0 };
    const to: Point = { x: 50, y: 300 };
    const obstacles: Rect[] = [
      { x: 40, y: 100, w: 20, h: 20 }, // centred near the line -> left detour
      { x: 55, y: 200, w: 40, h: 20 }, // mostly right of the line -> right detour, different x-range
    ];
    const waypoints = routeWaypoints(from, to, obstacles);
    assertPathClears([from, ...waypoints, to], obstacles);
  });

  it("realistic container-routing case: a line between two modules clears an unrelated sibling container between them", () => {
    // Mirrors the reported bug: three sibling module boxes stacked in one column ("route",
    // "route2", "app"); an edge from a function inside "route" to a function inside "app"
    // must not cut through the unrelated "route2" container sitting between them.
    const from: Point = { x: 60, y: 260 }; // bottom of a function box inside "route"
    const to: Point = { x: 60, y: 560 }; // top of a function box inside "app"
    const route2Container: Rect = { x: 20, y: 300, w: 200, h: 150 };
    const waypoints = routeWaypoints(from, to, [route2Container]);
    assertPathClears([from, ...waypoints, to], [route2Container]);
  });
});

describe("obstaclesFor", () => {
  it("excludes the source and target boxes themselves", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
    ]);
    const obstacles = obstaclesFor(boxes, "source", "target");
    expect(obstacles.length).toBe(0);
  });

  it("excludes an ancestor box containing an anchor point", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 10, y: 10, w: 20, h: 20 }],
      ["target", { x: 10, y: 200, w: 20, h: 20 }],
      ["ancestor", { x: 0, y: 0, w: 200, h: 400 }],
    ]);
    const obstacles = obstaclesFor(boxes, "source", "target");
    expect(obstacles.find((box) => box.x === 0 && box.y === 0)).toBeUndefined();
  });

  it("excludes a box fully contained inside the source or target rect", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 100, h: 100 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["descendant", { x: 10, y: 10, w: 5, h: 5 }],
    ]);
    const obstacles = obstaclesFor(boxes, "source", "target");
    expect(obstacles.find((box) => box.x === 10 && box.y === 10)).toBeUndefined();
  });

  it("includes an unrelated box that is none of the above", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["unrelated", { x: 0, y: 100, w: 20, h: 20 }],
    ]);
    const obstacles = obstaclesFor(boxes, "source", "target");
    expect(obstacles.find((box) => box.x === 0 && box.y === 100)).toBeDefined();
  });
});
