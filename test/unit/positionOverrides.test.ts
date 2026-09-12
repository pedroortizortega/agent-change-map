import { expect, it } from "vitest";
import { MAX_POSITION_OVERRIDES, PositionOverrides } from "../../webview/positionOverrides.js";

// Case 10: set/get round-trip; set on an existing id refreshes recency.
it("round-trips a set offset through get, and refreshes recency on re-set", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { dx: 1, dy: 2 });
  expect(overrides.get("a")).toEqual({ dx: 1, dy: 2 });
  overrides.set("a", { dx: 3, dy: 4 });
  expect(overrides.get("a")).toEqual({ dx: 3, dy: 4 });
  expect(overrides.size).toBe(1);
});

// Case 11: exceeding MAX_POSITION_OVERRIDES evicts the least-recently-set id; size stays capped.
it("evicts the least-recently-set id once MAX_POSITION_OVERRIDES is exceeded", () => {
  const overrides = new PositionOverrides();
  for (let i = 0; i < MAX_POSITION_OVERRIDES; i += 1) overrides.set(`id-${i}`, { dx: i, dy: i });
  expect(overrides.size).toBe(MAX_POSITION_OVERRIDES);
  expect(overrides.get("id-0")).toEqual({ dx: 0, dy: 0 });

  overrides.set("id-new", { dx: 999, dy: 999 });

  expect(overrides.size).toBe(MAX_POSITION_OVERRIDES);
  expect(overrides.get("id-0")).toBeUndefined();
  expect(overrides.get("id-1")).toEqual({ dx: 1, dy: 1 });
  expect(overrides.get("id-new")).toEqual({ dx: 999, dy: 999 });
});

it("re-setting an existing id refreshes its recency, protecting it from the next eviction", () => {
  const overrides = new PositionOverrides();
  for (let i = 0; i < MAX_POSITION_OVERRIDES; i += 1) overrides.set(`id-${i}`, { dx: i, dy: i });
  overrides.set("id-0", { dx: 100, dy: 100 }); // touch id-0, so id-1 becomes the LRU victim

  overrides.set("id-new", { dx: 999, dy: 999 });

  expect(overrides.get("id-0")).toEqual({ dx: 100, dy: 100 });
  expect(overrides.get("id-1")).toBeUndefined();
});

// Case 12: pruneTo drops ids absent from the present set, keeps present ones, never throws.
it("pruneTo drops ids absent from the present set and keeps present ones, without throwing", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { dx: 1, dy: 1 });
  overrides.set("b", { dx: 2, dy: 2 });
  overrides.set("c", { dx: 3, dy: 3 });

  expect(() => overrides.pruneTo(["a", "c", "does-not-exist"])).not.toThrow();

  expect(overrides.get("a")).toEqual({ dx: 1, dy: 1 });
  expect(overrides.get("c")).toEqual({ dx: 3, dy: 3 });
  expect(overrides.get("b")).toBeUndefined();
  expect(overrides.size).toBe(2);
});

it("pruneTo against an empty present set drops every override without throwing", () => {
  const overrides = new PositionOverrides();
  overrides.set("a", { dx: 1, dy: 1 });
  expect(() => overrides.pruneTo([])).not.toThrow();
  expect(overrides.size).toBe(0);
});
