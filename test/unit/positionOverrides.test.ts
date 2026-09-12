import { expect, it } from "vitest";
import type { AcmNode } from "../../webview/graphLayout.js";
import { MAX_POSITION_OVERRIDES, PositionOverrides, descendantsOf, hydratePositionOverrides } from "../../webview/positionOverrides.js";

// Case 10: set/get round-trip; set on an existing id refreshes recency.
it("round-trips a set absolute position through get, and refreshes recency on re-set", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { x: 1, y: 2 });
  expect(overrides.get("a")).toEqual({ x: 1, y: 2 });
  overrides.set("a", { x: 3, y: 4 });
  expect(overrides.get("a")).toEqual({ x: 3, y: 4 });
  expect(overrides.size).toBe(1);
});

// Case 11: exceeding MAX_POSITION_OVERRIDES evicts the least-recently-set id; size stays capped.
it("evicts the least-recently-set id once MAX_POSITION_OVERRIDES is exceeded", () => {
  const overrides = new PositionOverrides();
  for (let i = 0; i < MAX_POSITION_OVERRIDES; i += 1) overrides.set(`id-${i}`, { x: i, y: i });
  expect(overrides.size).toBe(MAX_POSITION_OVERRIDES);
  expect(overrides.get("id-0")).toEqual({ x: 0, y: 0 });

  overrides.set("id-new", { x: 999, y: 999 });

  expect(overrides.size).toBe(MAX_POSITION_OVERRIDES);
  expect(overrides.get("id-0")).toBeUndefined();
  expect(overrides.get("id-1")).toEqual({ x: 1, y: 1 });
  expect(overrides.get("id-new")).toEqual({ x: 999, y: 999 });
});

it("re-setting an existing id refreshes its recency, protecting it from the next eviction", () => {
  const overrides = new PositionOverrides();
  for (let i = 0; i < MAX_POSITION_OVERRIDES; i += 1) overrides.set(`id-${i}`, { x: i, y: i });
  overrides.set("id-0", { x: 100, y: 100 }); // touch id-0, so id-1 becomes the LRU victim

  overrides.set("id-new", { x: 999, y: 999 });

  expect(overrides.get("id-0")).toEqual({ x: 100, y: 100 });
  expect(overrides.get("id-1")).toBeUndefined();
});

// Case 12: pruneTo drops ids absent from the present set, keeps present ones, never throws.
it("pruneTo drops ids absent from the present set and keeps present ones, without throwing", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { x: 1, y: 1 });
  overrides.set("b", { x: 2, y: 2 });
  overrides.set("c", { x: 3, y: 3 });

  expect(() => overrides.pruneTo(["a", "c", "does-not-exist"])).not.toThrow();

  expect(overrides.get("a")).toEqual({ x: 1, y: 1 });
  expect(overrides.get("c")).toEqual({ x: 3, y: 3 });
  expect(overrides.get("b")).toBeUndefined();
  expect(overrides.size).toBe(2);
});

it("pruneTo against an empty present set drops every override without throwing", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { x: 1, y: 1 });
  expect(() => overrides.pruneTo([])).not.toThrow();
  expect(overrides.size).toBe(0);
});

// Case 13: entries() feeds layoutGraph's `overrides: ReadonlyMap<string, Position>` input.
it("entries() yields every retained [id, position] pair", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { x: 1, y: 2 });
  overrides.set("b", { x: 3, y: 4 });
  expect(new Map(overrides.entries())).toEqual(
    new Map([
      ["a", { x: 1, y: 2 }],
      ["b", { x: 3, y: 4 }],
    ]),
  );
});

it("entries() on an empty store yields nothing", () => {
  const overrides = new PositionOverrides();
  expect([...overrides.entries()]).toEqual([]);
});

// Case 14: hydratePositionOverrides discards legacy {dx,dy} entries wholesale (D6) — never
// reinterpreted as absolute coordinates.
it("hydratePositionOverrides discards a legacy delta-shaped store, returning an empty store", () => {
  const hydrated = hydratePositionOverrides({ a: { dx: 1, dy: 2 } });
  expect(hydrated.size).toBe(0);
});

it("hydratePositionOverrides accepts a well-formed absolute-position map", () => {
  const hydrated = hydratePositionOverrides({ a: { x: 5, y: 6 }, b: { x: -1, y: 0 } });
  expect(hydrated.size).toBe(2);
  expect(hydrated.get("a")).toEqual({ x: 5, y: 6 });
  expect(hydrated.get("b")).toEqual({ x: -1, y: 0 });
});

