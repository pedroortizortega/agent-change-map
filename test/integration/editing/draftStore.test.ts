import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGitState } from "../../../src/git/gitService.js";
import { createSourceId } from "../../../src/navigation/sourceProvider.js";
import { StaleSourceError } from "../../../src/navigation/sourceProvider.js";
import { SnapshotStore } from "../../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../../src/editing/draftStore.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-draft-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("DraftStore", () => {
  it("saves a draft isolated from repository files without touching the worktree", async () => {
    const content = "def a():\n    return 1\n";
    await writeFile(resolve(repoRoot, "a.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "a.py", content, 0, content.length);

    const drafts = new DraftStore();
    drafts.save(store, sourceId, "def a():\n    return 999\n");

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
    const onDisk = await import("node:fs/promises").then((fs) => fs.readFile(resolve(repoRoot, "a.py"), "utf8"));
    expect(onDisk).toBe(content);
  });

  it("reopens the latest saved draft instead of the original captured content", async () => {
    const content = "def b():\n    return 2\n";
    await writeFile(resolve(repoRoot, "b.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "b.py", content, 0, content.length);

    const drafts = new DraftStore();
    drafts.save(store, sourceId, "def b():\n    return 20\n");
    drafts.save(store, sourceId, "def b():\n    return 200\n");

    const draft = drafts.get(sourceId);
    expect(draft?.content).toBe("def b():\n    return 200\n");
    expect(draft?.baseContent).toBe(content);
  });

  it("isolates drafts per SourceId so unrelated sources never see each other's draft", async () => {
    const contentA = "def a():\n    return 1\n";
    const contentB = "def b():\n    return 2\n";
    await writeFile(resolve(repoRoot, "a.py"), contentA);
    await writeFile(resolve(repoRoot, "b.py"), contentB);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceIdA = createSourceId(state.snapshot, "a.py", contentA, 0, contentA.length);
    const sourceIdB = createSourceId(state.snapshot, "b.py", contentB, 0, contentB.length);

    const drafts = new DraftStore();
    drafts.save(store, sourceIdA, "def a():\n    return 111\n");

    expect(drafts.get(sourceIdA)?.content).toBe("def a():\n    return 111\n");
    expect(drafts.get(sourceIdB)).toBeUndefined();
  });

  it("returns undefined for a source with no saved draft", async () => {
    const content = "x = 1\n";
    await writeFile(resolve(repoRoot, "c.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "c.py", content, 0, content.length);

    const drafts = new DraftStore();
    expect(drafts.get(sourceId)).toBeUndefined();
  });

  it("discards a draft so reopening falls back to no draft present", async () => {
    const content = "x = 1\n";
    await writeFile(resolve(repoRoot, "d.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "d.py", content, 0, content.length);

    const drafts = new DraftStore();
    drafts.save(store, sourceId, "y = 2\n");
    drafts.discard(sourceId);

    expect(drafts.get(sourceId)).toBeUndefined();
  });

  it("refuses to save a draft based on a stale or tampered SourceId", async () => {
    const content = "x = 1\n";
    await writeFile(resolve(repoRoot, "e.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "e.py", content, 0, content.length);
    const tamperedSourceId = { ...sourceId, contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };

    const drafts = new DraftStore();
    expect(() => drafts.save(store, tamperedSourceId, "y = 2\n")).toThrow(StaleSourceError);
    expect(drafts.get(sourceId)).toBeUndefined();
  });
});
