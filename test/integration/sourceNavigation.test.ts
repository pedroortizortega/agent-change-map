import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGitState } from "../../src/git/gitService.js";
import type { CapturedState } from "../../src/git/gitService.js";
import { diffSnapshots, SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { correlateDiff, createSourceId, resolveSource, StaleSourceError } from "../../src/navigation/sourceProvider.js";
import type { AnalysisGraph, Entity } from "../../src/protocol.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), "agent-change-map-nav-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function entity(qualifiedName: string, path: string, content: string, needle: string): Entity {
  const startByte = Buffer.from(content, "utf8").indexOf(Buffer.from(needle, "utf8"));
  const endByte = startByte + Buffer.byteLength(needle, "utf8");
  return {
    id: `${path}:${qualifiedName}`,
    kind: "function",
    qualifiedName,
    span: { path, startByte, endByte, startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
  };
}

function graph(snapshot: CapturedState["snapshot"], nodes: Entity[]): AnalysisGraph {
  return { snapshot, nodes, edges: [], diagnostics: [] };
}

describe("source navigation", () => {
  it("resolves an exact span from a captured commit state", async () => {
    const content = "def a():\n    return 1\n";
    await writeFile(resolve(repoRoot, "a.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);

    const sourceId = createSourceId(state.snapshot, "a.py", content, 0, content.indexOf("\n") + 1);
    expect(resolveSource(store, sourceId)).toBe("def a():\n");
  });

  it("resolves an exact span from a captured worktree state", async () => {
    const content = "def b():\n    return 2\n";
    await writeFile(resolve(repoRoot, "b.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "worktree", path: repoRoot });
    const store = new SnapshotStore();
    store.store(state);

    const needle = "return 2";
    const startByte = content.indexOf(needle);
    const sourceId = createSourceId(state.snapshot, "b.py", content, startByte, startByte + needle.length);
    expect(resolveSource(store, sourceId)).toBe(needle);
  });

  it("refuses a stale source whose content no longer matches", async () => {
    const content = "def c():\n    return 3\n";
    await writeFile(resolve(repoRoot, "c.py"), content);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    const state = await captureGitState(repoRoot, { kind: "commit", ref: "HEAD" });
    const store = new SnapshotStore();
    store.store(state);
    const sourceId = createSourceId(state.snapshot, "c.py", content, 0, content.length);

    const tamperedSourceId = { ...sourceId, contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    expect(() => resolveSource(store, tamperedSourceId)).toThrow(StaleSourceError);
  });

  it("refuses a stale source that no longer exists in the snapshot", () => {
    const snapshot = { repoId: "sha256:x", kind: "commit" as const, resolvedOid: "a".repeat(40), contentDigest: "sha256:y" };
    const store = new SnapshotStore();
    store.store({ snapshot, files: [] });
    const sourceId = createSourceId(snapshot, "missing.py", "x = 1\n", 0, 5);
    expect(() => resolveSource(store, sourceId)).toThrow(StaleSourceError);
  });

  it("correlates a changed function between two states with left and right spans", () => {
    const leftSnapshot = { repoId: "sha256:x", kind: "commit" as const, resolvedOid: "a".repeat(40), contentDigest: "sha256:left" };
    const rightSnapshot = { repoId: "sha256:x", kind: "commit" as const, resolvedOid: "b".repeat(40), contentDigest: "sha256:right" };
    const leftContent = "def f():\n    return 1\n";
    const rightContent = "def f():\n    return 2\n";
    const left: CapturedState = { snapshot: leftSnapshot, files: [{ path: "m.py", content: leftContent }] };
    const right: CapturedState = { snapshot: rightSnapshot, files: [{ path: "m.py", content: rightContent }] };
    const diff = diffSnapshots(left, right);
    const leftGraph = graph(leftSnapshot, [entity("m.f", "m.py", leftContent, "def f():")]);
    const rightGraph = graph(rightSnapshot, [entity("m.f", "m.py", rightContent, "def f():")]);

    const correlated = correlateDiff(diff, leftGraph, rightGraph);

    expect(correlated).toEqual([{ kind: "entity", qualifiedName: "m.f", left: leftGraph.nodes[0], right: rightGraph.nodes[0] }]);
  });

  it("keeps a file-level diagnostic when structural correlation is unavailable", () => {
    const leftSnapshot = { repoId: "sha256:x", kind: "commit" as const, resolvedOid: "a".repeat(40), contentDigest: "sha256:left" };
    const rightSnapshot = { repoId: "sha256:x", kind: "commit" as const, resolvedOid: "b".repeat(40), contentDigest: "sha256:right" };
    const left: CapturedState = { snapshot: leftSnapshot, files: [{ path: "broken.py", content: "def broken(:\n" }] };
    const right: CapturedState = { snapshot: rightSnapshot, files: [{ path: "broken.py", content: "def broken(x):\n    pass\n" }] };
    const diff = diffSnapshots(left, right);

    const correlated = correlateDiff(diff, graph(leftSnapshot, []), graph(rightSnapshot, []));

    expect(correlated).toEqual([{ kind: "file", path: "broken.py", diagnostic: "No structural entities available for this file" }]);
  });
});
