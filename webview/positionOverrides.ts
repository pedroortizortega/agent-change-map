/**
 * Pure, DOM-free store of per-node drag offsets. Mirrors `SnapshotStore`'s bounded-map
 * precedent (`src/snapshots/snapshotStore.ts`): delete-then-set for LRU touch, evict
 * `keys().next().value` when over the cap.
 */

/** LRU cap: mirrors `SnapshotStore`'s bounded-map precedent (see design.md Decision 4). At
 * 200, well above `NESTED_LAYOUT_LIMITS.nodes` (60), a live override can never be evicted. */
export const MAX_POSITION_OVERRIDES = 200;

export interface Offset {
  dx: number;
  dy: number;
}

export class PositionOverrides {
  private readonly offsets = new Map<string, Offset>();

  /** Test/inspection surface: the current number of retained overrides. */
  get size(): number {
    return this.offsets.size;
  }

  get(id: string): Offset | undefined {
    return this.offsets.get(id);
  }

  set(id: string, offset: Offset): void {
    // Delete-then-re-set moves the key to the most-recently-set (last) position, whether it
    // already existed (recency refresh) or is new.
    this.offsets.delete(id);
    this.offsets.set(id, offset);
    while (this.offsets.size > MAX_POSITION_OVERRIDES) {
      const leastRecentlySet = this.offsets.keys().next().value!;
      this.offsets.delete(leastRecentlySet);
    }
  }

  /** Silently drops any retained id absent from `presentIds`; never throws. */
  pruneTo(presentIds: Iterable<string>): void {
    const present = new Set(presentIds);
    for (const id of this.offsets.keys()) {
      if (!present.has(id)) this.offsets.delete(id);
    }
  }
}
