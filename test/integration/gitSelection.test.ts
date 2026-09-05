import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitSelectionError, resolveCommitOid, resolveRepoRoot, validateWorktreeMembership } from "../../src/git/gitService.js";

let repoRoot: string;
let foreignRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  await writeFile(resolve(repoRoot, "a.py"), "x = 1\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
  foreignRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-foreign-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(foreignRoot, { recursive: true, force: true });
});

describe("git selection safety", () => {
  it("resolves the canonical repository root without mutation", async () => {
    const resolved = await resolveRepoRoot(repoRoot);
    expect(resolved).toBe(await realpath(repoRoot));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
  });

  it("rejects -C-like flag injection in worktree paths without mutation", async () => {
    await expect(validateWorktreeMembership(repoRoot, "-Csomewhere")).rejects.toThrow(GitSelectionError);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
  });

  it("rejects relative path escapes outside the repository without mutation", async () => {
    await expect(validateWorktreeMembership(repoRoot, "../outside")).rejects.toThrow(GitSelectionError);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
  });

  it("rejects an absolute path outside the repository without mutation", async () => {
    await expect(validateWorktreeMembership(repoRoot, foreignRoot)).rejects.toThrow(GitSelectionError);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
  });

  it("rejects -C-like flag injection in commit references without mutation", async () => {
    await expect(resolveCommitOid(repoRoot, "-Cmalicious")).rejects.toThrow(GitSelectionError);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
  });

  it("accepts a valid worktree path inside the repository", async () => {
    const canonical = await validateWorktreeMembership(repoRoot, repoRoot);
    expect(canonical).toBe(await realpath(repoRoot));
  });

  it("accepts a valid commit reference", async () => {
    const oid = await resolveCommitOid(repoRoot, "HEAD");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
  });
});
