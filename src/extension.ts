import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { buildCspMetaTag } from "../webview/graphView.js";
import { resolveRepoRoot, type GitSelection } from "./git/gitService.js";
import { SnapshotStore } from "./snapshots/snapshotStore.js";
import { DraftStore } from "./editing/draftStore.js";
import { performGuardedWrite } from "./editing/writeGuard.js";
import { runCall, runIntrospection, runSnippet } from "./execution/dockerRunner.js";
import { ChangeMapSession } from "./webviewHost.js";
import { ComparisonController, type FileWatcherHandle } from "./comparisonController.js";
import type { SourceId } from "./protocol.js";
import { resolveThemeTokens, type ExtensionLike, type ThemeTokens } from "./theme/themeResolver.js";
import { readFile } from "node:fs/promises";

/** Configuration keys watched for theme re-resolution (design D8). */
const THEME_CONFIG_KEYS = ["workbench.colorTheme", "window.autoDetectColorScheme", "workbench.preferredDarkColorTheme", "workbench.preferredLightColorTheme"];

function mapColorThemeKind(kind: vscode.ColorThemeKind): "light" | "dark" | "highContrast" {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.Dark:
      return "dark";
    default:
      return "highContrast";
  }
}

/** Resolves the current theme tokens from live `vscode` configuration/extension state (design D8). */
async function resolveActiveThemeTokens(): Promise<ThemeTokens> {
  const config = vscode.workspace.getConfiguration();
  const kind = mapColorThemeKind(vscode.window.activeColorTheme.kind);
  const autoDetect = config.get<boolean>("window.autoDetectColorScheme", false);
  const themeId = autoDetect
    ? config.get<string>(kind === "dark" ? "workbench.preferredDarkColorTheme" : "workbench.preferredLightColorTheme", "")
    : config.get<string>("workbench.colorTheme", "");
  const colorCustomizations = config.get<{ textMateRules?: unknown }>("workbench.colorCustomizations");
  return resolveThemeTokens({
    themeId: themeId ?? "",
    kind,
    io: {
      listExtensions: () => vscode.extensions.all as unknown as ExtensionLike[],
      readFile: (path) => readFile(path, "utf8"),
    },
    overrides: {
      semanticTokenColorCustomizations: config.get("editor.semanticTokenColorCustomizations"),
      colorCustomizationsTextMateRules: colorCustomizations?.textMateRules,
    },
  });
}

const AUTO_REFRESH_SETTING = "agentChangeMap.autoRefresh";

const VIRTUAL_SCHEME = "agent-change-map";

function snapshotKey(id: SourceId["snapshot"]): string {
  return `${id.repoId}:${id.kind}:${id.resolvedOid ?? ""}:${id.contentDigest}`;
}

/**
 * Maps a UTF-8 byte offset within `content` to a `vscode.Position`. Decodes the leading
 * bytes back to a string before splitting on lines so multi-byte UTF-8 characters are
 * accounted for rather than treating the byte offset as a character offset.
 */
function offsetToPosition(content: string, byteOffset: number): vscode.Position {
  const prefix = Buffer.from(content, "utf8").subarray(0, byteOffset).toString("utf8");
  const lines = prefix.split("\n");
  const line = lines.length - 1;
  const character = lines[line].length;
  return new vscode.Position(line, character);
}

class VirtualSourceContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

function buildWebviewHtml(nonce: string, cspSource: string, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${buildCspMetaTag(nonce, cspSource)}
<link rel="stylesheet" href="${styleUri.toString()}">
<title>Agent Change Map</title>
</head>
<body>
<div id="toolbar">
  <label for="filter-kind">Relationship</label>
  <select id="filter-kind">
    <option value="">All</option>
    <option value="contains">contains</option>
    <option value="import">import</option>
    <option value="call">call</option>
  </select>
</div>
<div id="oversized-consent" hidden></div>
<div id="status"></div>
<div id="graph"></div>
<div id="diff-panel"></div>
<script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

function parseGitSelection(input: string): GitSelection {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: "commit", ref: "HEAD" };
  return { kind: "commit", ref: trimmed };
}

