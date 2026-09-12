import { describe, expect, it } from "vitest";
import { edgePathsFor, targetSideAnchor, segmentIntersectsRect, ROUTE_CLEARANCE, type Rect, type Point } from "../../webview/edgeGeometry.js";

const points = (path: string): Point[] => Array.from(path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g), m => ({ x: Number(m[1]), y: Number(m[2]) }));
const boxes = new Map<string, Rect>([
  ["a", { x: 28, y: 46, w: 200, h: 32 }],
  ["b", { x: 28, y: 86, w: 200, h: 32 }],
  ["c", { x: 28, y: 222, w: 200, h: 32 }],
  ["d", { x: 40, y: 348, w: 200, h: 32 }],
  ["e", { x: 40, y: 388, w: 200, h: 32 }],
]);
const edges = [
  { source: "e", target: "a" }, { source: "d", target: "a" },
  { source: "e", target: "c" }, { source: "d", target: "c" },
];

describe("coordinated orthogonal routing", () => {
  it("enters the destination at its near-lane side, never through its interior", () => {
    expect(targetSideAnchor(boxes.get("a")!, "right").x).toBe(228);
    expect(targetSideAnchor(boxes.get("a")!, "left").x).toBe(28);
  });

  it("uses only orthogonal segments and clears every box, including both endpoints", () => {
    const paths = edgePathsFor(boxes, edges);
    expect(paths).toHaveLength(edges.length);
    for (const path of paths) {
      expect(path).toBeDefined();
      // Corner-rounding (visual redesign, post-PR4) legitimately introduces `Q` commands at
      // interior turns; the router never emits a Bezier tail (`C`) for a coordinated route,
      // only `edgePathFor`'s single-edge fallback does, so that half of the old assertion
      // still holds unchanged.
      expect(path).not.toMatch(/C/);
      const route = points(path!);
      for (let i = 1; i < route.length; i++) {
        expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true);
        for (const box of boxes.values()) {
          const interior = { x: box.x + 0.01, y: box.y + 0.01, w: box.w - 0.02, h: box.h - 0.02 };
          expect(segmentIntersectsRect(route[i - 1], route[i], interior)).toBe(false);
        }
      }
    }
  });

  it("avoids crossings in a planar fan-in/fan-out fixture instead of sharing outer lanes", () => {
    const routes = edgePathsFor(boxes, edges).map(path => points(path!));
    for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
      for (let a = 1; a < routes[i].length; a++) for (let b = 1; b < routes[j].length; b++) {
        const p = routes[i][a - 1]; const q = routes[i][a];
        const r = routes[j][b - 1]; const t = routes[j][b];
        if ((p.x === q.x) === (r.x === t.x)) continue;
        const [v1, v2, h1, h2] = p.x === q.x ? [p, q, r, t] : [r, t, p, q];
        const crosses = v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x)
          && h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
        expect(crosses).toBe(false);
      }
    }
  });

  it("allocates different ports and separates otherwise identical relationships", () => {
    const duplicate = [edges[0], edges[0], edges[0]];
    const paths = edgePathsFor(boxes, duplicate).map(path => points(path!));
    expect(new Set(paths.map(path => JSON.stringify(path[0]))).size).toBe(3);
    expect(new Set(paths.map(path => JSON.stringify(path.at(-1)))).size).toBe(3);
    const verticalLanes = paths.map(path => path.slice(1).filter((p, i) => p.x === path[i].x && Math.abs(p.y - path[i].y) > 50).map(p => p.x));
    expect(new Set(verticalLanes.flat()).size).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic and preserves unresolved stubs and missing-source behavior", () => {
    expect(edgePathsFor(boxes, edges)).toEqual(edgePathsFor(boxes, edges));
    expect(edgePathsFor(boxes, [{ source: "missing", target: "a" }, { source: "a" }])).toEqual([undefined, "M128,78 L128,106"]);
  });

  it("does not let unresolved stubs consume the resolved relationship's port slots", () => {
    const resolved = edgePathsFor(boxes, [edges[0]])[0];
    const mixed = edgePathsFor(boxes, [{ source: "e" }, { source: "e", target: "missing" }, edges[0]]);
    expect(mixed[2]).toBe(resolved);
  });

  it("routes a self-call as a visible loop outside its own box", () => {
    const box = boxes.get("a")!;
    const route = points(edgePathsFor(new Map([["a", box]]), [{ source: "a", target: "a" }])[0]!);
    expect(route.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < route.length; i++) {
      expect(segmentIntersectsRect(route[i - 1], route[i], { x: box.x + 0.01, y: box.y + 0.01, w: box.w - 0.02, h: box.h - 0.02 })).toBe(false);
    }
  });

  it("also keeps side-by-side boxes clear when coordinates change", () => {
    const horizontal = new Map<string, Rect>([
      ["left", { x: 0, y: 0, w: 100, h: 32 }],
      ["obstacle", { x: 140, y: -20, w: 100, h: 80 }],
      ["right", { x: 280, y: 0, w: 100, h: 32 }],
    ]);
    const route = points(edgePathsFor(horizontal, [{ source: "left", target: "right" }])[0]!);
    for (const box of horizontal.values()) for (let i = 1; i < route.length; i++) {
      expect(segmentIntersectsRect(route[i - 1], route[i], { x: box.x + 0.01, y: box.y + 0.01, w: box.w - 0.02, h: box.h - 0.02 })).toBe(false);
    }
  });

  it("keeps a real clearance margin outside every unrelated box, on this repo's own real analyzer output", () => {
    // Regression: reported live-testing bug (screenshot) - routed lines grazed/touched the
    // dashed border of sibling module boxes they had nothing to do with. The prior obstacle
    // check shrank each obstacle inward by a fraction of a pixel (see the 0.01 margin the
    // other cases in this file use), so a route could pass literally along an unrelated box's
    // boundary - "not intersecting" by that near-zero threshold, but visually touching it.
    //
    // A small isolated fixture (just the two boxes involved) did NOT reproduce this: which
    // candidate route wins depends on `occupied`, the lanes already claimed by every
    // PRECEDING edge in the same `edgePathsFor` call - so only the full graph reproduces the
    // exact lane congestion that caused the violation. These are the exact boxes and routing
    // edges from this repo's own real analyzer output for its `test/` fixture
    // (app.py/route.py/route2.py/route3.py/route4.py/config.py), captured via the real
    // `captureCommitState`/`captureWorktreeState`/`mergeGraphsForDisplay` pipeline - not a
    // hand-picked minimal case.
    const boxes: [string, Rect][] = [
      ["module:route", { x: 16, y: 16, w: 224, h: 152 }],
      ["function:route.ruta1@0", { x: 28, y: 46, w: 200, h: 32 }],
      ["function:route.ruta2@105", { x: 28, y: 86, w: 200, h: 32 }],
      ["function:route.ruta3@210", { x: 28, y: 126, w: 200, h: 32 }],
      ["module:route2", { x: 16, y: 192, w: 224, h: 72 }],
      ["function:route2.funcion2@0", { x: 28, y: 222, w: 200, h: 32 }],
      ["module:route3", { x: 16, y: 288, w: 248, h: 152 }],
      ["class:route3.Route3@37", { x: 28, y: 318, w: 224, h: 112 }],
      ["method:route3.Route3.__init__@55", { x: 40, y: 348, w: 200, h: 32 }],
      ["method:route3.Route3.get_info@183", { x: 40, y: 388, w: 200, h: 32 }],
      ["module:route4", { x: 16, y: 464, w: 248, h: 152 }],
      ["class:route4.Route4@25", { x: 28, y: 494, w: 224, h: 112 }],
      ["method:route4.Route4.__init__@43", { x: 40, y: 524, w: 200, h: 32 }],
      ["method:route4.Route4.get_info@172", { x: 40, y: 564, w: 200, h: 32 }],
      ["module:app", { x: 16, y: 640, w: 248, h: 152 }],
      ["class:app.Main@115", { x: 28, y: 670, w: 224, h: 112 }],
      ["method:app.Main.__init__@131", { x: 40, y: 700, w: 200, h: 32 }],
      ["method:app.Main.run@254", { x: 40, y: 740, w: 200, h: 32 }],
      ["module:config", { x: 16, y: 816, w: 200, h: 32 }],
    ];
    const realEdges: { source: string; target?: string }[] = [
      { source: "module:app", target: "function:route.ruta1@0" }, { source: "module:app" },
      { source: "module:app", target: "function:route.ruta1@0" }, { source: "module:app", target: "function:route2.funcion2@0" },
      { source: "module:app", target: "class:route3.Route3@37" }, { source: "module:app", target: "class:route4.Route4@25" },
      { source: "module:app" }, { source: "module:route3" }, { source: "module:route4" },
      { source: "method:app.Main.__init__@131" },
      { source: "method:app.Main.run@254", target: "class:route4.Route4@25" },
      { source: "method:app.Main.run@254" }, { source: "method:app.Main.run@254" }, { source: "method:app.Main.run@254" },
      { source: "method:app.Main.run@254" }, { source: "method:app.Main.run@254" },
      { source: "method:app.Main.run@254", target: "function:route.ruta1@0" },
      { source: "method:app.Main.run@254" },
      { source: "method:app.Main.run@254", target: "function:route2.funcion2@0" },
      { source: "method:app.Main.run@254" },
      { source: "method:app.Main.run@254", target: "class:route3.Route3@37" },
      { source: "method:app.Main.run@254" }, { source: "method:app.Main.run@254" },
      { source: "module:app" }, { source: "module:app" },
      { source: "module:app", target: "class:app.Main@115" }, { source: "module:app" },
    ];
    const boxMap = new Map(boxes);
    const containerOf = new Map<string, string | undefined>([
      ["function:route.ruta1@0", "module:route"], ["function:route.ruta2@105", "module:route"], ["function:route.ruta3@210", "module:route"],
      ["function:route2.funcion2@0", "module:route2"],
      ["class:route3.Route3@37", "module:route3"], ["method:route3.Route3.__init__@55", "class:route3.Route3@37"], ["method:route3.Route3.get_info@183", "class:route3.Route3@37"],
      ["class:route4.Route4@25", "module:route4"], ["method:route4.Route4.__init__@43", "class:route4.Route4@25"], ["method:route4.Route4.get_info@172", "class:route4.Route4@25"],
      ["class:app.Main@115", "module:app"], ["method:app.Main.__init__@131", "class:app.Main@115"], ["method:app.Main.run@254", "class:app.Main@115"],
    ]);
    const isAncestorOrDescendant = (a: string, b: string): boolean => {
      for (let cur: string | undefined = a; cur; cur = containerOf.get(cur)) if (cur === b) return true;
      for (let cur: string | undefined = b; cur; cur = containerOf.get(cur)) if (cur === a) return true;
      return false;
    };
    const routes = edgePathsFor(boxMap, realEdges);
    for (let i = 0; i < realEdges.length; i++) {
      const path = routes[i];
      const { source, target } = realEdges[i];
      // A missing target renders the unrouted dashed stub, by established design - it never
      // clears obstacles, resolved or otherwise (see edgePathFor's own doc comment).
      if (!path || !target) continue;
      const route = points(path);
      for (const [boxId, box] of boxMap) {
        if (boxId === source || boxId === target) continue;
        if (isAncestorOrDescendant(source, boxId) || (target && isAncestorOrDescendant(target, boxId))) continue;
        const inflated = { x: box.x - ROUTE_CLEARANCE, y: box.y - ROUTE_CLEARANCE, w: box.w + 2 * ROUTE_CLEARANCE, h: box.h + 2 * ROUTE_CLEARANCE };
        for (let j = 1; j < route.length; j++) {
          expect(
            segmentIntersectsRect(route[j - 1], route[j], inflated),
            `edge ${source}->${target ?? "(stub)"} segment ${j} enters the ${ROUTE_CLEARANCE}px clearance margin around unrelated box '${boxId}'`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps a container-to-child connection above its descendants", () => {
    const nested = new Map<string, Rect>([
      ["app", { x: 16, y: 288, w: 248, h: 152 }],
      ["main", { x: 28, y: 318, w: 224, h: 112 }],
      ["init", { x: 40, y: 348, w: 200, h: 32 }],
    ]);
    const route = points(edgePathsFor(nested, [{ source: "app", target: "main" }])[0]!);
    expect(Math.max(...route.map(p => p.y))).toBeLessThan(348);
  });
});

describe("ancestor transit clearance", () => {
  it("keeps long vertical routes outside ancestor borders with a full lane margin", () => {
    const nested = new Map<string, Rect>([
      ["route", { x: 16, y: 16, w: 224, h: 152 }],
      ["a", { x: 28, y: 46, w: 200, h: 32 }],
      ["b", { x: 28, y: 86, w: 200, h: 32 }],
      ["c", { x: 28, y: 126, w: 200, h: 32 }],
      ["route2", { x: 16, y: 192, w: 224, h: 72 }],
      ["f", { x: 28, y: 222, w: 200, h: 32 }],
      ["app", { x: 16, y: 288, w: 248, h: 152 }],
      ["main", { x: 28, y: 318, w: 224, h: 112 }],
      ["init", { x: 40, y: 348, w: 200, h: 32 }],
      ["run", { x: 40, y: 388, w: 200, h: 32 }],
    ]);
    const routes = edgePathsFor(nested, [
      { source: "app", target: "a" }, { source: "app", target: "a" },
      { source: "app", target: "f" }, { source: "run", target: "a" },
      { source: "run", target: "f" }, { source: "app", target: "main" },
    ]);
    for (const path of routes) {
      const p = points(path!);
      for (let i = 1; i < p.length; i++) {
        if (p[i].y === p[i - 1].y) {
          for (const id of ["route", "route2", "app", "main"]) {
            const box = nested.get(id)!;
            const overlap = Math.min(Math.max(p[i].x, p[i - 1].x), box.x + box.w) - Math.max(Math.min(p[i].x, p[i - 1].x), box.x);
            if (overlap <= 32) continue;
            expect(Math.min(Math.abs(p[i].y - box.y), Math.abs(p[i].y - box.y - box.h)),
              `Horizontal lane hugs ${id}'s boundary`).toBeGreaterThanOrEqual(12);
          }
        }
        if (p[i].x !== p[i - 1].x || Math.abs(p[i].y - p[i - 1].y) <= 32) continue;
        for (const id of ["route", "route2", "app", "main"]) {
          const box = nested.get(id)!;
          const overlap = Math.min(Math.max(p[i].y, p[i - 1].y), box.y + box.h) - Math.max(Math.min(p[i].y, p[i - 1].y), box.y);
          if (overlap <= 32) continue;
          expect(p[i].x <= box.x - 12 || p[i].x >= box.x + box.w + 12,
            `Long lane x=${p[i].x} rides inside/on ${id}'s border`).toBe(true);
        }
      }
    }
  });
});

describe("label and header clearance", () => {
  it("keeps ancestor header bands protected even when endpoint ancestors are traversable", () => {
    const nested = new Map<string, Rect>([
      ["route2", { x: 16, y: 192, w: 224, h: 72 }],
      ["function", { x: 28, y: 222, w: 200, h: 32 }],
      ["app", { x: 16, y: 288, w: 248, h: 152 }],
      ["main", { x: 28, y: 318, w: 224, h: 112 }],
      ["run", { x: 40, y: 388, w: 200, h: 32 }],
    ]);
    for (const pair of [{ source: "app", target: "main" }, { source: "app", target: "function" }, { source: "run", target: "function" }]) {
      const route = points(edgePathsFor(nested, [pair])[0]!);
      for (const [id, box] of nested) {
        const label = { x: box.x + 4, y: box.y + 6, w: box.w - 8, h: 18 };
        for (let i = 1; i < route.length; i++) {
          expect(segmentIntersectsRect(route[i - 1], route[i], label), `Connector ${pair.source}->${pair.target} crosses ${id}'s label row`).toBe(false);
        }
      }
    }
  });
});
