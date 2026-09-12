import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateWorktreeMembership } from "../git/gitService.js";
import { computeContentHash } from "../navigation/sourceProvider.js";

/**
 * Raised for any refused direct write: an invalid or out-of-repository target, a stale
 * race against externally changed content, or a failed atomic write. In every case no
 * partial mutation is observable - the original target file is left byte-for-byte intact.
 */
export class WriteGuardError extends Error {}

/** Raised when the caller-supplied confirmation callback declines a pending write. */
export class WriteConfirmationDeclinedError extends Error {}

export interface WriteEffectPreview {
  /** Canonical (realpath-resolved) target path the write would apply to. */
  path: string;
  previousContent: string;
  nextContent: string;
  /** True when the write would remove or replace existing content rather than create new content. */
  isDestructive: boolean;
}

export interface DirectWriteRequest {
  repoRoot: string;
  targetPath: string;
  /** Content hash (see {@link computeContentHash}) the edit was based on; must match the file's current content or the write is refused as stale. */
  baseHash: string;
  replacement: string;
  /**
   * Presents the exact pending effect and returns (or resolves to) whether the user
   * confirmed it. There is no UI in this phase; callers supply this callback explicitly,
   * and a later phase wires it to VS Code's confirmation dialog.
   */
  confirm: (preview: WriteEffectPreview) => boolean | Promise<boolean>;
}

export interface WriteReceipt {
  path: string;
  previousContent: string;
  newContent: string;
  /**
   * Path to a sibling backup file holding the pre-write content, written before the
   * atomic write is attempted. A sibling file (rather than an in-memory-only backup) stays
   * recoverable even if the extension process exits before the caller persists the
   * receipt elsewhere.
   */
  backupPath: string;
}

/**
 * Applies a guarded, conflict-safe direct write to a worktree file. Validates the target
 * is inside the repository, refuses a stale write when on-disk content no longer matches
 * the edit's recorded base hash, requires explicit confirmation of the exact pending
 * effect, takes a recoverable sibling backup, and writes atomically via a same-directory
 * temp file plus rename so a failure mid-write cannot corrupt or partially replace the
 * target. On any failure the original target file is left untouched.
 */
export async function performGuardedWrite(request: DirectWriteRequest): Promise<WriteReceipt> {
  const { repoRoot, targetPath, baseHash, replacement, confirm } = request;

  let canonicalTarget: string;
  try {
    canonicalTarget = await validateWorktreeMembership(repoRoot, targetPath);
  } catch (error) {
    throw new WriteGuardError(`Write target is invalid: ${targetPath}`, { cause: error });
  }

  let previousBuffer: Buffer;
  try {
    previousBuffer = await readFile(canonicalTarget);
  } catch (error) {
    throw new WriteGuardError(`Write target does not exist: ${targetPath}`, { cause: error });
  }
  const previousContent = previousBuffer.toString("utf8");
  const currentHash = computeContentHash(previousContent);
  if (currentHash !== baseHash) {
    throw new WriteGuardError(`Write target changed since the edit was based on it: ${targetPath}`);
  }

  const isDestructive = previousContent.length > 0 && previousContent !== replacement;
  const preview: WriteEffectPreview = { path: canonicalTarget, previousContent, nextContent: replacement, isDestructive };
  const confirmed = await confirm(preview);
  if (!confirmed) {
    throw new WriteConfirmationDeclinedError(`Write declined for target: ${targetPath}`);
  }

  // Re-verify staleness immediately before the point of no return: confirm can be an
  // arbitrarily slow, real user-facing dialog, and the target may have changed on disk
  // while it was pending. The backup and receipt below must reflect this fresh read, not
  // the buffer captured before confirm was awaited.
  let currentBuffer: Buffer;
  try {
    currentBuffer = await readFile(canonicalTarget);
  } catch (error) {
    throw new WriteGuardError(`Write target does not exist: ${targetPath}`, { cause: error });
  }
  const currentContent = currentBuffer.toString("utf8");
  if (computeContentHash(currentContent) !== baseHash) {
    throw new WriteGuardError(`Write target changed since the edit was based on it: ${targetPath}`);
  }

  const directory = dirname(canonicalTarget);
  const backupPath = `${canonicalTarget}.bak-${randomBytes(8).toString("hex")}`;
  await writeFile(backupPath, currentBuffer);

  const tempPath = join(directory, `.agent-change-map-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, replacement, "utf8");
    await rename(tempPath, canonicalTarget);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new WriteGuardError(`Atomic write failed for target: ${targetPath}`, { cause: error });
  }

  return { path: canonicalTarget, previousContent: currentContent, newContent: replacement, backupPath };
}