async function pickComparisonReferences(): Promise<{ left: GitSelection; right: GitSelection } | undefined> {
  const leftInput = await vscode.window.showInputBox({
    prompt: "Left (base) reference: a commit or branch (blank = HEAD)",
    placeHolder: "HEAD",
  });
  if (leftInput === undefined) return undefined;
  const rightInput = await vscode.window.showInputBox({
    prompt: "Right (current) reference: a commit, branch, or blank to use the live worktree",
    placeHolder: "(worktree)",
  });
  if (rightInput === undefined) return undefined;

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) throw new Error("Open a workspace folder before comparing.");

  const right: GitSelection = rightInput.trim().length === 0 ? { kind: "worktree", path: workspaceFolder.uri.fsPath } : parseGitSelection(rightInput);
  return { left: parseGitSelection(leftInput), right };
}

function isAutoRefreshEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(AUTO_REFRESH_SETTING, false);
}

/**
 * Bridges a real `vscode.FileSystemWatcher` (`RelativePattern(worktree, "**\/*")`, per the
 * design's data-flow diagram) into the `ComparisonController`'s vscode-free `onChange`
 * contract, so the controller stays unit-testable without a `vscode` runtime import.
 */
function createWorktreeWatcher(worktreePath: string, onChange: (posixPath: string) => void): FileWatcherHandle {
  const pattern = new vscode.RelativePattern(worktreePath, "**/*");
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const forward = (uri: vscode.Uri): void => onChange(vscode.workspace.asRelativePath(uri, false));
  const subscriptions = [watcher.onDidChange(forward), watcher.onDidCreate(forward), watcher.onDidDelete(forward)];
  return {
    dispose(): void {
      for (const subscription of subscriptions) subscription.dispose();
      watcher.dispose();
    },
  };
}

/**
 * Test-only surface returned from {@link activate} exclusively when
 * `AGENT_CHANGE_MAP_E2E=1` is set in the Extension Development Host's environment. It
 * exposes the same real `ChangeMapSession`/`WebviewPanel` the command wiring above
 * creates so e2e tests can drive genuine intents (`handleIntent`) through the exact
 * production message-validation and orchestration path, without any way for the webview
 * itself to reach these internals and without any exposure in a normal install.
 */
export interface ExtensionTestHooks {
  getSession: () => ChangeMapSession | undefined;
  getPanel: () => vscode.WebviewPanel | undefined;
  getStore: () => SnapshotStore | undefined;
  getDraftStore: () => DraftStore | undefined;
  getSourceIndex: () => Record<string, { left?: SourceId; right?: SourceId }>;
  getLastReceivedMessages: () => unknown[];
}
export interface ExtensionApi {
  __test?: ExtensionTestHooks;
}

