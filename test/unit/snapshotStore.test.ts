import { describe, expect, it } from "vitest";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import type { SnapshotId } from "../../src/protocol.js";

function snapshotFor(n: number): SnapshotId {
  return { repoId: "repo", kind: "worktree", contentDigest: `sha256:${n}` };
}

describe("SnapshotStore LRU", () => {
  it("evicts the least-recently-used entry once size exceeds MAX_SNAPSHOTS (8)", () => {
    const store = new SnapshotStore();
    for (let i = 0; i < 8; i++) {
      store.store({ snapshot: snapshotFor(i), files: [] });
    }
    expect(store.size).toBe(8);
    store.store({ snapshot: snapshotFor(8), files: [] });
    expect(store.size).toBe(8);
    expect(store.get(snapshotFor(0))).toBeUndefined();
    expect(store.get(snapshotFor(8))).toBeDefined();
  });

  it("get() refreshes recency so the displayed pair is never evicted", () => {
    const store = new SnapshotStore();
    for (let i = 0; i < 8; i++) {
      store.store({ snapshot: snapshotFor(i), files: [] });
    }
    // Touch snapshot 0 so it becomes most-recently-used.
    store.get(snapshotFor(0));
    store.store({ snapshot: snapshotFor(8), files: [] });
    // snapshot 1 was the actual least-recently-used after touching 0, not 0 itself.
    expect(store.get(snapshotFor(0))).toBeDefined();
    expect(store.get(snapshotFor(1))).toBeUndefined();
  });

  it("re-storing identical content (same snapshotKey) adds no new entry", () => {
    const store = new SnapshotStore();
    store.store({ snapshot: snapshotFor(0), files: [] });
    store.store({ snapshot: snapshotFor(0), files: [] });
    expect(store.size).toBe(1);
  });
});
