import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("accepts worktree paths containing ':' and '\\', as legitimate on Windows absolute paths", async () => {
    const colonDir = resolve(repoRoot, "weird:name");
    await mkdir(colonDir);
    const canonicalColon = await validateWorktreeMembership(repoRoot, colonDir);
    expect(canonicalColon).toBe(await realpath(colonDir));

    const backslashDir = resolve(repoRoot, "back\\slash");
    await mkdir(backslashDir);
    const canonicalBackslash = await validateWorktreeMembership(repoRoot, backslashDir);
    expect(canonicalBackslash).toBe(await realpath(backslashDir));
  });

  it("accepts a valid worktree path inside the repository", async () => {
    const canonical = await validateWorktreeMembership(repoRoot, repoRoot);
    expect(canonical).toBe(await realpath(repoRoot));
  });

  it("accepts a valid commit reference", async () => {
    const oid = await resolveCommitOid(repoRoot, "HEAD");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects an unresolvable ref with GitSelectionError instead of a raw Error", async () => {
    await expect(resolveCommitOid(repoRoot, "definitely-not-a-real-ref")).rejects.toThrow(GitSelectionError);
  });

  it("accepts a valid commit reference in a sha256-object-format repository", async () => {
    let supportsSha256 = true;
    const sha256Root = await mkdtemp(resolve(tmpdir(), "agent-change-map-sha256-"));
    try {
      execFileSync("git", ["init", "-q", "--object-format=sha256"], { cwd: sha256Root });
    } catch {
      supportsSha256 = false;
    }
    if (!supportsSha256) {
      await rm(sha256Root, { recursive: true, force: true });
      console.warn("Skipping sha256 object-format test: installed git does not support --object-format=sha256");
      return;
    }
    try {
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sha256Root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: sha256Root });
      await writeFile(resolve(sha256Root, "a.py"), "x = 1\n");
      execFileSync("git", ["add", "."], { cwd: sha256Root });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: sha256Root });

      const oid = await resolveCommitOid(sha256Root, "HEAD");
      expect(oid).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(sha256Root, { recursive: true, force: true });
    }
  });
});
