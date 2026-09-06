import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../src/extension.js";
import type { AnalysisGraph, Entity, SnapshotId, SourceId } from "../../src/protocol.js";

const EXTENSION_ID = "agent-change-map";

/**
 * Reads the real two-commit Git fixture repository the harness script
 * (`scripts/run-e2e.mjs`) created on disk *before* launching this Extension Development
 * Host - the workspace folder VS Code opens is a launch-time argument, so the fixture
 * must exist first. Nothing about the repository's content or history is mocked: this
 * resolves the same two real commit oids `git log` would report.
 */
function locateFixtureRepo(): { root: string; baseOid: string; currentOid: string } {
  const root = process.env.AGENT_CHANGE_MAP_E2E_FIXTURE;
  assert.ok(root, "Expected AGENT_CHANGE_MAP_E2E_FIXTURE to name the prepared fixture repository");
  const baseOid = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root }).toString().trim();
  const currentOid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  return { root: root!, baseOid, currentOid };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

function findLoadedExtension(): vscode.Extension<unknown> {
  const byId = vscode.extensions.getExtension(EXTENSION_ID) ?? vscode.extensions.getExtension(`undefined_publisher.${EXTENSION_ID}`);
  if (byId) return byId;
  const byName = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase().endsWith(`.${EXTENSION_ID}`) || candidate.id === EXTENSION_ID);
  assert.ok(byName, `Extension '${EXTENSION_ID}' was not found among loaded extensions: ${vscode.extensions.all.map((e) => e.id).join(", ")}`);
  return byName!;
}

async function activateExtensionApi(): Promise<ExtensionApi> {
  const extension = findLoadedExtension();
  const api = extension.exports as ExtensionApi | undefined;
  assert.ok(api?.__test, "Extension did not return test hooks - is AGENT_CHANGE_MAP_E2E=1 set?");
  return api!;
}

/**
 * Drives every Phase 5 scenario named in the tasks: selection, exact/stale navigation,
 * draft/direct save, explicit run/stream/cancel, and oversized consent. Selection and
 * comparison run through the real `agentChangeMap.compare` command against a real Git
 * fixture and the real Python analyzer subprocess. Because VS Code's public extension API
 * does not expose a way to script clicks inside a webview's own HTML content, the
 * "user acts inside the webview" step is replaced by calling the exact same
 * `session.handleIntent(...)` entry point the webview's `postMessage` would have invoked -
 * exercising the identical validation/orchestration code path end to end against real
 * VS Code editor, filesystem, and (when available) Docker operations.
 */
