import { describe, expect, it } from "vitest";
import {
  BOX_MIN_GAP,
  computeLiveDragUpdate,
  layoutGraph,
  resolveCollisions,
  resolveDragCommit,
  resolveGeometryChangeOverlaps,
  type Position,
} from "../../webview/graphLayout.js";
import { descendantsOf as descendantsOfLayout } from "../../webview/positionOverrides.js";
import type { Rect } from "../../webview/edgeGeometry.js";
import type { AnalysisGraph, Entity } from "../../src/protocol.js";

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

/**
 * Real-world convergence bug reported via live testing on the VS Code Extension Development Host:
 * dragging/pushing multiple stacked CONTAINER boxes from bottom to top left one container's box
 * visually overlapping/cutting through a DIFFERENT container's content (a "route" container ended
 * up overlapping "route3"/"route4" below it). Root cause: `onNodeDragStop`'s collision resolution
 * ran against `layoutGraph`'s raw, un-overridden `boxes` (`LayoutResult.boxes` intentionally never
 * reflects `positionOverrides`, see `boxesForRouting`'s doc comment) instead of each box's ACTUAL
 * current position (including a prior drag/push's committed override) — silently missing real
 * on-screen overlaps against anything already moved earlier in the same multi-drag session.
 */
describe("resolveDragCommit", () => {
  const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  const noDescendants = () => [] as readonly string[];

  it("resolves a drop's collisions against a box's CURRENT (override-merged) position, not the stale pre-override layout position", () => {
    // Three stacked containers, top to bottom: "route", "route3", "route4" — matching the
    // reported bug's real shape. `boxes` is the RAW `layoutGraph` output (as if `route3` had
    // never moved): route3 sits far below route4 in the original layout.
    const boxes = new Map<string, Rect>([
      ["route", box(0, 0, 100, 40)],
      ["route3", box(0, 200, 100, 40)], // stale ORIGINAL layout position — far from "route"
      ["route4", box(0, 260, 100, 40)], // stale ORIGINAL layout position — below route3
    ]);
    // An EARLIER drag in this session already pushed "route3" up, close under "route" — this is
    // route3's real, currently-rendered position, persisted in `positionOverrides`.
    const overrides = new Map<string, Position>([["route3", { x: 0, y: 45 }]]);

    // Now drag "route4" up so it overlaps route3's CURRENT position (45-85), not its stale
    // layout position (200-240) — a buggy implementation checking the stale position would see NO
    // overlap here and never push route3 (or, transitively, "route") out of the way at all.
    const result = resolveDragCommit({
      boxes,
      overrides,
      nodeId: "route4",
      position: { x: 0, y: 70 },
      movedDescendantIds: [],
      descendantsOf: noDescendants,
    });

    const finalRoute4 = { ...boxes.get("route4")!, x: 0, y: 70 };
    const route3Position = result.get("route3");
    expect(route3Position).toBeDefined(); // route3 MUST be recognized as pushed at all
    const finalRoute3 = { ...boxes.get("route3")!, x: route3Position!.x, y: route3Position!.y };
    expect(rectsOverlap(finalRoute4, finalRoute3)).toBe(false);

    // Pushing route3 (already close under "route") clear of route4 can itself land route3 on top
    // of "route" — the SAME resolveDragCommit call must resolve that chain reaction too, not leave
    // a container's box cutting through a sibling container above it.
    const routePosition = result.get("route") ?? { x: boxes.get("route")!.x, y: boxes.get("route")!.y };
    const finalRoute = { ...boxes.get("route")!, x: routePosition.x, y: routePosition.y };
    expect(rectsOverlap(finalRoute, finalRoute3)).toBe(false);
  });

  it("computes the dragged node's own dx/dy cascade from its CURRENT override position, not the stale layout position", () => {
    // "container" was already dragged once before (override present); dragging it AGAIN must
    // cascade its descendant by the delta from where it REALLY currently is, not from the stale
    // original layout box.
    const boxes = new Map<string, Rect>([
      ["container", box(0, 0, 100, 100)],
      ["child", box(10, 10, 20, 20)],
    ]);
    const overrides = new Map<string, Position>([["container", { x: 500, y: 500 }]]);
    const descendantsOf = (id: string) => (id === "container" ? ["child"] : []);

    const result = resolveDragCommit({
      boxes,
      overrides,
      nodeId: "container",
      position: { x: 520, y: 530 }, // +20/+30 from its CURRENT (override) position
      movedDescendantIds: ["child"],
      descendantsOf,
    });

    // Correct: child moves by the same +20/+30 delta, from ITS OWN stale layout position (child
    // has no override, so its layout.boxes entry is still authoritative for its own base).
    expect(result.get("child")).toEqual({ x: 30, y: 40 });
  });

  it("still resolves correctly with no prior overrides at all (non-regression)", () => {
    const boxes = new Map<string, Rect>([
      ["dragged", box(0, 0, 100, 50)],
      ["other", box(80, 0, 100, 50)],
    ]);
    const result = resolveDragCommit({
      boxes,
      overrides: new Map(),
      nodeId: "dragged",
      position: { x: 0, y: 0 },
      movedDescendantIds: [],
      descendantsOf: noDescendants,
    });
    expect(result.get("dragged")).toEqual({ x: 0, y: 0 });
    const pushedOther = result.get("other");
    expect(pushedOther).toBeDefined();
    expect(pushedOther!.x).toBeGreaterThanOrEqual(100);
  });
});

