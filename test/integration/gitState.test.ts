import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginWorktreeCapture, captureGitState, finishWorktreeCapture, GitCaptureInstabilityError } from "../../src/git/gitService.js";

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
});
