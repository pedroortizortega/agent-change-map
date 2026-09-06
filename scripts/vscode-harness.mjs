import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runTests, resolveCliArgsFromVSCodeExecutablePath, downloadAndUnzipVSCode } from "@vscode/test-electron";

const repoRoot = resolve(import.meta.dirname, "..");

// This harness may itself run inside an Electron-based host (e.g. an agent sandbox) that
// sets ELECTRON_RUN_AS_NODE=1 for its own child processes. Left inherited, that variable
// forces the *test* VS Code's Electron binary into plain-Node mode instead of launching
// its Chromium UI, which fails immediately trying to `require()` the workspace path as a
// script. Remove it before spawning the real Extension Development Host.
delete process.env.ELECTRON_RUN_AS_NODE;

const required = ["test/unit", "test/integration", "test/e2e", "test/fixtures"];
const missing = required.filter((path) => !existsSync(resolve(repoRoot, path)));
if (missing.length > 0) {
  console.error(`VS Code harness is missing: ${missing.join(", ")}`);
  process.exit(1);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function createFixtureRepo() {
  const root = mkdtempSync(resolve(tmpdir(), "agent-change-map-e2e-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "e2e@example.com"]);
  git(root, ["config", "user.name", "E2E"]);
  writeFileSync(resolve(root, "sample.py"), "def greet():\n    return 'hello'\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  writeFileSync(resolve(root, "sample.py"), "def greet():\n    return 'hello world'\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "current"]);
  return root;
}

async function main() {
  console.log("Building extension host and webview bundles before launching the Extension Development Host...");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  execFileSync("npx", ["tsc", "-p", "tsconfig.e2e.json"], { cwd: repoRoot, stdio: "inherit" });

  const fixtureRoot = createFixtureRepo();
  try {
    let vscodeExecutablePath;
    try {
      vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
    } catch (error) {
      console.error("Could not download a VS Code test build for the Extension Development Host.");
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
      return;
    }
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    void cliPath;
    void cliArgs;

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: resolve(repoRoot, "out", "test", "e2e", "runner.js"),
      launchArgs: [fixtureRoot, "--disable-gpu", "--no-sandbox", "--disable-workspace-trust"],
      extensionTestsEnv: {
        AGENT_CHANGE_MAP_E2E: "1",
        AGENT_CHANGE_MAP_E2E_FIXTURE: fixtureRoot,
      },
    });
    console.log("VS Code extension e2e scenarios passed.");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("VS Code extension e2e run failed:");
  console.error(error);
  process.exitCode = 1;
});