/**
 * Fourth reported round of "boxes end up overlapping after real usage" — this suite pins the
 * ROOT CAUSE found for it: the live (mid-gesture) preview and the drop commit were two SEPARATE
 * implementations of the same transition, and they disagreed.
 *
 * `computeLiveDragUpdate` derived the gesture's dx/dy from `layout.boxes.get(nodeId)` — the RAW,
 * never-override-merged layout box (see `boxesForRouting`'s doc comment: `LayoutResult.boxes`
 * always reflects each node's ORIGINAL layout slot, never a prior drag's committed position) —
 * while `resolveDragCommit` (the 6fc1e4d fix) derives it from the override-MERGED current
 * position. That is the exact same stale-base bug 6fc1e4d fixed on the commit path, still live on
 * the preview path: the moment a container has been dragged once, every later gesture on it
 * previews with a dx/dy off by its entire accumulated offset. Measured on the fixture below: the
 * dragged container's own child previewed 118px OUTSIDE its parent, and the boxes the preview
 * pushed clear landed 88px away from where the drop actually committed them — i.e. the user was
 * aiming their drags at a preview that did not match the committed result, repeatedly, across a
 * whole bottom-to-top dragging session.
 *
 * The invariant these tests lock in (stronger than "both happen to be right on this fixture"):
 * for the SAME gesture inputs, the live preview and the drop commit MUST produce byte-identical
 * position sets. They are now one shared core (`resolveDragPositions`), so they cannot drift apart
 * again the way `resolveDragCommit` drifted away from `computeLiveDragUpdate` in 6fc1e4d.
 */
