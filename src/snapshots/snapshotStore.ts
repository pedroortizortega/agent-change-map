import type { CapturedState } from "../git/gitService.js";
import type { SnapshotId } from "../protocol.js";

export type FileDiffKind = "added" | "removed" | "modified";

export interface FileDiffEntry {
  path: string;
  kind: FileDiffKind;
  leftContent?: string;
  rightContent?: string;
}

export interface SnapshotDiff {
  left: SnapshotId;
  right: SnapshotId;
  entries: FileDiffEntry[];
}

function snapshotKey(id: SnapshotId): string {
  return `${id.repoId}:${id.kind}:${id.resolvedOid ?? ""}:${id.contentDigest}`;
}

/**
 * Sole authority behind `resolveSource`, bounded by an LRU eviction policy (Decision 8):
 * clearing on every refresh would turn every in-flight `SourceId` - including an active
 * run's frozen sources - into a hard failure, while an unbounded store would grow without
 * limit across repeated refreshes. `MAX_SNAPSHOTS = 8` covers four refresh generations x
 * two comparison sides. `Map` iteration order is insertion order, so the first key is
 * always the least-recently-used entry once every `get`/`store` re-inserts its key to mark
 * it most-recently-used.
 */
const MAX_SNAPSHOTS = 8;

/** In-memory store of immutable captured Git states, keyed by snapshot identity. */
export class SnapshotStore {
  private readonly snapshots = new Map<string, CapturedState>();

  /** Test/inspection surface: the current number of retained snapshots. */
  get size(): number {
    return this.snapshots.size;
  }

  store(state: CapturedState): SnapshotId {
    const key = snapshotKey(state.snapshot);
    // Delete-then-re-set moves the key to the most-recently-used (last) position, whether
    // it already existed (a no-op refresh reusing the same contentDigest) or is new.
    this.snapshots.delete(key);
    this.snapshots.set(key, state);
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const leastRecentlyUsed = this.snapshots.keys().next().value!;
      this.snapshots.delete(leastRecentlyUsed);
    }
    return state.snapshot;
  }

  get(id: SnapshotId): CapturedState | undefined {
    const key = snapshotKey(id);
    const state = this.snapshots.get(key);
    if (state === undefined) return undefined;
    // Delete-and-re-set on hit refreshes recency so the currently displayed pair is never
    // the least-recently-used entry evicted by a later `store()`.
    this.snapshots.delete(key);
    this.snapshots.set(key, state);
    return state;
  }

  getFileContent(id: SnapshotId, path: string): string | undefined {
    return this.get(id)?.files.find((file) => file.path === path)?.content;
  }
}

/** Produces additions, removals, and modifications from a left state to a right state. */
export function diffSnapshots(left: CapturedState, right: CapturedState): SnapshotDiff {
  const leftByPath = new Map(left.files.map((file) => [file.path, file.content]));
  const rightByPath = new Map(right.files.map((file) => [file.path, file.content]));
  const paths = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].sort();

  const entries: FileDiffEntry[] = [];
  for (const path of paths) {
    const leftContent = leftByPath.get(path);
    const rightContent = rightByPath.get(path);
    if (leftContent === undefined && rightContent !== undefined) {
      entries.push({ path, kind: "added", rightContent });
    } else if (leftContent !== undefined && rightContent === undefined) {
      entries.push({ path, kind: "removed", leftContent });
    } else if (leftContent !== undefined && rightContent !== undefined && leftContent !== rightContent) {
      entries.push({ path, kind: "modified", leftContent, rightContent });
    }
  }
  return { left: left.snapshot, right: right.snapshot, entries };
}
