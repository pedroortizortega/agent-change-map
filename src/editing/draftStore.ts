import type { SnapshotId, SourceId } from "../protocol.js";
import { resolveSource } from "../navigation/sourceProvider.js";
import type { SnapshotStore } from "../snapshots/snapshotStore.js";

export interface Draft {
  sourceId: SourceId;
  baseContent: string;
  content: string;
  savedAt: number;
}

function snapshotKey(id: SnapshotId): string {
  return `${id.repoId}:${id.kind}:${id.resolvedOid ?? ""}:${id.contentDigest}`;
}

/**
 * Keys a draft by the SourceId's location (snapshot + path + byte span) rather than its
 * contentHash, so reopening the same edited location keeps returning the latest draft even
 * though the caller's SourceId still reflects the original captured content.
 */
function draftLocationKey(sourceId: SourceId): string {
  return `${snapshotKey(sourceId.snapshot)}:${sourceId.posixPath}:${sourceId.startByte}:${sourceId.endByte}`;
}

/**
 * In-memory overlay of edited content keyed by SourceId location, fully isolated from
 * repository worktrees. Saving or reopening a draft never reads or writes tracked files;
 * only {@link performGuardedWrite} in `writeGuard.ts` can mutate a worktree, and only after
 * explicit direct-mode selection and confirmation.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  /**
   * Verifies the given SourceId still matches the captured snapshot content - refusing a
   * stale or tampered base with the same {@link resolveSource} check used by source
   * navigation - before recording the draft. This stops a drifted SourceId from silently
   * overwriting a draft anchored to different content.
   */
  save(store: SnapshotStore, sourceId: SourceId, content: string): Draft {
    const baseContent = resolveSource(store, sourceId);
    const draft: Draft = { sourceId, baseContent, content, savedAt: Date.now() };
    this.drafts.set(draftLocationKey(sourceId), draft);
    return draft;
  }

  get(sourceId: SourceId): Draft | undefined {
    return this.drafts.get(draftLocationKey(sourceId));
  }

  discard(sourceId: SourceId): void {
    this.drafts.delete(draftLocationKey(sourceId));
  }
}