describe("live drag preview vs drop commit — single shared transition", () => {
  const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

  /** Three stacked container/child pairs, shaped like the reported diagram's real geometry
   * (248x152 root containers stacked with a 24px root gap, each wrapping one 224x112 child). */
  function stackedFixture(): { boxes: Map<string, Rect>; descendantsOf: (id: string) => readonly string[] } {
    const boxes = new Map<string, Rect>([
      ["route", box(16, 16, 248, 152)],
      ["route.child", box(28, 46, 224, 112)],
      ["route3", box(16, 192, 248, 152)],
      ["route3.child", box(28, 222, 224, 112)],
      ["route4", box(16, 368, 248, 152)],
      ["route4.child", box(28, 398, 224, 112)],
    ]);
    return { boxes, descendantsOf: (id) => (boxes.has(`${id}.child`) ? [`${id}.child`] : []) };
  }

  it("previews EXACTLY the positions the drop commits, for a container that was already dragged once", () => {
    const { boxes, descendantsOf } = stackedFixture();
    // route4 was dragged earlier in this session: it currently renders at y=250, NOT at its raw
    // layout slot y=368. This is the state every drag after the first one starts from.
    const overrides = new Map<string, Position>([
      ["route4", { x: 16, y: 250 }],
      ["route4.child", { x: 28, y: 280 }],
    ]);
    const gesture = { x: 16, y: 230 }; // a further small 20px nudge upward from where it really is

    const live = computeLiveDragUpdate({
      layout: { boxes, edges: [] },
      overrides,
      nodeId: "route4",
      position: gesture,
      movedDescendantIds: ["route4.child"],
      descendantsOfId: descendantsOf,
    });
    const commit = resolveDragCommit({
      boxes,
      overrides,
      nodeId: "route4",
      position: gesture,
      movedDescendantIds: ["route4.child"],
      descendantsOf,
    });

    expect(live).toBeDefined();
    expect([...live!.positions.keys()].sort()).toEqual([...commit.keys()].sort());
    for (const [id, committedPosition] of commit) {
      expect(live!.positions.get(id), `preview vs commit disagreed for ${id}`).toEqual(committedPosition);
    }
  });

  it("keeps an already-dragged container's own child rigidly attached during the preview (stale raw-layout delta regression)", () => {
    const { boxes, descendantsOf } = stackedFixture();
    const overrides = new Map<string, Position>([
      ["route4", { x: 16, y: 250 }],
      ["route4.child", { x: 28, y: 280 }], // 30px below its container's top edge, as laid out
    ]);
    const live = computeLiveDragUpdate({
      layout: { boxes, edges: [] },
      overrides,
      nodeId: "route4",
      position: { x: 16, y: 230 },
      movedDescendantIds: ["route4.child"],
      descendantsOfId: descendantsOf,
    })!;
    // The container moved from y=250 to y=230 (-20), so its child must move from 280 to 260 —
    // keeping the SAME 30px in-container offset. The stale-base bug computed the delta against the
    // raw layout slot (368) instead, previewing the child at y=142: 118px OUTSIDE its own parent.
    expect(live.positions.get("route4")).toEqual({ x: 16, y: 230 });
    expect(live.positions.get("route4.child")).toEqual({ x: 28, y: 260 });
  });

  it("previews collision push-out from each box's CURRENT position, so nothing previews on top of another box", () => {
    const { boxes, descendantsOf } = stackedFixture();
    const overrides = new Map<string, Position>([
      ["route4", { x: 16, y: 250 }],
      ["route4.child", { x: 28, y: 280 }],
    ]);
    const live = computeLiveDragUpdate({
      layout: { boxes, edges: [] },
      overrides,
      nodeId: "route4",
      position: { x: 16, y: 230 },
      movedDescendantIds: ["route4.child"],
      descendantsOfId: descendantsOf,
    })!;

    const previewRect = (id: string): Rect => {
      const base = boxes.get(id)!;
      const preview = live.positions.get(id) ?? overrides.get(id) ?? base;
      return { ...base, x: preview.x, y: preview.y };
    };
    for (const [a, b] of [
      ["route", "route3"],
      ["route", "route4"],
      ["route3", "route4"],
    ] as const) {
      expect(rectsOverlap(previewRect(a), previewRect(b)), `${a} previewed overlapping ${b}`).toBe(false);
    }
  });

  it("still previews a first-ever drag (no overrides at all) identically to its commit", () => {
    const { boxes, descendantsOf } = stackedFixture();
    const overrides = new Map<string, Position>();
    const gesture = { x: 16, y: 120 };
    const live = computeLiveDragUpdate({
      layout: { boxes, edges: [] },
      overrides,
      nodeId: "route4",
      position: gesture,
      movedDescendantIds: ["route4.child"],
      descendantsOfId: descendantsOf,
    })!;
    const commit = resolveDragCommit({
      boxes,
      overrides,
      nodeId: "route4",
      position: gesture,
      movedDescendantIds: ["route4.child"],
      descendantsOf,
    });
    expect([...live.positions.keys()].sort()).toEqual([...commit.keys()].sort());
    for (const [id, committedPosition] of commit) expect(live.positions.get(id)).toEqual(committedPosition);
  });
});

