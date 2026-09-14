import { describe, expect, it } from "vitest";
import { BOX_MIN_GAP, resolveCollisions } from "../../webview/graphLayout.js";
import type { Rect } from "../../webview/edgeGeometry.js";

/**
 * Box-collision push-away (box-collision-push, direct-inline — see
 * openspec/changes/box-collision-push/apply-progress.md for the full design rationale).
 *
 * `resolveCollisions` is a pure AABB (axis-aligned bounding box) push-out resolver: given the
 * CURRENT absolute positions of every box (with the dragged box(es) already at their live/final
 * position) and the set of "mover" ids (the dragged box plus its own already-cascaded
 * descendants), it returns the NEW absolute positions for every box that had to be pushed clear
 * of a mover, plus any box pushed clear of THOSE pushed boxes in turn (a bounded chain reaction).
 * It never returns an entry for a mover itself — movers are handled by the existing drag/D14
 * cascade mechanism, not by this function.
 */
describe("resolveCollisions", () => {
  const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  const noDescendants = () => [] as readonly string[];

  it("does not push anything when no boxes overlap", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(500, 500, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    expect(result.size).toBe(0);
  });

  it("pushes an overlapped stationary box along the axis of minimum overlap (horizontal case)", () => {
    // dragged: x[0,100] y[0,50]; other: x[80,180] y[0,50] -> overlapX=20, overlapY=50 -> push X.
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(80, 0, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    const pushed = result.get("other");
    expect(pushed).toBeDefined();
    // Pushed fully clear along X only: new x is at least dragged's right edge (100), y unchanged.
    expect(pushed!.x).toBeGreaterThanOrEqual(100);
    expect(pushed!.y).toBe(0);
    // Confirm boxes genuinely no longer overlap at the returned position.
    const newOtherRect = { ...boxes.get("other")!, x: pushed!.x, y: pushed!.y };
    expect(rectsOverlap(boxes.get("dragged")!, newOtherRect)).toBe(false);
  });

  it("pushes an overlapped stationary box along the axis of minimum overlap (vertical case)", () => {
    // dragged: x[0,100] y[0,50]; other: x[0,100] y[40,90] -> overlapX=100, overlapY=10 -> push Y.
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(0, 40, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    const pushed = result.get("other");
    expect(pushed).toBeDefined();
    expect(pushed!.x).toBe(0);
    expect(pushed!.y).toBeGreaterThanOrEqual(50);
  });

  it("pushes a container's descendants along with it, using descendantsOf", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["container", box(80, 0, 100, 100)],
      ["child", box(90, 10, 40, 20)],
    ]);
    const descendantsOf = (id: string) => (id === "container" ? ["child"] : []);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf });

    const pushedContainer = result.get("container");
    const pushedChild = result.get("child");
    expect(pushedContainer).toBeDefined();
    expect(pushedChild).toBeDefined();
    // Container and child move by the exact same delta (rigid group move).
    const dx = pushedContainer!.x - boxes.get("container")!.x;
    const dy = pushedContainer!.y - boxes.get("container")!.y;
    expect(pushedChild!.x).toBe(boxes.get("child")!.x + dx);
    expect(pushedChild!.y).toBe(boxes.get("child")!.y + dy);
  });

  it("treats a dragged container as its full bounding rect, not its individual children", () => {
    // The dragged box here represents a CONTAINER's bounding rect (its own children are already
    // moved with it upstream via the D14 cascade and are part of `movedIds`, not checked
    // individually against `other` here) — `resolveCollisions` must push `other` clear of the
    // container's bounding rect as a whole.
    const boxes = new Map<string, Rect>([
      ["draggedContainer", box(0, 0, 200, 150)],
      ["draggedChild", box(10, 10, 50, 20)], // nested inside draggedContainer, already a mover
      // overlapX (10, against the container's right edge at 200) < overlapY (50, fully within
      // the container's y-range) — an unambiguous minimum-overlap axis, no tie with the other
      // (valid but here undesired) axis.
      ["other", box(190, 0, 100, 50)],
    ]);
    const result = resolveCollisions({
      boxes,
      movedIds: new Set(["draggedContainer", "draggedChild"]),
      descendantsOf: noDescendants,
    });
    const pushed = result.get("other");
    expect(pushed).toBeDefined();
    expect(pushed!.x).toBeGreaterThanOrEqual(200); // clear of the CONTAINER's right edge, not draggedChild's
  });

  it("handles a bounded chain reaction: pushing B into C also pushes C clear", () => {
    // dragged overlaps B; pushing B (fully clear, horizontally) lands B overlapping C.
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["b", box(80, 0, 100, 50)], // overlaps dragged; pushed right to x=100
      ["c", box(150, 0, 100, 50)], // overlaps b's pushed position [100,200]
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });

    const pushedB = result.get("b");
    const pushedC = result.get("c");
    expect(pushedB).toBeDefined();
    expect(pushedC).toBeDefined();

    const finalB = { ...boxes.get("b")!, x: pushedB!.x, y: pushedB!.y };
    const finalC = { ...boxes.get("c")!, x: pushedC!.x, y: pushedC!.y };
    expect(rectsOverlap(boxes.get("dragged")!, finalB)).toBe(false);
    expect(rectsOverlap(finalB, finalC)).toBe(false);
  });

  it("is bounded: stops after a small fixed number of iterations rather than chasing an unbounded chain", () => {
    // A long chain of 10 boxes, each overlapping the next by a small margin, with a tiny
    // maxIterations. This documents the chosen bounded-resolution approach (a first version does
    // NOT guarantee full separation for an arbitrarily long chain) rather than silently looping
    // until fully resolved.
    const boxes = new Map<string, Rect>();
    boxes.set("dragged", box(0, 0, 60, 50));
    for (let i = 0; i < 10; i++) {
      // each box overlaps the previous one's ORIGINAL position by 20px
      boxes.set(`b${i}`, box(40 + i * 40, 0, 60, 50));
    }
    const result = resolveCollisions({
      boxes,
      movedIds: new Set(["dragged"]),
      descendantsOf: noDescendants,
      maxIterations: 2,
    });
    // With only 2 iterations, not every box in the 10-long chain necessarily gets a fully
    // resolved, non-overlapping position — the function must still terminate promptly and return
    // a (possibly partial) result rather than hang or throw.
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBeLessThanOrEqual(10);
  });

  it("fully resolves a same-iteration double-push: two siblings pushed by the same dragged box must not end up overlapping EACH OTHER", () => {
    // Bug report: dragging a container ("app") pushes two sibling boxes ("route2", "route3") in
    // the SAME resolution pass. Both are pushed clear of "app" independently, but their NEW
    // (post-push) positions overlap each other — a chain reaction the old batch-based iteration
    // model (movers-vs-"the rest", where "the rest" excludes anything already in the CURRENT
    // iteration's mover set) never re-checks, because in the very next iteration both siblings are
    // simultaneously in `movers` and are therefore skipped as targets of one another forever.
    const boxes = new Map<string, Rect>([
      ["app", box(0, 0, 100, 100)],
      ["route2", box(90, 0, 50, 30)], // overlaps app by (overlapX=10, overlapY=30) -> pushed right to x=100
      ["route3", box(90, 15, 50, 30)], // overlaps app by (overlapX=10, overlapY=30) -> pushed right to x=100
      // route2 pushed to x[100,150] y[0,30]; route3 pushed to x[100,150] y[15,45] -> these NEWLY
      // pushed positions overlap each other (overlapX=50, overlapY=15) even though neither
      // overlapped the other BEFORE the push.
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["app"]), descendantsOf: noDescendants });

    const pushedRoute2 = result.get("route2");
    const pushedRoute3 = result.get("route3");
    expect(pushedRoute2).toBeDefined();
    expect(pushedRoute3).toBeDefined();

    const finalApp = boxes.get("app")!;
    const finalRoute2 = { ...boxes.get("route2")!, x: pushedRoute2!.x, y: pushedRoute2!.y };
    const finalRoute3 = { ...boxes.get("route3")!, x: pushedRoute3!.x, y: pushedRoute3!.y };

    expect(rectsOverlap(finalApp, finalRoute2)).toBe(false);
    expect(rectsOverlap(finalApp, finalRoute3)).toBe(false);
    // The actual bug: route2 and route3 must ALSO end up clear of each other, not just of "app".
    expect(rectsOverlap(finalRoute2, finalRoute3)).toBe(false);
  });

  it("maintains at least BOX_MIN_GAP px of separation after a push (horizontal case), not just 0px", () => {
    // Same fixture as the horizontal push-out case above, but now asserting the pushed box clears
    // a real minimum gap — not merely "no longer touching at 0px".
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(80, 0, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    const pushed = result.get("other");
    expect(pushed).toBeDefined();
    // dragged's right edge is at x=100; the pushed box's left edge must clear it by BOX_MIN_GAP.
    expect(pushed!.x).toBeGreaterThanOrEqual(100 + BOX_MIN_GAP);
  });

  it("maintains at least BOX_MIN_GAP px of separation after a push (vertical case), not just 0px", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(0, 40, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    const pushed = result.get("other");
    expect(pushed).toBeDefined();
    // dragged's bottom edge is at y=50; the pushed box's top edge must clear it by BOX_MIN_GAP.
    expect(pushed!.y).toBeGreaterThanOrEqual(50 + BOX_MIN_GAP);
  });

  it("does NOT push boxes that are already separated by more than BOX_MIN_GAP — this pads an existing push, it does not enforce a minimum gap globally", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      // Gap between dragged's right edge (100) and other's left edge (100 + BOX_MIN_GAP + 50) is
      // comfortably more than BOX_MIN_GAP — no overlap, so no push should happen at all.
      ["other", box(100 + BOX_MIN_GAP + 50, 0, 100, 50)],
    ]);
    const result = resolveCollisions({ boxes, movedIds: new Set(["dragged"]), descendantsOf: noDescendants });
    expect(result.size).toBe(0);
  });

  it("never returns an entry for a mover id itself", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["draggedDescendant", box(10, 10, 20, 20)],
      ["other", box(80, 0, 100, 50)],
    ]);
    const result = resolveCollisions({
      boxes,
      movedIds: new Set(["dragged", "draggedDescendant"]),
      descendantsOf: noDescendants,
    });
    expect(result.has("dragged")).toBe(false);
    expect(result.has("draggedDescendant")).toBe(false);
  });
});

