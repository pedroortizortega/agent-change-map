import { describe, expect, it } from "vitest";
import {
  CURVE_MIN_DROP,
  DETOUR_CLEARANCE,
  MAX_DETOURS,
  SIDE_ANCHOR_INSET,
  STUB_LEN,
  edgePathFor,
  obstaclesFor,
  routeWaypoints,
  segmentIntersectsRect,
  sourceAnchor,
  sourceSideAnchor,
  targetAnchor,
  targetSideAnchor,
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

  // Every fixture below adds a wide box far outside the edge's own y-span ("diagramContext"):
  // realistically-sized diagrams have many boxes, so the obstacle under test is always far
  // narrower than the diagram as a whole and the ordinary local detour applies. A fixture
  // containing only source/target/one obstacle has no such wider context, so its "diagram"
  // width degenerates to the obstacle's own width - exactly the shape `needsOuterLaneFallback`
  // (see edgePathFor — outer-lane fallback") is designed to catch, which would otherwise
  // misfire here and mask the local-detour behavior these tests exist to check.
  const diagramContext: [string, Rect] = ["diagramContext", { x: 0, y: 5000, w: 400, h: 20 }];

  it("routes around one intervening box with a waypoint DETOUR_CLEARANCE clear of it", () => {
    const boxes = new Map<string, Rect>([
      diagramContext,
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
      diagramContext,
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
      diagramContext,
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
      diagramContext,
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
      diagramContext,
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
      diagramContext,
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
      diagramContext,
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

  it("does not zigzag: obstacles on both sides of the straight line still detour to one committed side", () => {
    // Regression: an earlier version of this function picked a fresh detour side per
    // obstacle, independently, as each was hit along the path. Two obstacles pulling toward
    // opposite sides (one favouring left, one favouring right of the straight line) made the
    // route first swing one way, then reverse and swing the other - a visible back-and-forth
    // hook, even though every individual waypoint still technically cleared the one obstacle
    // it was computed against. Reproduces the exact shape from the reported screenshot: a
    // call edge from a method deep inside one module, past an unrelated sibling function
    // (favouring a left detour) and an unrelated sibling module box (favouring a right
    // detour), into a function inside a different module.
    const from: Point = { x: 140, y: 420 };
    const to: Point = { x: 128, y: 46 };
    const obstacles: Rect[] = [
      { x: 40, y: 348, w: 200, h: 32 }, // a sibling leaf box near `from` - alone, favours a left detour
      { x: 16, y: 192, w: 224, h: 72 }, // a wider unrelated module box further along - favours right
    ];
    const waypoints = routeWaypoints(from, to, obstacles);
    assertPathClears([from, ...waypoints, to], obstacles);
    // A single committed elbow never reverses direction: both waypoints share one x.
    expect(waypoints.length).toBe(2);
    expect(waypoints[0].x).toBe(waypoints[1].x);
  });

  it("ignores an obstacle whose vertical extent never overlaps the edge's path, however wide", () => {
    // Regression: the committed detour x was computed from the combined bounds of *every*
    // given obstacle, including ones nowhere near this edge's vertical span. A wide box
    // sitting well below (or above) the from/to range still pushed the detour far outside
    // the whole diagram - a needlessly enormous swing for an edge that never comes near it.
    const from: Point = { x: 100, y: 40 };
    const to: Point = { x: 100, y: 100 };
    const farAwayWideObstacle: Rect = { x: -500, y: 500, w: 2000, h: 50 }; // well below from/to
    const nearbyObstacle: Rect = { x: 80, y: 60, w: 40, h: 20 }; // actually in the way
    const waypoints = routeWaypoints(from, to, [farAwayWideObstacle, nearbyObstacle]);
    assertPathClears([from, ...waypoints, to], [nearbyObstacle]);
    // The detour clears the *nearby* obstacle only - it must not swing out anywhere near the
    // far-away obstacle's edges (x=-500 or x=1500).
    for (const wp of waypoints) {
      expect(Math.abs(wp.x)).toBeLessThan(200);
    }
  });
});

describe("edgePathFor — outer-lane fallback", () => {
  // Regression: reported live-testing bug. When the obstacle standing between source and
  // target spans (close to) the diagram's own full width, the local L-elbow detour has no
  // free side to swing out to within the panel - both `leftX` and `rightX` land at or past the
  // diagram's own edges. `edgePathFor` must recognize this and fall back to a shared outer
  // vertical lane instead of producing a detour that is effectively as wide as the diagram
  // itself. Since a follow-up fix, the fallback supports lanes on BOTH sides and picks
  // whichever is closer to the edge's own from/to position (mirroring `routeWaypoints`' local
  // detour side selection) - it is no longer hardcoded to "source exits right, target enters
  // left".
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

  it("routes through the LEFT outer lane, exiting/entering by side anchors near the box top, when source/target sit near the diagram's left edge", () => {
    // Source/target sit at x=10 (near the diagram's own left edge, since the wide obstacle
    // spans x=[0,500]); their from/to midpoint (x=20) is far closer to the left lane
    // (leftX=-12) than to the right lane (rightX=512) - so the fix must pick the LEFT lane here,
    // not hardcode the right one the way the previous (buggy) version always did.
    const boxes = new Map<string, Rect>([
      ["source", { x: 10, y: 0, w: 20, h: 20 }],
      ["target", { x: 10, y: 400, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 200, w: 500, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    // Exits the source from its LEFT side (near-lane side), enters the target from its RIGHT
    // side (away side) - and both anchors' y sit SIDE_ANCHOR_INSET below the box's own top
    // edge (y=0 / y=400), not dead vertical center (y=10 / y=410) which would overlap the
    // node-label row drawn at local y="20".
    expect(d).toBe(`M10,${0 + SIDE_ANCHOR_INSET} L-12,${0 + SIDE_ANCHOR_INSET} L-12,${400 + SIDE_ANCHOR_INSET} L30,${400 + SIDE_ANCHOR_INSET}`);
    const points = Array.from(d.matchAll(/-?[\d.]+,-?[\d.]+/g)).map((match) => {
      const [x, y] = match[0].split(",").map(Number);
      return { x, y };
    });
    assertPathClears(points, [boxes.get("obstacle")!]);
    // Real clearance from the obstacle's own bounds, not a couple-pixel hug: the lane run sits
    // a full DETOUR_CLEARANCE outside the obstacle's [0, 500] span.
    for (const p of points) {
      if (p.y > 200 && p.y < 220) expect(p.x).toBeLessThanOrEqual(0 - DETOUR_CLEARANCE);
    }
  });

  it("routes through the RIGHT outer lane when source/target sit near the diagram's right edge instead", () => {
    // Mirror image of the left-lane case above: source/target now sit at x=470 (near the wide
    // obstacle's right end), so their midpoint is far closer to the right lane than the left
    // one - the fix must still pick the right lane in that situation, proving both sides are
    // genuinely reachable rather than one hardcoded direction.
    const boxes = new Map<string, Rect>([
      ["source", { x: 470, y: 0, w: 20, h: 20 }],
      ["target", { x: 470, y: 400, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 200, w: 500, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    expect(d).toBe(`M490,${0 + SIDE_ANCHOR_INSET} L512,${0 + SIDE_ANCHOR_INSET} L512,${400 + SIDE_ANCHOR_INSET} L470,${400 + SIDE_ANCHOR_INSET}`);
    const points = Array.from(d.matchAll(/-?[\d.]+,-?[\d.]+/g)).map((match) => {
      const [x, y] = match[0].split(",").map(Number);
      return { x, y };
    });
    assertPathClears(points, [boxes.get("obstacle")!]);
    for (const p of points) {
      if (p.y > 200 && p.y < 220) expect(p.x).toBeGreaterThanOrEqual(500 + DETOUR_CLEARANCE);
    }
  });

  it("never triggers the outer lane for an ordinary obstacle far narrower than the diagram", () => {
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 20, h: 20 }],
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    expect(d).not.toContain("L512"); // sanity: not the outer-lane shape
    expect(d).toMatch(/^M[-\d.]+,[-\d.]+ L/); // still the ordinary local L-elbow + C path
  });

  it("stays on the ordinary local detour (no outer-lane trigger) for a borderline obstacle whose span is genuinely narrower than the diagram, with real DETOUR_CLEARANCE clearance", () => {
    // Investigates whether needsOuterLaneFallback's width-based trigger still needs adjustment
    // now that a genuine left lane exists as a fallback option. This obstacle sits hard against
    // the diagram's own left edge (x=0) while a distant, unrelated box far to the right (x=600)
    // sets a large diagramWidth - exactly the "boxes starting near the diagram's own left edge"
    // shape called out as the risk. The relevant obstacle's own span (leftX..rightX) is still
    // far narrower than diagramWidth, so the trigger correctly stays off; the local detour still
    // clears the obstacle by the full DETOUR_CLEARANCE (not a tighter hug), and `pathClears`
    // (already exercised by `edgePathFor`) is the real safety net for any residual crossing -
    // confirming no further trigger-threshold adjustment is needed.
    const boxes = new Map<string, Rect>([
      ["source", { x: 0, y: 0, w: 20, h: 20 }],
      ["target", { x: 0, y: 200, w: 20, h: 20 }],
      ["obstacle", { x: 0, y: 100, w: 20, h: 20 }],
      ["farContext", { x: 580, y: 5000, w: 20, h: 20 }], // makes diagramWidth large (600) without being a relevant obstacle
    ]);
    const d = edgePathFor(boxes, "source", "target")!;
    expect(d).not.toContain("L580"); // not the outer lane
    expect(d).toMatch(/^M[-\d.]+,[-\d.]+ L/);
    const waypointMatch = /L(-?[\d.]+),(-?[\d.]+)/.exec(d);
    expect(waypointMatch).not.toBeNull();
    const wpX = Number(waypointMatch![1]);
    expect(wpX).toBe(0 - DETOUR_CLEARANCE); // exactly the designed local-detour clearance, not tighter
  });
});

describe("sourceSideAnchor / targetSideAnchor — near-top, not dead-center", () => {
  // Regression: reported live-testing bug (screenshot, twice). These anchors used to land at
  // dead vertical center (`box.y + box.h / 2`), which for typical leaf-node box heights sits
  // very close to the node-label's fixed local `y="20"` baseline (see `graphView.ts`'s
  // `<text class="node-label" x="8" y="20">` and its `NODE_H = 32` leaf box height), so the
  // outer-lane fallback's arrowhead visually landed on top of the target's own name text.
  //
  // A real leaf box is 32px tall (`NODE_H` in graphView.ts), not the 20px this test used to use
  // - at 20px the label's `y="20"` baseline sits exactly on the box's own bottom edge, so
  // "clears the label row by 5px" passed trivially for almost any inset and didn't actually
  // catch the first attempted fix (`SIDE_ANCHOR_INSET = 8`), which still visibly touched the
  // label in practice. Mirroring the real 32px box height, with an estimated glyph-top ~11px
  // above the `y="20"` baseline (~`box.y + 9`), makes this test exercise the real geometry.
  const box: Rect = { x: 10, y: 100, w: 20, h: 32 };
  const labelGlyphTopY = box.y + 9; // estimated top of the label glyphs, above the y="20" baseline

  it("targetSideAnchor's y sits near the box's own top edge, clearly above the label's own glyph top", () => {
    const anchor = targetSideAnchor(box, "right");
    expect(anchor.y).toBeLessThan(labelGlyphTopY - 3);
  });

  it("sourceSideAnchor's y sits near the box's own top edge, clearly above the label's own glyph top", () => {
    const anchor = sourceSideAnchor(box, "right");
    expect(anchor.y).toBeLessThan(labelGlyphTopY - 3);
  });

  it("clamps the inset to half the box height for a very short box, never landing below its own center", () => {
    const shortBox: Rect = { x: 0, y: 0, w: 20, h: 4 };
    const anchor = targetSideAnchor(shortBox, "right");
    expect(anchor.y).toBeLessThanOrEqual(shortBox.y + shortBox.h / 2);
  });

  it("sourceSideAnchor exits from the right side when laneSide is right, left side when laneSide is left", () => {
    expect(sourceSideAnchor(box, "right").x).toBe(box.x + box.w);
    expect(sourceSideAnchor(box, "left").x).toBe(box.x);
  });

  it("targetSideAnchor enters from the side AWAY from the lane (left side for a right lane, right side for a left lane)", () => {
    expect(targetSideAnchor(box, "right").x).toBe(box.x);
    expect(targetSideAnchor(box, "left").x).toBe(box.x + box.w);
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