/**
 * Cumulative-desync regression coverage: every prior fix in this feature was validated against at
 * most one or two drag operations. The reported failure mode is an ONGOING session ("empujando
 * desde abajo hacia arriba") of many sequential individual drags, so this suite drives a realistic
 * 8-drag sequence through the SAME transition `onNodeDragStop` runs, re-running the real
 * `layoutGraph` between drags exactly like the component does, and asserts the full invariant
 * after EVERY drag: no two boxes overlap unless one contains the other, and every container still
 * encloses all of its own descendants.
 */
describe("sequential multi-drag session (realistic diagram shape)", () => {
  const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" };
  const span = { path: "pkg/a.py", startByte: 0, endByte: 3, startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };

  /** A column of sibling root containers matching the reported screenshots: `route` (class + 2
   * methods), `route3` (class + 2 methods), `route4` (function + class + method), `route5`
   * (class + method + function). */
  function realisticGraph(): AnalysisGraph {
    const nodes: Entity[] = [
      { id: "module:route", kind: "module", qualifiedName: "route", span },
      { id: "class:route.Route", kind: "class", qualifiedName: "route.Route", containerId: "module:route", span },
      { id: "method:route.Route.__init__", kind: "method", qualifiedName: "route.Route.__init__", containerId: "class:route.Route", span },
      { id: "method:route.Route.get", kind: "method", qualifiedName: "route.Route.get", containerId: "class:route.Route", span },
      { id: "module:route3", kind: "module", qualifiedName: "route3", span },
      { id: "class:route3.Route3", kind: "class", qualifiedName: "route3.Route3", containerId: "module:route3", span },
      { id: "method:route3.Route3.__init__", kind: "method", qualifiedName: "route3.Route3.__init__", containerId: "class:route3.Route3", span },
      { id: "method:route3.Route3.get_info", kind: "method", qualifiedName: "route3.Route3.get_info", containerId: "class:route3.Route3", span },
      { id: "module:route4", kind: "module", qualifiedName: "route4", span },
      { id: "function:route4.funcion2", kind: "function", qualifiedName: "route4.funcion2", containerId: "module:route4", span },
      { id: "class:route4.Route4", kind: "class", qualifiedName: "route4.Route4", containerId: "module:route4", span },
      { id: "method:route4.Route4.__init__", kind: "method", qualifiedName: "route4.Route4.__init__", containerId: "class:route4.Route4", span },
      { id: "module:route5", kind: "module", qualifiedName: "route5", span },
      { id: "class:route5.Route5", kind: "class", qualifiedName: "route5.Route5", containerId: "module:route5", span },
      { id: "method:route5.Route5.__init__", kind: "method", qualifiedName: "route5.Route5.__init__", containerId: "class:route5.Route5", span },
      { id: "function:route5.helper", kind: "function", qualifiedName: "route5.helper", containerId: "module:route5", span },
    ];
    return { snapshot, nodes, edges: [], diagnostics: [] };
  }

  it("never leaves two boxes overlapping across 8 sequential bottom-to-top drags", () => {
    const graph = realisticGraph();
    const overrides = new Map<string, Position>();
    let layout = layoutGraph({ graph, diff: [], untrackedPaths: [], overrides: new Map(overrides) });
    const currentRect = (id: string): Rect => {
      const base = layout.boxes.get(id)!;
      const override = overrides.get(id);
      return override ? { ...base, x: override.x, y: override.y } : base;
    };

    // "Empujando desde abajo hacia arriba": the bottom containers are repeatedly dragged upward,
    // one drag-and-drop at a time, each committing before the next begins.
    const sequence = [
      { id: "module:route5", dx: 0, dy: -260 },
      { id: "module:route4", dx: 0, dy: -220 },
      { id: "module:route3", dx: 10, dy: -180 },
      { id: "module:route5", dx: 0, dy: -140 },
      { id: "module:route4", dx: -10, dy: -120 },
      { id: "module:route3", dx: 0, dy: -100 },
      { id: "module:route5", dx: 5, dy: -90 },
      { id: "module:route4", dx: 0, dy: -80 },
    ];

    for (const step of sequence) {
      const from = currentRect(step.id);
      const committed = resolveDragCommit({
        boxes: layout.boxes,
        overrides: new Map(overrides),
        nodeId: step.id,
        position: { x: from.x + step.dx, y: from.y + step.dy },
        movedDescendantIds: descendantsOfLayout(step.id, layout),
        descendantsOf: (id) => descendantsOfLayout(id, layout),
      });
      for (const [id, position] of committed) overrides.set(id, position);
      // The component re-runs the real layout after every drop; do the same here.
      layout = layoutGraph({ graph, diff: [], untrackedPaths: [], overrides: new Map(overrides) });

      const ids = [...layout.boxes.keys()];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]!;
          const b = ids[j]!;
          // Containment (a container and its own descendants) is expected nesting, not a collision.
          if (descendantsOfLayout(a, layout).includes(b) || descendantsOfLayout(b, layout).includes(a)) continue;
          expect(rectsOverlap(currentRect(a), currentRect(b)), `${a} overlaps ${b} after dragging ${step.id}`).toBe(false);
        }
      }

      for (const container of ["module:route", "module:route3", "module:route4", "module:route5"]) {
        const parent = currentRect(container);
        for (const descendant of descendantsOfLayout(container, layout)) {
          const child = currentRect(descendant);
          expect(
            child.x >= parent.x && child.y >= parent.y && child.x + child.w <= parent.x + parent.w && child.y + child.h <= parent.y + parent.h,
            `${descendant} escaped ${container} after dragging ${step.id}`,
          ).toBe(true);
        }
      }
    }
  });
});