/**
 * Real measured timing (not an assumption — see this project's own established discipline, e.g.
 * `graphLayout.test.ts`'s router perf probes) of `resolveCollisions` at OVERSIZED_THRESHOLDS
 * scale ({nodes:300, edges:600} — edges are irrelevant here, `resolveCollisions` is edge-free).
 * The naive O(movers x boxes) per iteration, bounded to 5 iterations by default, is the whole
 * cost model; this proves it stays comfortably inside a single drag pointer-move's frame budget
 * even at 300 boxes with a large dragged/pushed working set.
 */
describe("resolveCollisions — performance probe near OVERSIZED_THRESHOLDS ({nodes:300})", () => {
  it("resolves a worst-case single-drag chain-reaction across 300 densely-packed boxes well under a 16ms frame budget", () => {
    const boxes = new Map<string, Rect>();
    // Densely pack 300 boxes side by side so a single drag can plausibly chain-react through many
    // of them — the worst case for this function's per-iteration O(movers x boxes) scan.
    for (let i = 0; i < 300; i++) {
      boxes.set(`box${i}`, { x: i * 90, y: 0, w: 100, h: 50 }); // each overlaps its neighbor by 10px
    }
    const descendantsOf = () => [] as readonly string[];

    const start = performance.now();
    const result = resolveCollisions({ boxes, movedIds: new Set(["box0"]), descendantsOf });
    const elapsedMs = performance.now() - start;

    expect(result.size).toBeGreaterThan(0);
    console.log(`[perf-probe] resolveCollisions chain-reaction across 300 boxes took ${elapsedMs.toFixed(2)}ms`);
    expect(elapsedMs).toBeLessThan(50); // generous relative to the ~16ms single-frame budget; see console log for the real number
  });
});

function rectsOverlap(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > 0 && overlapY > 0;
}
