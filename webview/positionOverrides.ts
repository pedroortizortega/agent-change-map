/**
 * Pure, DOM-free store of per-node absolute drag positions. Mirrors `SnapshotStore`'s
 * bounded-map precedent (`src/snapshots/snapshotStore.ts`): delete-then-set for LRU touch,
 * evict `keys().next().value` when over the cap.
 */

import type { AcmNode, LayoutResult } from "./graphLayout.js";

/** LRU cap: mirrors `SnapshotStore`'s bounded-map precedent (see design.md Decision 4). At
 * 200, well above `NESTED_LAYOUT_LIMITS.nodes` (60), a live override can never be evicted. */
export const MAX_POSITION_OVERRIDES = 200;

/** Absolute position (design.md D5) — replaces the legacy `Offset { dx, dy }` delta shape. */
export interface Position {
  x: number;
  y: number;
}

export class PositionOverrides {
  private readonly positions = new Map<string, Position>();

  /** Test/inspection surface: the current number of retained overrides. */
  get size(): number {
    return this.positions.size;
  }

  get(id: string): Position | undefined {
    return this.positions.get(id);
  }

  set(id: string, position: Position): void {
    // Delete-then-re-set moves the key to the most-recently-set (last) position, whether it
    // already existed (recency refresh) or is new.
    this.positions.delete(id);
    this.positions.set(id, position);
    while (this.positions.size > MAX_POSITION_OVERRIDES) {
      const leastRecentlySet = this.positions.keys().next().value!;
      this.positions.delete(leastRecentlySet);
    }
  }

  /** Silently drops any retained id absent from `presentIds`; never throws. */
  pruneTo(presentIds: Iterable<string>): void {
    const present = new Set(presentIds);
    for (const id of this.positions.keys()) {
      if (!present.has(id)) this.positions.delete(id);
    }
  }

  /** Feeds `layoutGraph`'s `overrides: ReadonlyMap<string, Position>` input. */
  entries(): IterableIterator<[string, Position]> {
    return this.positions.entries();
  }
}

function isFinitePosition(value: unknown): value is Position {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isFinite(candidate["x"]) && Number.isFinite(candidate["y"]);
}

/**
 * Defensive rehydration guard (D6). Returns an EMPTY store for anything that is not a map of
 * finite absolute `{x,y}` — in particular for legacy `{dx,dy}` entries, which are dropped
 * wholesale rather than reinterpreted as absolute coordinates. Individually malformed entries
 * within an otherwise well-formed object are dropped on their own; well-formed siblings survive.
 */
export function hydratePositionOverrides(raw: unknown): PositionOverrides {
  const overrides = new PositionOverrides();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return overrides;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isFinitePosition(value)) overrides.set(id, { x: value.x, y: value.y });
  }
  return overrides;
}

/**
 * Walks `data.parentId` chains over `layoutResult.nodes` (D14 — container drag cascade) to
 * collect every node nested under `id`, at any depth. A plain data traversal, no React Flow API
 * involved. Empty (no-op) for a leaf node or an id absent from `layoutResult.nodes`.
 */
export function descendantsOf(id: string, layoutResult: Pick<LayoutResult, "nodes">): string[] {
  const childrenByParent = new Map<string, AcmNode[]>();
  for (const node of layoutResult.nodes) {
    const parentId = node.data.parentId;
    if (parentId === undefined) continue;
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(node);
    else childrenByParent.set(parentId, [node]);
  }

  const result: string[] = [];
  const stack = [...(childrenByParent.get(id) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node.id);
    stack.push(...(childrenByParent.get(node.id) ?? []));
  }
  return result;
}
