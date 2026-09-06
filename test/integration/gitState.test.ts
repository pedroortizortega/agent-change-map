import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginWorktreeCapture,
  captureGitState,
  finishWorktreeCapture,
  GitBinaryContentError,
  GitCaptureInstabilityError,
  GitCaptureLimitError,
} from "../../src/git/gitService.js";
import { DTO_LIMITS } from "../../src/protocol.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-state-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("git state capture", () => {
  it("captures an exact commit state with byte and status equality", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "def a():\n    return 'á'\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();

    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });

    expect(state.snapshot.kind).toBe("commit");
    expect(state.snapshot.resolvedOid).toBe(oid);
    expect(state.files).toEqual([{ path: "a.py", content: "def a():\n    return 'á'\n" }]);
  });

  it("captures a staged and dirty worktree distinctly from HEAD", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    await writeFile(resolve(repoRoot, "a.py"), "x = 2\n");
    await writeFile(resolve(repoRoot, "b.py"), "y = 3\n");
    execFileSync("git", ["add", "b.py"], { cwd: repoRoot });

    const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

    expect(state.snapshot.kind).toBe("worktree");
    expect(state.snapshot.resolvedOid).toBeUndefined();
    expect([...state.files].sort((left, right) => (left.path < right.path ? -1 : 1))).toEqual([
      { path: "a.py", content: "x = 2\n" },
      { path: "b.py", content: "y = 3\n" },
    ]);
  });

  it("captures an empty index without error", async () => {
    const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });
    expect(state.files).toEqual([]);
  });

  it("leaves staged and unstaged local content unchanged after capture", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    await writeFile(resolve(repoRoot, "a.py"), "x = 2\n");
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString();

    await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

    const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString();
    expect(statusAfter).toBe(statusBefore);
  });

  it("refuses a worktree capture that changes while it is being captured", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const begin = await beginWorktreeCapture(repoRoot, repoRoot);
    await writeFile(resolve(repoRoot, "a.py"), "x = 2\n");

    await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
  });

  it("refuses a capture when an already-dirty file is re-edited mid-capture without changing its porcelain status", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    // Already dirty *before* begin: porcelain status is " M a.py" at begin time.
    await writeFile(resolve(repoRoot, "a.py"), "x = 2\n");

    const begin = await beginWorktreeCapture(repoRoot, repoRoot);
    // Re-edited during the capture window: porcelain status is still " M a.py",
    // identical to the status recorded at begin time, so a status-only fingerprint
    // cannot see this change even though the captured content would be torn.
    await writeFile(resolve(repoRoot, "a.py"), "x = 3\n");

    await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
  });

  it("refuses a capture when a clean checkout to a different commit happens mid-capture", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: repoRoot });
    await writeFile(resolve(repoRoot, "a.py"), "x = 2\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repoRoot });

    const begin = await beginWorktreeCapture(repoRoot, repoRoot);
    // Clean checkout to a different commit: `git status --porcelain` is empty both
    // before and after (the tree is clean in both states), so a status-only
    // fingerprint cannot see that captured content would now come from a different
    // commit than the one represented by the tracked-paths list taken at begin time.
    execFileSync("git", ["checkout", "-q", "HEAD~1"], { cwd: repoRoot });

    await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
  });

  it("rejects a commit capture exceeding the tracked-file count limit", async () => {
    for (let index = 0; index <= DTO_LIMITS.maxFiles; index += 1) {
      await writeFile(resolve(repoRoot, `f${index}.py`), "x = 1\n");
    }
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "many files"], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "commit", ref: "HEAD" })).rejects.toThrow(GitCaptureLimitError);
  });

  it("rejects a worktree capture exceeding the per-file content size limit", async () => {
    const oversized = "a".repeat(DTO_LIMITS.maxFileContentBytes + 1);
    await writeFile(resolve(repoRoot, "big.py"), oversized);
    execFileSync("git", ["add", "."], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitCaptureLimitError);
  });

  it("captures small commit and worktree states unaffected by the new limits", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const commitState = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    expect(commitState.files).toEqual([{ path: "a.py", content: "x = 1\n" }]);

    const worktreeState = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });
    expect(worktreeState.files).toEqual([{ path: "a.py", content: "x = 1\n" }]);
  });

  it("rejects a commit capture containing a non-UTF-8 tracked file with GitBinaryContentError", async () => {
    // A lone invalid UTF-8 continuation byte (0xff is never valid in any UTF-8 sequence).
    await writeFile(resolve(repoRoot, "binary.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x02]));
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "binary"], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "commit", ref: "HEAD" })).rejects.toThrow(GitBinaryContentError);
  });

  it("rejects a worktree capture containing a non-UTF-8 tracked file with GitBinaryContentError", async () => {
    await writeFile(resolve(repoRoot, "binary.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x02]));
    execFileSync("git", ["add", "."], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitBinaryContentError);
  });

  it("still succeeds for accented UTF-8 content alongside the new binary detection", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "def a():\n    return 'á'\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    expect(state.files).toEqual([{ path: "a.py", content: "def a():\n    return 'á'\n" }]);
  });
});
