import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSourceFileMatcher } from "../../src/analysis/sourceFileMatcher.js";
import {
  beginWorktreeCapture,
  captureCommitState,
  captureGitState,
  computeContentDigest,
  finishWorktreeCapture,
  GitBinaryContentError,
  GitCaptureInstabilityError,
  GitCaptureLimitError,
  GitSelectionError,
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
    expect(state.files).toEqual([{ path: "a.py", content: "def a():\n    return 'á'\n", provenance: "tracked" }]);
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
      { path: "a.py", content: "x = 2\n", provenance: "tracked" },
      { path: "b.py", content: "y = 3\n", provenance: "tracked" },
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

  // Reviewed per design "Slice A blast radius": all three instability tests below use only
  // a.py in an otherwise clean tmp repo, so switching statusFingerprint to
  // --untracked-files=all adds no noise (mkdtemp fixtures contain no stray/editor-backup
  // files) and they stay green byte-unchanged.
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

  it("captures a worktree ignoring a gitlink (submodule) entry instead of failing with EISDIR", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    const nestedRepo = resolve(repoRoot, "vendor");
    await mkdir(nestedRepo);
    execFileSync("git", ["init", "-q"], { cwd: nestedRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: nestedRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: nestedRepo });
    await writeFile(resolve(nestedRepo, "inner.txt"), "irrelevant\n");
    execFileSync("git", ["add", "."], { cwd: nestedRepo });
    execFileSync("git", ["commit", "-q", "-m", "inner"], { cwd: nestedRepo });
    const innerOid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: nestedRepo }).toString().trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${innerOid},vendor`], { cwd: repoRoot });
    execFileSync("git", ["add", "a.py"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    // `vendor` has no extension, so with untracked capture it is also filtered by the
    // matcher; the gitlink-mode filter must still run first (it is not exposed to
    // `git ls-files --others`, which never reports gitlinks in the first place).
    const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

    expect(state.files).toEqual([{ path: "a.py", content: "x = 1\n", provenance: "tracked" }]);
  });

  it("captures small commit and worktree states unaffected by the new limits", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const commitState = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    expect(commitState.files).toEqual([{ path: "a.py", content: "x = 1\n", provenance: "tracked" }]);

    const worktreeState = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });
    expect(worktreeState.files).toEqual([{ path: "a.py", content: "x = 1\n", provenance: "tracked" }]);
  });

  it("rejects a commit capture containing a non-UTF-8 tracked file with GitBinaryContentError", async () => {
    // A lone invalid UTF-8 continuation byte (0xff is never valid in any UTF-8 sequence).
    // Named binary.py (not binary.dat) so the matcher still routes it to the binary-content
    // guard instead of silently excluding it before it is ever read.
    await writeFile(resolve(repoRoot, "binary.py"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x02]));
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "binary"], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "commit", ref: "HEAD" })).rejects.toThrow(GitBinaryContentError);
  });

  it("rejects a worktree capture containing a non-UTF-8 tracked file with GitBinaryContentError", async () => {
    await writeFile(resolve(repoRoot, "binary.py"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x02]));
    execFileSync("git", ["add", "."], { cwd: repoRoot });

    await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitBinaryContentError);
  });

  it("still succeeds for accented UTF-8 content alongside the new binary detection", async () => {
    await writeFile(resolve(repoRoot, "a.py"), "def a():\n    return 'á'\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    expect(state.files).toEqual([{ path: "a.py", content: "def a():\n    return 'á'\n", provenance: "tracked" }]);
  });

  describe("untracked file capture", () => {
    it("includes a never-staged .py file in worktree capture with provenance untracked", async () => {
      await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
      execFileSync("git", ["add", "."], { cwd: repoRoot });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
      await writeFile(resolve(repoRoot, "b.py"), "y = 2\n");

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect([...state.files].sort((left, right) => (left.path < right.path ? -1 : 1))).toEqual([
        { path: "a.py", content: "x = 1\n", provenance: "tracked" },
        { path: "b.py", content: "y = 2\n", provenance: "untracked" },
      ]);
    });

    it("excludes untracked documentation-like paths that the matcher does not match", async () => {
      await writeFile(resolve(repoRoot, "README.sh"), "echo hi\n");
      await writeFile(resolve(repoRoot, "requirements.txt"), "flask\n");

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect(state.files).toEqual([]);
    });

    it("includes an untracked setup.py because the matcher matches .py regardless of filename", async () => {
      await writeFile(resolve(repoRoot, "setup.py"), "from setuptools import setup\n");

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect(state.files).toEqual([{ path: "setup.py", content: "from setuptools import setup\n", provenance: "untracked" }]);
    });

    it("excludes a .gitignore'd untracked .py file via --exclude-standard", async () => {
      await writeFile(resolve(repoRoot, ".gitignore"), "ignored.py\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-q", "-m", "gitignore"], { cwd: repoRoot });
      await writeFile(resolve(repoRoot, "ignored.py"), "x = 1\n");

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect(state.files).toEqual([]);
    });

    it("captures an empty index plus one untracked .py file with correct provenance", async () => {
      await writeFile(resolve(repoRoot, "only.py"), "x = 1\n");

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect(state.files).toEqual([{ path: "only.py", content: "x = 1\n", provenance: "untracked" }]);
    });

    it("raises GitCaptureInstabilityError when an untracked file is created mid-capture", async () => {
      const begin = await beginWorktreeCapture(repoRoot, repoRoot);
      await writeFile(resolve(repoRoot, "new.py"), "x = 1\n");

      await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
    });

    it("raises GitCaptureInstabilityError when an untracked file is deleted mid-capture", async () => {
      await writeFile(resolve(repoRoot, "gone.py"), "x = 1\n");
      const begin = await beginWorktreeCapture(repoRoot, repoRoot);
      await rm(resolve(repoRoot, "gone.py"));

      await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
    });

    it("raises GitCaptureInstabilityError when an untracked file is edited mid-capture with its status letter unchanged", async () => {
      await writeFile(resolve(repoRoot, "edited.py"), "x = 1\n");
      const begin = await beginWorktreeCapture(repoRoot, repoRoot);
      // An untracked file's porcelain status is always "??", so an edit never changes the
      // status letter; only the content fingerprint can detect this.
      await writeFile(resolve(repoRoot, "edited.py"), "x = 2\n");

      await expect(finishWorktreeCapture(begin)).rejects.toThrow(GitCaptureInstabilityError);
    });

    it("hard-fails an oversized untracked .py file with GitCaptureLimitError", async () => {
      const oversized = "a".repeat(DTO_LIMITS.maxFileContentBytes + 1);
      await writeFile(resolve(repoRoot, "big.py"), oversized);

      await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitCaptureLimitError);
    });

    it("hard-fails a binary untracked .py file with GitBinaryContentError", async () => {
      await writeFile(resolve(repoRoot, "binary.py"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x02]));

      await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitBinaryContentError);
    });

    it("rejects a worktree capture when tracked and untracked counts together cross maxFiles", async () => {
      const trackedCount = Math.ceil(DTO_LIMITS.maxFiles / 2);
      for (let index = 0; index < trackedCount; index += 1) {
        await writeFile(resolve(repoRoot, `t${index}.py`), "x = 1\n");
      }
      execFileSync("git", ["add", "."], { cwd: repoRoot });
      execFileSync("git", ["commit", "-q", "-m", "tracked"], { cwd: repoRoot });
      const untrackedCount = DTO_LIMITS.maxFiles - trackedCount + 1;
      for (let index = 0; index < untrackedCount; index += 1) {
        await writeFile(resolve(repoRoot, `u${index}.py`), "y = 1\n");
      }

      await expect(captureGitState(repoRoot, { kind: "worktree", path: repoRoot })).rejects.toThrow(GitCaptureLimitError);
    });

    it("commit-state capture contains no untracked file and marks every entry tracked", async () => {
      await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
      execFileSync("git", ["add", "."], { cwd: repoRoot });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
      await writeFile(resolve(repoRoot, "untracked.py"), "y = 1\n");

      const state = await captureCommitState(repoRoot, "HEAD");

      expect(state.files).toEqual([{ path: "a.py", content: "x = 1\n", provenance: "tracked" }]);
      expect(state.files.every((file) => file.provenance === "tracked")).toBe(true);
    });

    it("computes a byte-identical content digest regardless of differing provenance", () => {
      const trackedDigest = computeContentDigest([{ path: "a.py", content: "x = 1\n", provenance: "tracked" }]);
      const untrackedDigest = computeContentDigest([{ path: "a.py", content: "x = 1\n", provenance: "untracked" }]);

      expect(trackedDigest).toBe(untrackedDigest);
    });

    it("throws GitSelectionError for a worktree path escaping the repository before any untracked listing runs", async () => {
      const foreignDir = await mkdtemp(resolve(tmpdir(), "agent-change-map-foreign-"));
      try {
        await expect(captureGitState(repoRoot, { kind: "worktree", path: foreignDir })).rejects.toThrow(GitSelectionError);
      } finally {
        await rm(foreignDir, { recursive: true, force: true });
      }
    });

    it("marks a staged brand-new file as tracked, not untracked", async () => {
      await writeFile(resolve(repoRoot, "staged.py"), "x = 1\n");
      execFileSync("git", ["add", "staged.py"], { cwd: repoRoot });

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });

      expect(state.files).toEqual([{ path: "staged.py", content: "x = 1\n", provenance: "tracked" }]);
    });

    it("supports an injected matcher without changing capture pipeline behavior", async () => {
      await writeFile(resolve(repoRoot, "a.sql"), "SELECT 1;\n");
      const matcher = createSourceFileMatcher([".sql"]);

      const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot }, matcher);

      expect(state.files).toEqual([{ path: "a.sql", content: "SELECT 1;\n", provenance: "untracked" }]);
    });
  });
});
