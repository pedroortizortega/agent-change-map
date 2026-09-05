import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeContentHash } from "../../../src/navigation/sourceProvider.js";
import { performGuardedWrite, WriteConfirmationDeclinedError, WriteGuardError } from "../../../src/editing/writeGuard.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});

let repoRoot: string;
let foreignRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-writeguard-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  foreignRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-writeguard-foreign-"));
});

afterEach(async () => {
  vi.mocked(rename).mockClear();
  await rm(repoRoot, { recursive: true, force: true });
  await rm(foreignRoot, { recursive: true, force: true });
});

describe("performGuardedWrite", () => {
  it("rejects a target outside the repository without touching any file", async () => {
    const outsidePath = resolve(foreignRoot, "outside.py");
    await writeFile(outsidePath, "x = 1\n");
    const confirm = vi.fn(() => true);

    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath: outsidePath,
        baseHash: computeContentHash("x = 1\n"),
        replacement: "x = 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteGuardError);

    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(outsidePath, "utf8")).toBe("x = 1\n");
  });

  it("rejects a target that is not a valid worktree member without mutation", async () => {
    const confirm = vi.fn(() => true);
    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath: resolve(repoRoot, "does-not-exist.py"),
        baseHash: computeContentHash("x = 1\n"),
        replacement: "x = 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteGuardError);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("blocks a stale write when the target changed since the edit's base", async () => {
    const targetPath = resolve(repoRoot, "a.py");
    await writeFile(targetPath, "x = 1\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const staleBaseHash = computeContentHash("x = 0\n");
    const confirm = vi.fn(() => true);

    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath,
        baseHash: staleBaseHash,
        replacement: "x = 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteGuardError);

    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(targetPath, "utf8")).toBe("x = 1\n");
  });

  it("blocks the write and preserves the original file when confirmation is declined", async () => {
    const targetPath = resolve(repoRoot, "b.py");
    const original = "def b():\n    return 1\n";
    await writeFile(targetPath, original);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const confirm = vi.fn(() => false);

    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath,
        baseHash: computeContentHash(original),
        replacement: "def b():\n    return 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteConfirmationDeclinedError);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("presents the exact pending effect for confirmation before any mutation", async () => {
    const targetPath = resolve(repoRoot, "c.py");
    const original = "def c():\n    return 1\n";
    const replacement = "def c():\n    return 2\n";
    await writeFile(targetPath, original);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    let seenPreview: unknown;
    const confirm = vi.fn((preview) => {
      seenPreview = preview;
      return true;
    });

    await performGuardedWrite({ repoRoot, targetPath, baseHash: computeContentHash(original), replacement, confirm });

    expect(seenPreview).toMatchObject({ previousContent: original, nextContent: replacement, isDestructive: true });
  });

  it("takes a recoverable backup and writes atomically via temp file + rename on a confirmed current edit", async () => {
    const targetPath = resolve(repoRoot, "d.py");
    const original = "def d():\n    return 1\n";
    const replacement = "def d():\n    return 2\n";
    await writeFile(targetPath, original);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const receipt = await performGuardedWrite({
      repoRoot,
      targetPath,
      baseHash: computeContentHash(original),
      replacement,
      confirm: () => true,
    });

    expect(await readFile(targetPath, "utf8")).toBe(replacement);
    expect(receipt.previousContent).toBe(original);
    expect(receipt.newContent).toBe(replacement);
    expect(await readFile(receipt.backupPath, "utf8")).toBe(original);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
  });

  it("leaves the original file untouched when the atomic rename fails", async () => {
    const targetPath = resolve(repoRoot, "e.py");
    const original = "def e():\n    return 1\n";
    await writeFile(targetPath, original);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    vi.mocked(rename).mockRejectedValueOnce(new Error("simulated atomic rename failure"));

    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath,
        baseHash: computeContentHash(original),
        replacement: "def e():\n    return 2\n",
        confirm: () => true,
      }),
    ).rejects.toThrow(WriteGuardError);

    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("rejects a write when the target is mutated externally while confirmation is pending", async () => {
    const targetPath = resolve(repoRoot, "f.py");
    const original = "def f():\n    return 1\n";
    const externallyWritten = "def f():\n    return 999\n";
    await writeFile(targetPath, original);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const confirm = vi.fn(async () => {
      await writeFile(targetPath, externallyWritten);
      return true;
    });

    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath,
        baseHash: computeContentHash(original),
        replacement: "def f():\n    return 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteGuardError);

    expect(await readFile(targetPath, "utf8")).toBe(externallyWritten);
  });

  it("rejects a flag-injection-shaped target path without mutation", async () => {
    const confirm = vi.fn(() => true);
    await expect(
      performGuardedWrite({
        repoRoot,
        targetPath: "-Csomewhere",
        baseHash: computeContentHash("x = 1\n"),
        replacement: "x = 2\n",
        confirm,
      }),
    ).rejects.toThrow(WriteGuardError);
    expect(confirm).not.toHaveBeenCalled();
  });
});