export async function runScenarios(): Promise<void> {
  const fixture = locateFixtureRepo();
  {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Expected the Extension Development Host to open the fixture workspace folder");
    assert.equal(resolve(workspaceFolder!.uri.fsPath), resolve(fixture.root), "Workspace folder should be the fixture repository");
    console.log("[e2e] workspace folder confirmed as fixture repository");

    await vscode.commands.executeCommand("agentChangeMap.compare", { left: fixture.baseOid, right: fixture.currentOid });
    const api = await activateExtensionApi();
    const hooks = api.__test!;

    // --- Selection: run the real compare command against two real commits ---
    await vscode.commands.executeCommand("agentChangeMap.compare", { left: fixture.baseOid, right: fixture.currentOid });
    const session = hooks.getSession();
    const store = hooks.getStore();
    assert.ok(session, "Expected a ChangeMapSession to be created by the compare command");
    assert.ok(store, "Expected a SnapshotStore to be created by the compare command");
    await waitFor(() => hooks.getLastReceivedMessages().some((m) => (m as { type?: string }).type === "graph"));
    const graphMessage = hooks.getLastReceivedMessages().find((m) => (m as { type?: string }).type === "graph") as
      | { graph: AnalysisGraph }
      | undefined;
    assert.ok(graphMessage, "Expected a graph message after a non-oversized comparison");
    assert.ok(graphMessage!.graph.nodes.length > 0, "Expected at least one analyzed entity");
    console.log(`[e2e] selection scenario ok: ${graphMessage!.graph.nodes.length} analyzed entities`);

    const sourceIndex = hooks.getSourceIndex();
    const entry = Object.values(sourceIndex).find((candidate) => candidate.right);
    assert.ok(entry?.right, "Expected at least one entity with a right-side SourceId");
    const validSourceId = entry!.right as SourceId;

    // --- Exact navigation ---
    await session!.handleIntent({ type: "navigate", sourceId: validSourceId, side: "right" });
    await waitFor(() =>
      hooks
        .getLastReceivedMessages()
        .some((m) => (m as { type?: string; ok?: boolean }).type === "navigateResult" && (m as { ok?: boolean }).ok === true),
    );
    assert.ok(vscode.window.activeTextEditor, "Expected exact navigation to open a real editor");
    console.log("[e2e] exact navigation scenario ok");

    // --- Stale navigation refusal ---
    const staleSourceId: SourceId = { ...validSourceId, contentHash: "sha256:" + "0".repeat(64) };
    const beforeStaleCount = hooks.getLastReceivedMessages().length;
    await session!.handleIntent({ type: "navigate", sourceId: staleSourceId, side: "right" });
    await waitFor(() => hooks.getLastReceivedMessages().length > beforeStaleCount);
    const staleResult = hooks.getLastReceivedMessages().at(-1) as { type: string; ok: boolean; reason?: string };
    assert.equal(staleResult.type, "navigateResult");
    assert.equal(staleResult.ok, false);
    assert.ok(staleResult.reason && staleResult.reason.length > 0, "Expected an explicit stale-navigation refusal reason");
    console.log("[e2e] stale navigation refusal scenario ok");

    // --- Draft save ---
    await session!.handleIntent({ type: "saveDraft", sourceId: validSourceId, content: "draft content" });
    await waitFor(() => hooks.getLastReceivedMessages().some((m) => (m as { type?: string }).type === "draftSaved"));
    const draftStore = hooks.getDraftStore();
    assert.equal(draftStore?.get(validSourceId)?.content, "draft content");
    console.log("[e2e] draft save scenario ok");

    // --- Forged repository root through the session created by the real command ---
    const outsideDirectory = await mkdtemp(join(tmpdir(), "change-map-e2e-outside-"));
    try {
      const outsideTarget = join(outsideDirectory, "outside.py");
      const original = "external content\n";
      await writeFile(outsideTarget, original);
      const { computeContentHash } = await import("../../src/navigation/sourceProvider.js");
      const requestId = "e2e-forged-root";
      const request = session!.handleIntent({ type: "requestDirectWrite", requestId, repoRoot: parse(outsideDirectory).root, targetPath: outsideTarget, baseHash: computeContentHash(original), replacement: "attacker content" });
      await waitFor(() => hooks.getLastReceivedMessages().some((raw) => {
        const message = raw as { type?: string; requestId?: string };
        return message.requestId === requestId && (message.type === "directWritePreview" || message.type === "directWriteResult");
      }));
      // Confirm even if a vulnerable host offers a preview: no UI trust is assumed.
      await session!.handleIntent({ type: "confirmDirectWrite", requestId, confirmed: true });
      await request;
      assert.equal(await readFile(outsideTarget, "utf8"), original, "Forged root must not authorize an external write");
      assert.deepEqual(await readdir(outsideDirectory), ["outside.py"], "Refused write must not create backups or temporary files");
      const result = hooks.getLastReceivedMessages().at(-1) as { type: string; requestId: string; ok: boolean; reason: string };
      assert.equal(result.type, "directWriteResult");
      assert.equal(result.requestId, requestId);
      assert.equal(result.ok, false);
      assert.match(result.reason, /invalid/);
      console.log("[e2e] forged repository root refusal scenario ok");
    } finally {
      await rm(outsideDirectory, { recursive: true, force: true });
    }

    // --- Direct save: request, preview, explicit confirm, real guarded write ---
    const targetPath = resolve(fixture.root, "sample.py");
    const currentOnDisk = await vscode.workspace.fs.readFile(vscode.Uri.file(targetPath));
    const { computeContentHash } = await import("../../src/navigation/sourceProvider.js");
    const baseHash = computeContentHash(Buffer.from(currentOnDisk).toString("utf8"));
    const writeRequestId = "e2e-write-1";
    const writePromise = session!.handleIntent({
      type: "requestDirectWrite",
      requestId: writeRequestId,
      repoRoot: fixture.root,
      targetPath,
      baseHash,
      replacement: "def greet():\n    return 'hello world, edited'\n",
    });
    await waitFor(() =>
      hooks.getLastReceivedMessages().some((m) => (m as { type?: string; requestId?: string }).type === "directWritePreview" && (m as { requestId?: string }).requestId === writeRequestId),
    );
    await session!.handleIntent({ type: "confirmDirectWrite", requestId: writeRequestId, confirmed: true });
    await writePromise;
    const writeResult = hooks.getLastReceivedMessages().at(-1) as { type: string; ok: boolean };
    assert.equal(writeResult.type, "directWriteResult");
    assert.equal(writeResult.ok, true);
    const writtenContent = await vscode.workspace.fs.readFile(vscode.Uri.file(targetPath));
    assert.equal(Buffer.from(writtenContent).toString("utf8"), "def greet():\n    return 'hello world, edited'\n");
    console.log("[e2e] direct save scenario ok");

    // --- Oversized consent: reload with a synthetic oversized comparison ---
    const bigNodes: Entity[] = Array.from({ length: 301 }, (_, i) => ({
      id: `synthetic:${i}`,
      kind: "function",
      qualifiedName: `synthetic.q${i}`,
      span: { path: "sample.py", startByte: 0, endByte: 1, startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
    }));
    const oversizedSnapshot: SnapshotId = graphMessage!.graph.snapshot;
    const oversizedGraph: AnalysisGraph = { snapshot: oversizedSnapshot, nodes: bigNodes, edges: [], diagnostics: [] };
    const beforeOversizedCount = hooks.getLastReceivedMessages().length;
    session!.loadComparison(undefined, oversizedGraph, []);
    await waitFor(() => hooks.getLastReceivedMessages().length > beforeOversizedCount);
    const summary = hooks.getLastReceivedMessages().at(-1) as { type: string; oversized: boolean };
    assert.equal(summary.type, "graphSummary");
    assert.equal(summary.oversized, true);
    const afterSummaryCount = hooks.getLastReceivedMessages().length;
    await session!.handleIntent({ type: "confirmOversized", confirmed: true });
    await waitFor(() => hooks.getLastReceivedMessages().length > afterSummaryCount);
    const afterConsent = hooks.getLastReceivedMessages().at(-1) as { type: string };
    assert.equal(afterConsent.type, "graph");
    console.log("[e2e] oversized consent scenario ok");

    // --- Refresh: create a file in the worktree, refresh, see the new node without reopening ---
    {
      await vscode.commands.executeCommand("agentChangeMap.compare", { left: fixture.baseOid, right: "" });
      const refreshHooks = (await activateExtensionApi()).__test!;
      const refreshSession = refreshHooks.getSession();
      assert.ok(refreshSession, "Expected a ChangeMapSession for the worktree-right comparison");
      await waitFor(() => refreshHooks.getLastReceivedMessages().some((m) => (m as { type?: string }).type === "graph"));
      const beforeRefreshGraph = refreshHooks.getLastReceivedMessages().filter((m) => (m as { type?: string }).type === "graph").at(-1) as { graph: AnalysisGraph };
      assert.equal(beforeRefreshGraph.graph.nodes.some((node) => node.span.path === "refreshed.py"), false, "New file must not yet exist in the pre-refresh graph");

      const newFilePath = resolve(fixture.root, "refreshed.py");
      try {
        await writeFile(newFilePath, "def refreshed():\n    return 'new'\n");
        const beforeRefreshCount = refreshHooks.getLastReceivedMessages().length;
        await refreshSession!.handleIntent({ type: "requestRefresh", requestId: "e2e-refresh-1" });
        await waitFor(() => refreshHooks.getLastReceivedMessages().length > beforeRefreshCount);
        const refreshResult = refreshHooks
          .getLastReceivedMessages()
          .find((m) => (m as { type?: string; requestId?: string }).type === "refreshResult" && (m as { requestId?: string }).requestId === "e2e-refresh-1") as { ok: boolean } | undefined;
        assert.ok(refreshResult, "Expected a refreshResult message for the manual refresh request");
        assert.equal(refreshResult!.ok, true);
        const afterRefreshGraph = refreshHooks.getLastReceivedMessages().filter((m) => (m as { type?: string }).type === "graph").at(-1) as { graph: AnalysisGraph; untrackedPaths: string[] };
        assert.ok(afterRefreshGraph.graph.nodes.some((node) => node.span.path === "refreshed.py"), "Expected the newly created file's node after refresh");
        assert.ok(afterRefreshGraph.untrackedPaths.includes("refreshed.py"), "Expected the newly created file to be reported as untracked");
        console.log("[e2e] refresh scenario ok: new file visible without reopening the panel");
      } finally {
        await rm(newFilePath, { force: true });
      }
    }

    // --- Explicit run / stream / cancel (only if a real Docker daemon is reachable) ---
    const dockerAvailable = await isDockerAvailable();
    if (dockerAvailable) {
      session!.setActiveSources({ current: { variant: "current", path: "sample.py", content: "import time\nprint('e2e run ok')\ntime.sleep(2)\n" } });
      const runRequestId = "e2e-run-1";
      const beforeRunCount = hooks.getLastReceivedMessages().length;
      await session!.handleIntent({ type: "requestRun", requestId: runRequestId, variants: ["current"] });
      await waitFor(() => hooks.getLastReceivedMessages().length > beforeRunCount);
      const confirmationRequired = hooks.getLastReceivedMessages().at(-1) as { type: string };
      assert.equal(confirmationRequired.type, "runConfirmationRequired");
      await session!.handleIntent({ type: "confirmRun", requestId: runRequestId, confirmed: true });
      await waitFor(() => hooks.getLastReceivedMessages().some(raw => {
        const message = raw as { type?: string; requestId?: string; channel?: string; data?: string };
        return message.type === "runEvent" && message.requestId === runRequestId && message.channel === "stdout" && message.data?.includes("e2e run ok");
      }), 60_000);
      assert.equal(hooks.getLastReceivedMessages().some(raw => {
        const message = raw as { type?: string; requestId?: string };
        return message.type === "runResult" && message.requestId === runRequestId;
      }), false, "Real Docker stdout must arrive before the snippet finishes");
      await waitFor(
        () => hooks.getLastReceivedMessages().some((m) => (m as { type?: string; requestId?: string }).type === "runResult" && (m as { requestId?: string }).requestId === runRequestId),
        60_000,
      );
      const runResultMessage = hooks.getLastReceivedMessages().find(
        (m) => (m as { type?: string; requestId?: string }).type === "runResult" && (m as { requestId?: string }).requestId === runRequestId,
      ) as { results: { kind: string; stdout?: string }[] };
      assert.equal(runResultMessage.results[0]?.kind, "success");
      assert.ok(runResultMessage.results[0]?.stdout?.includes("e2e run ok"));

      const streamEvents = hooks
        .getLastReceivedMessages()
        .filter((m) => (m as { type?: string; requestId?: string }).type === "runEvent" && (m as { requestId?: string }).requestId === runRequestId);
      assert.ok(streamEvents.length >= 2, "Expected multiple ordered lifecycle/stream run events");
      console.log(`[e2e] explicit run/stream scenario ok: ${streamEvents.length} run events`);

      // Cancel path: start a long-running snippet and cancel it.
      session!.setActiveSources({ current: { variant: "current", path: "sample.py", content: "import time\ntime.sleep(30)\n" } });
      const cancelRequestId = "e2e-run-cancel-1";
      await session!.handleIntent({ type: "requestRun", requestId: cancelRequestId, variants: ["current"] });
      await session!.handleIntent({ type: "confirmRun", requestId: cancelRequestId, confirmed: true });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await session!.handleIntent({ type: "cancelRun", requestId: cancelRequestId });
      await waitFor(
        () => hooks.getLastReceivedMessages().some((m) => (m as { type?: string; requestId?: string }).type === "runResult" && (m as { requestId?: string }).requestId === cancelRequestId),
        60_000,
      );
      const cancelResultMessage = hooks.getLastReceivedMessages().find(
        (m) => (m as { type?: string; requestId?: string }).type === "runResult" && (m as { requestId?: string }).requestId === cancelRequestId,
      ) as { results: { kind: string }[] };
      assert.equal(cancelResultMessage.results[0]?.kind, "cancelled");
      console.log("[e2e] explicit cancel scenario ok");
    } else {
      console.log("[e2e] Skipping explicit run/stream/cancel assertions: no Docker daemon reachable in this environment.");
    }
    console.log("[e2e] all scenarios completed");
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
