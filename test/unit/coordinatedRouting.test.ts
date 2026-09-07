import { describe, expect, it } from "vitest";
import { edgePathsFor, targetSideAnchor, segmentIntersectsRect, type Rect, type Point } from "../../webview/edgeGeometry.js";

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
      expect(path).not.toMatch(/[CQ]/);
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
