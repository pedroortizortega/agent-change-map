import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const build = spawnSync("npm", ["run", "-s", "build"], { cwd: extensionRoot, stdio: "inherit", shell: false });
if (build.status !== 0) {
  console.error("Build failed; cannot exercise the compiled git service.");
  process.exit(build.status ?? 1);
}

const { resolveRepoRoot, captureCommitState, captureWorktreeState, validateWorktreeMembership, GitSelectionError } = await import(
  pathToFileURL(resolve(extensionRoot, "out/git/gitService.js")).href
);
const { diffSnapshots } = await import(pathToFileURL(resolve(extensionRoot, "out/snapshots/snapshotStore.js")).href);

const repoRoot = await resolveRepoRoot(extensionRoot);
console.log(`Repository root: ${repoRoot}`);

const commitState = await captureCommitState(repoRoot, "HEAD");
console.log(`Captured HEAD (${commitState.snapshot.resolvedOid.slice(0, 12)}): ${commitState.files.length} files.`);

const worktreeState = await captureWorktreeState(repoRoot, repoRoot);
console.log(`Captured worktree: ${worktreeState.files.length} tracked files.`);

const diff = diffSnapshots(commitState, worktreeState);
console.log(`Diff HEAD -> worktree: ${diff.entries.length} changed file(s).`);

try {
  await validateWorktreeMembership(repoRoot, "-Cmalicious");
  console.error("Expected -C-like injection to be rejected.");
  process.exit(1);
} catch (error) {
  if (!(error instanceof GitSelectionError)) throw error;
  console.log("Flag-injection-shaped worktree path correctly rejected without mutation.");
}

console.log("Git harness completed without repository mutation.");