it("hydratePositionOverrides rejects non-finite x/y values wholesale", () => {
  expect(hydratePositionOverrides({ a: { x: NaN, y: 1 } }).size).toBe(0);
  expect(hydratePositionOverrides({ a: { x: Infinity, y: 1 } }).size).toBe(0);
  expect(hydratePositionOverrides({ a: { x: 1, y: -Infinity } }).size).toBe(0);
});

it("hydratePositionOverrides rejects non-object / non-map input entirely", () => {
  expect(hydratePositionOverrides(null).size).toBe(0);
  expect(hydratePositionOverrides(undefined).size).toBe(0);
  expect(hydratePositionOverrides("not-a-map").size).toBe(0);
  expect(hydratePositionOverrides(42).size).toBe(0);
  expect(hydratePositionOverrides([]).size).toBe(0);
});

it("hydratePositionOverrides drops individually malformed entries but keeps well-formed siblings", () => {
  const hydrated = hydratePositionOverrides({ a: { x: 1, y: 2 }, b: { dx: 1, dy: 2 }, c: "nonsense", d: { x: 7, y: 8 } });
  expect(hydrated.size).toBe(2);
  expect(hydrated.get("a")).toEqual({ x: 1, y: 2 });
  expect(hydrated.get("d")).toEqual({ x: 7, y: 8 });
  expect(hydrated.get("b")).toBeUndefined();
});

// --- descendantsOf (D14 — container drag cascade) -------------------------------------------

function nodeStub(id: string, parentId: string | undefined): Pick<AcmNode, "id" | "data"> {
  return { id, data: { parentId } as AcmNode["data"] };
}

it("descendantsOf walks data.parentId chains at any depth, deepest-first order not required", () => {
  const nodes = [
    nodeStub("root", undefined),
    nodeStub("container", "root"),
    nodeStub("child-1", "container"),
    nodeStub("child-2", "container"),
    nodeStub("grandchild", "child-1"),
    nodeStub("unrelated", undefined),
  ];
  const result = descendantsOf("container", { nodes: nodes as AcmNode[] });
  expect(new Set(result)).toEqual(new Set(["child-1", "child-2", "grandchild"]));
  expect(result).not.toContain("unrelated");
  expect(result).not.toContain("container");
  expect(result).not.toContain("root");
});

it("descendantsOf is a no-op (empty) for a leaf node", () => {
  const nodes = [nodeStub("root", undefined), nodeStub("leaf", "root")];
  const result = descendantsOf("leaf", { nodes: nodes as AcmNode[] });
  expect(result).toEqual([]);
});

it("descendantsOf returns an empty array for an id absent from layoutResult.nodes", () => {
  const nodes = [nodeStub("root", undefined)];
  expect(descendantsOf("does-not-exist", { nodes: nodes as AcmNode[] })).toEqual([]);
});

// Cascade persistence (D14 scenario): dragging a container persists an absolute override for
// every descendant, individually — not as a group/anchor — so a later independent re-drag of one
// sibling never disturbs the others.
it("cascade: every descendant of a dragged container gets its own persisted absolute override, surviving a later sibling re-drag", () => {
  const nodes = [
    nodeStub("root", undefined),
    nodeStub("container", "root"),
    nodeStub("child-1", "container"),
    nodeStub("child-2", "container"),
    nodeStub("grandchild", "child-1"),
  ];
  const layoutResult = { nodes: nodes as AcmNode[] };
  const boxes = new Map([
    ["container", { x: 0, y: 0 }],
    ["child-1", { x: 10, y: 10 }],
    ["child-2", { x: 60, y: 10 }],
    ["grandchild", { x: 20, y: 30 }],
  ]);

  const overrides = new PositionOverrides();
  const dx = 100;
  const dy = 50;
  overrides.set("container", { x: 0 + dx, y: 0 + dy });
  for (const descendantId of descendantsOf("container", layoutResult)) {
    const box = boxes.get(descendantId)!;
    overrides.set(descendantId, { x: box.x + dx, y: box.y + dy });
  }

  expect(overrides.get("container")).toEqual({ x: 100, y: 50 });
  expect(overrides.get("child-1")).toEqual({ x: 110, y: 60 });
  expect(overrides.get("child-2")).toEqual({ x: 160, y: 60 });
  expect(overrides.get("grandchild")).toEqual({ x: 120, y: 80 });

  // A later, independent re-drag of one sibling only overwrites its own entry.
  overrides.set("child-2", { x: 500, y: 500 });
  expect(overrides.get("child-2")).toEqual({ x: 500, y: 500 });
  expect(overrides.get("child-1")).toEqual({ x: 110, y: 60 });
  expect(overrides.get("grandchild")).toEqual({ x: 120, y: 80 });
});
