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

/** In-memory store of immutable captured Git states, keyed by snapshot identity. */
export class SnapshotStore {
  private readonly snapshots = new Map<string, CapturedState>();

  store(state: CapturedState): SnapshotId {
    this.snapshots.set(snapshotKey(state.snapshot), state);
    return state.snapshot;
  }

  get(id: SnapshotId): CapturedState | undefined {
    return this.snapshots.get(snapshotKey(id));
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
