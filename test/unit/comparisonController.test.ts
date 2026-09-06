import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webviewToHostMessageSchema } from "../../src/webviewProtocol.js";
import { ComparisonController } from "../../src/comparisonController.js";
import { ChangeMapSession } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import { execFileSync } from "node:child_process";

describe("requestRefresh schema", () => {
  it("accepts a valid requestRefresh message", () => {
    const result = webviewToHostMessageSchema.safeParse({ type: "requestRefresh", requestId: "r1" });
    expect(result.success).toBe(true);
  });

  it("rejects a requestRefresh message missing requestId", () => {
    const result = webviewToHostMessageSchema.safeParse({ type: "requestRefresh" });
    expect(result.success).toBe(false);
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

async function makeWorktreeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comparison-controller-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@b.c"]);
  git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "a.py"), "print(1)\n");
  git(dir, ["add", "a.py"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("ComparisonController", () => {
  let repoRoot: string;
  let posted: HostToWebviewMessage[];
  let session: ChangeMapSession;
  let store: SnapshotStore;

  beforeEach(async () => {
    repoRoot = await makeWorktreeRepo();
    posted = [];
    store = new SnapshotStore();
    session = new ChangeMapSession({
      repoRoot,
      store,
      draftStore: new DraftStore(),
      post: message => posted.push(message),
      openSource: vi.fn(),
      performWrite: vi.fn(),
      runSnippet: vi.fn(),
    });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("requestRefresh re-runs capture and re-posts graphSummary + graph; a file created between captures appears in the second graph", async () => {
    const controller = new ComparisonController({
      extensionRoot: process.cwd(),
      repoRoot,
      references: { left: { kind: "commit", ref: "HEAD" }, right: { kind: "worktree", path: repoRoot } },
      store,
      session,
    });
    await controller.capture();
    expect(posted.map(m => m.type)).toEqual(["graphSummary", "graph"]);
    const firstGraph = posted.find((m): m is Extract<HostToWebviewMessage, { type: "graph" }> => m.type === "graph")!;
    expect(firstGraph.graph.nodes.some(n => n.span.path === "b.py")).toBe(false);

    await writeFile(join(repoRoot, "b.py"), "print(2)\n");
    await controller.requestRefresh();
    expect(posted.map(m => m.type)).toEqual(["graphSummary", "graph", "graphSummary", "graph"]);
    const secondGraph = posted.at(-1) as Extract<HostToWebviewMessage, { type: "graph" }>;
    expect(secondGraph.graph.nodes.some(n => n.span.path === "b.py")).toBe(true);
    expect(secondGraph.untrackedPaths).toContain("b.py");
    const summaries = posted.filter((m): m is Extract<HostToWebviewMessage, { type: "graphSummary" }> => m.type === "graphSummary");
    expect(summaries.map(s => s.loadReason)).toEqual(["initial", "refresh"]);
  });
});
