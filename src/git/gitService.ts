import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SnapshotId } from "../protocol.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const UNSAFE_TOKEN_PATTERN = /[\s:^~?*[\]\\]/;

export interface CapturedFile {
  path: string;
  content: string;
}

export interface CapturedState {
  snapshot: SnapshotId;
  files: CapturedFile[];
}

export interface CommitSelection {
  kind: "commit";
  ref: string;
}

export interface WorktreeSelection {
  kind: "worktree";
  path: string;
}

export type GitSelection = CommitSelection | WorktreeSelection;

export interface WorktreeCaptureBegin {
  canonicalPath: string;
  fingerprint: string;
  trackedPaths: string[];
}

/** Rejected during pre-flight validation before any Git process is spawned. */
export class GitSelectionError extends Error {}

/** Raised when a worktree's tracked content changes while it is being captured. */
export class GitCaptureInstabilityError extends Error {}

interface TreeEntry {
  type: string;
  sha: string;
  path: string;
}

function assertSafeToken(token: string, label: string): void {
  if (typeof token !== "string" || token.length === 0) throw new GitSelectionError(`${label} must be a non-empty string`);
  if (token.startsWith("-")) throw new GitSelectionError(`${label} must not start with '-': ${token}`);
  if (token.includes("..") || UNSAFE_TOKEN_PATTERN.test(token)) throw new GitSelectionError(`${label} contains unsupported characters: ${token}`);
}

async function runGit(cwd: string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("Git operations require an absolute working directory");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputLength = 0;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    outputLength += chunk.length;
    if (outputLength > MAX_OUTPUT_BYTES) fail(new Error(`git output exceeded ${MAX_OUTPUT_BYTES} bytes`));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    outputLength += chunk.length;
    if (outputLength > MAX_OUTPUT_BYTES) fail(new Error(`git output exceeded ${MAX_OUTPUT_BYTES} bytes`));
  });

  await new Promise<void>((completeExec, reject) => {
    const timer = setTimeout(() => fail(new Error(`git command timed out after ${timeoutMs}ms: git ${args.join(" ")}`)), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) completeExec();
      else reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`));
    });
  });

  return Buffer.concat(stdoutChunks).toString("utf8");
}

export async function resolveRepoRoot(startPath: string): Promise<string> {
  if (!isAbsolute(startPath)) throw new Error("Repository root discovery requires an absolute path");
  const canonicalStart = await realpath(startPath);
  const output = await runGit(canonicalStart, ["rev-parse", "--show-toplevel"]);
  return realpath(output.trim());
}

/**
 * Validates that a user-supplied worktree path resolves, via realpath, inside the
 * repository working tree. Rejects flag-injection-shaped input, relative escapes, and
 * absolute foreign paths without ever invoking Git or mutating repository state.
 */
export async function validateWorktreeMembership(repoRoot: string, candidatePath: string): Promise<string> {
  assertSafeToken(candidatePath, "Worktree path");
  const absoluteCandidate = isAbsolute(candidatePath) ? candidatePath : resolve(repoRoot, candidatePath);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(absoluteCandidate);
  } catch {
    throw new GitSelectionError(`Worktree path does not exist: ${candidatePath}`);
  }
  const canonicalRoot = await realpath(repoRoot);
  const relativePath = relative(canonicalRoot, canonicalCandidate);
  if (relativePath !== "" && (relativePath.startsWith("..") || isAbsolute(relativePath))) {
    throw new GitSelectionError(`Worktree path escapes repository: ${candidatePath}`);
  }
  return canonicalCandidate;
}

export async function resolveCommitOid(repoRoot: string, ref: string): Promise<string> {
  assertSafeToken(ref, "Git reference");
  const output = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const oid = output.trim();
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new GitSelectionError(`Unable to resolve commit reference: ${ref}`);
  return oid;
}

async function listTreeEntries(repoRoot: string, oid: string): Promise<TreeEntry[]> {
  const output = await runGit(repoRoot, ["ls-tree", "-r", "--full-tree", oid]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [, type, sha] = meta.split(" ");
      return { type, sha, path };
    })
    .filter((entry): entry is TreeEntry => entry.type === "blob");
}

async function readBlob(repoRoot: string, sha: string): Promise<string> {
  return runGit(repoRoot, ["cat-file", "-p", sha]);
}

async function computeRepoId(repoRoot: string): Promise<string> {
  const canonical = await realpath(repoRoot);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function computeContentDigest(files: CapturedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function captureCommitState(repoRoot: string, ref: string): Promise<CapturedState> {
  const oid = await resolveCommitOid(repoRoot, ref);
  const entries = await listTreeEntries(repoRoot, oid);
  const files = await Promise.all(entries.map(async (entry) => ({ path: entry.path, content: await readBlob(repoRoot, entry.sha) })));
  const repoId = await computeRepoId(repoRoot);
  return { snapshot: { repoId, kind: "commit", resolvedOid: oid, contentDigest: computeContentDigest(files) }, files };
}

async function statusFingerprint(canonicalPath: string): Promise<string> {
  const output = await runGit(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=no"]);
  return `sha256:${createHash("sha256").update(output, "utf8").digest("hex")}`;
}

async function listTrackedPaths(canonicalPath: string): Promise<string[]> {
  const output = await runGit(canonicalPath, ["ls-files"]);
  return output.split("\n").filter(Boolean);
}

/**
 * Begins a two-phase worktree capture: records a stability fingerprint and the tracked
 * path list before reading any file content, so instability introduced mid-capture can
 * be detected deterministically by {@link finishWorktreeCapture}.
 */
export async function beginWorktreeCapture(repoRoot: string, worktreePath: string): Promise<WorktreeCaptureBegin> {
  const canonicalPath = await validateWorktreeMembership(repoRoot, worktreePath);
  const fingerprint = await statusFingerprint(canonicalPath);
  const trackedPaths = await listTrackedPaths(canonicalPath);
  return { canonicalPath, fingerprint, trackedPaths };
}

export async function finishWorktreeCapture(begin: WorktreeCaptureBegin): Promise<CapturedState> {
  const files = await Promise.all(
    begin.trackedPaths.map(async (path) => ({ path, content: await readFile(resolve(begin.canonicalPath, path), "utf8") })),
  );
  const afterFingerprint = await statusFingerprint(begin.canonicalPath);
  if (afterFingerprint !== begin.fingerprint) {
    throw new GitCaptureInstabilityError("Worktree state changed while capturing the selected content; comparison refused as unstable");
  }
  const repoId = await computeRepoId(begin.canonicalPath);
  return { snapshot: { repoId, kind: "worktree", contentDigest: computeContentDigest(files) }, files };
}

export async function captureWorktreeState(repoRoot: string, worktreePath: string): Promise<CapturedState> {
  const begin = await beginWorktreeCapture(repoRoot, worktreePath);
  return finishWorktreeCapture(begin);
}

export async function captureGitState(repoRoot: string, selection: GitSelection): Promise<CapturedState> {
  if (selection.kind === "commit") return captureCommitState(repoRoot, selection.ref);
  return captureWorktreeState(repoRoot, selection.path);
}