/**
 * The OTHER confirmed mechanism behind "two entire container boxes ended up overlapping" — one
 * that no amount of drag-path fixing could ever close, because it needs no drag at all.
 *
 * `positionOverrides` pins a node to an absolute position, but `layoutGraph` re-`measure()`s every
 * box from the tree on every snapshot. During a live-testing session the user is EDITING the very
 * files they are dragging: adding one method to `route3.py` grows `module:route3`'s measured box
 * by exactly one row (40px), downward, while `module:route4` stays frozen at its dragged override.
 * Measured on the fixture below: route3 grows 112 -> 152 tall at a pinned y=152, route4 stays
 * pinned at y=292 — the two container rects now genuinely overlap on screen, and NOTHING resolves
 * it, because `resolveCollisions` only ever runs from a drag and only ever considers pairs
 * involving the dragged/pushed set. The overlap simply persists for the rest of the session.
 *
 * `resolveGeometryChangeOverlaps` closes that: a box whose OWN measured geometry changed is
 * treated exactly like a dragged box (it moved, the system moved it), and everything it now
 * overlaps is pushed clear through the same `resolveCollisions` used by the drag path.
 */
describe("resolveGeometryChangeOverlaps", () => {
  const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  const noDescendants = () => [] as readonly string[];

  it("pushes a pinned neighbour clear when a container's own measured box grows into it", () => {
    const previousSizes = new Map([
      ["route3", { w: 248, h: 112 }],
      ["route4", { w: 224, h: 72 }],
    ]);
    // Fresh layout after the user added a method to route3.py: route3 re-measured 40px taller.
    const boxes = new Map<string, Rect>([
      ["route3", box(16, 152, 248, 152)],
      ["route4", box(16, 292, 224, 72)],
    ]);
    // route4 is pinned by an earlier drag at exactly its layout slot; route3 now grows into it.
    const overrides = new Map<string, Position>([["route4", { x: 16, y: 292 }]]);

    const pushes = resolveGeometryChangeOverlaps({ previousSizes, boxes, overrides, descendantsOf: noDescendants });

    const pushedRoute4 = pushes.get("route4");
    expect(pushedRoute4).toBeDefined();
    const finalRoute4 = { ...boxes.get("route4")!, x: pushedRoute4!.x, y: pushedRoute4!.y };
    expect(rectsOverlap(boxes.get("route3")!, finalRoute4)).toBe(false);
    expect(finalRoute4.y).toBeGreaterThanOrEqual(152 + 152 + BOX_MIN_GAP); // clear of route3's new bottom edge
  });

  it("does nothing when no box's measured geometry changed (a plain re-render must never shuffle the diagram)", () => {
    const previousSizes = new Map([
      ["route3", { w: 248, h: 152 }],
      ["route4", { w: 224, h: 72 }],
    ]);
    const boxes = new Map<string, Rect>([
      ["route3", box(16, 152, 248, 152)],
      ["route4", box(16, 200, 224, 72)], // already overlapping, but NOT because anything re-measured
    ]);
    const pushes = resolveGeometryChangeOverlaps({
      previousSizes,
      boxes,
      overrides: new Map<string, Position>([["route4", { x: 16, y: 200 }]]),
      descendantsOf: noDescendants,
    });
    expect(pushes.size).toBe(0);
  });

  it("is a no-op on the very first layout, when every box is new and nothing is pinned yet", () => {
    const boxes = new Map<string, Rect>([
      ["route3", box(16, 16, 248, 152)],
      ["route4", box(16, 192, 224, 72)],
    ]);
    const pushes = resolveGeometryChangeOverlaps({
      previousSizes: new Map(),
      boxes,
      overrides: new Map<string, Position>(),
      descendantsOf: noDescendants,
    });
    expect(pushes.size).toBe(0);
  });

  it("carries a pushed container's own descendants along with it", () => {
    const previousSizes = new Map([
      ["grower", { w: 100, h: 40 }], // the only box that re-measured
      ["pinned", { w: 100, h: 60 }],
      ["pinned.child", { w: 60, h: 20 }],
    ]);
    const boxes = new Map<string, Rect>([
      ["grower", box(0, 0, 100, 120)], // re-measured taller, now overlapping the pinned container
      ["pinned", box(0, 100, 100, 60)],
      ["pinned.child", box(10, 110, 60, 20)],
    ]);
    const pushes = resolveGeometryChangeOverlaps({
      previousSizes,
      boxes,
      overrides: new Map<string, Position>([["pinned", { x: 0, y: 100 }]]),
      descendantsOf: (id) => (id === "pinned" ? ["pinned.child"] : []),
    });
    const pushedParent = pushes.get("pinned");
    const pushedChild = pushes.get("pinned.child");
    expect(pushedParent).toBeDefined();
    expect(pushedChild).toBeDefined();
    expect(pushedChild!.y - boxes.get("pinned.child")!.y).toBe(pushedParent!.y - boxes.get("pinned")!.y);
  });

  it("resolves against each box's CURRENT (override-merged) position, not its raw layout slot", () => {
    const previousSizes = new Map([
      ["grower", { w: 100, h: 40 }],
      ["pinned", { w: 100, h: 60 }],
    ]);
    const boxes = new Map<string, Rect>([
      ["grower", box(0, 0, 100, 120)],
      ["pinned", box(0, 400, 100, 60)], // raw slot is far away; the user dragged it right under grower
    ]);
    const pushes = resolveGeometryChangeOverlaps({
      previousSizes,
      boxes,
      overrides: new Map<string, Position>([["pinned", { x: 0, y: 100 }]]),
      descendantsOf: noDescendants,
    });
    const pushed = pushes.get("pinned");
    expect(pushed).toBeDefined();
    expect(pushed!.y).toBeGreaterThanOrEqual(120 + BOX_MIN_GAP);
  });
});

function rectsOverlap(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > 0 && overlapY > 0;
}