export interface CompareCommandArgs {
  left?: string;
  right?: string;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi | undefined {
  const contentProvider = new VirtualSourceContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, contentProvider));

  let lastSession: ChangeMapSession | undefined;
  let lastPanel: vscode.WebviewPanel | undefined;
  let lastStore: SnapshotStore | undefined;
  let lastDraftStore: DraftStore | undefined;
  let lastSourceIndex: Record<string, { left?: SourceId; right?: SourceId }> = {};
  const receivedMessages: unknown[] = [];

  const command = vscode.commands.registerCommand("agentChangeMap.compare", async (args?: CompareCommandArgs) => {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage("Agent Change Map requires an open workspace folder.");
        return;
      }
      const references = args?.left !== undefined || args?.right !== undefined
        ? { left: parseGitSelection(args.left ?? ""), right: args.right && args.right.trim().length > 0 ? parseGitSelection(args.right) : { kind: "worktree" as const, path: workspaceFolder.uri.fsPath } }
        : await pickComparisonReferences();
      if (!references) return;

      const repoRoot = await resolveRepoRoot(workspaceFolder.uri.fsPath);
      const store = new SnapshotStore();
      const draftStore = new DraftStore();

      const panel = vscode.window.createWebviewPanel("agentChangeMap", "Agent Change Map", vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(resolve(context.extensionPath, "out", "webview"))],
        // Source navigation opens the target file in a sibling editor tab, backgrounding this
        // panel. Without this, VS Code tears down the webview's DOM/JS state whenever it is
        // hidden and rebuilds it from scratch when it regains focus, silently discarding the
        // selected node, the loaded snippet draft, and any unsaved edits in progress.
        retainContextWhenHidden: true,
      });

      const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(resolve(context.extensionPath, "out", "webview", "webview", "index.js")));
      const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(resolve(context.extensionPath, "out", "webview", "webview", "styles.css")));
      const nonce = randomBytes(16).toString("hex");
      panel.webview.html = buildWebviewHtml(nonce, panel.webview.cspSource, scriptUri, styleUri);

      const controllerRef: { current?: ComparisonController } = {};
      const session = new ChangeMapSession({
        repoRoot,
        store,
        draftStore,
        post: (message) => {
          if (message.type === "graph") {
            lastSourceIndex = message.sourceIndex;
          }
          receivedMessages.push(message);
          void panel.webview.postMessage(message);
        },
        openSource: async (sourceId) => {
          const fullContent = store.getFileContent(sourceId.snapshot, sourceId.posixPath);
          if (fullContent === undefined) return;
          const uri = vscode.Uri.parse(`${VIRTUAL_SCHEME}:/${encodeURIComponent(snapshotKey(sourceId.snapshot))}/${sourceId.posixPath}`);
          contentProvider.set(uri, fullContent);
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          const startPos = offsetToPosition(fullContent, sourceId.startByte);
          const endPos = offsetToPosition(fullContent, sourceId.endByte);
          editor.selection = new vscode.Selection(startPos, endPos);
          editor.revealRange(new vscode.Range(startPos, endPos));
        },
        performWrite: performGuardedWrite,
        runSnippet,
        runIntrospection,
        runCall,
        requestRefresh: () => controllerRef.current!.requestRefresh(),
        onIdle: () => controllerRef.current!.onIdle(),
        resolveTheme: resolveActiveThemeTokens,
        subscribeThemeChange: (onChange) => {
          const subscriptions = [
            vscode.window.onDidChangeActiveColorTheme(() => onChange()),
            vscode.workspace.onDidChangeConfiguration((event) => {
              if (THEME_CONFIG_KEYS.some((key) => event.affectsConfiguration(key))) onChange();
            }),
          ];
          return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
        },
      });

      panel.webview.onDidReceiveMessage(async (raw: unknown) => {
        await session.handleIntent(raw);
      });
      panel.onDidDispose(() => session.dispose(), null, context.subscriptions);

      const controller = new ComparisonController({
        extensionRoot: context.extensionPath,
        repoRoot,
        references,
        store,
        session,
        isAutoRefreshEnabled,
        createWatcher: createWorktreeWatcher,
        onAutoRefreshConfigChange: (callback) => {
          const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(AUTO_REFRESH_SETTING)) callback();
          });
          return { dispose: () => subscription.dispose() };
        },
      });
      controllerRef.current = controller;
      panel.onDidDispose(() => controller.dispose());

      await controller.capture();
      lastSession = session;
      lastPanel = panel;
      lastStore = store;
      lastDraftStore = draftStore;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Agent Change Map comparison failed: ${reason}`);
    }
  });

  context.subscriptions.push(command);

  if (process.env.AGENT_CHANGE_MAP_E2E === "1") {
    return {
      __test: {
        getSession: () => lastSession,
        getPanel: () => lastPanel,
        getStore: () => lastStore,
        getDraftStore: () => lastDraftStore,
        getSourceIndex: () => lastSourceIndex,
        getLastReceivedMessages: () => receivedMessages,
      },
    };
  }
  return undefined;
}

export function deactivate(): void {}
