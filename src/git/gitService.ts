import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { DTO_LIMITS, type SnapshotId } from "../protocol.js";

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
  headOid: string | null;
  contentFingerprint: string;
}

/** Rejected during pre-flight validation before any Git process is spawned. */
export class GitSelectionError extends Error {}

/** Raised when a worktree's tracked content changes while it is being captured. */
export class GitCaptureInstabilityError extends Error {}

/** Raised when a capture exceeds the tracked-file count or per-file content size limits shared with {@link DTO_LIMITS}. */
export class GitCaptureLimitError extends Error {}

/** Raised when tracked content cannot be losslessly decoded as UTF-8 (i.e. it is binary). */
export class GitBinaryContentError extends Error {}

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

/**
 * Rejects flag-injection-shaped filesystem paths (a leading '-' that a spawned
 * git process could interpret as an option) without rejecting legitimate path
 * characters such as ':' or '\\', which occur in valid Windows absolute paths
 * (e.g. `C:\repo\src`). Path traversal/escape safety is enforced separately by
 * the realpath + relative() containment check in {@link validateWorktreeMembership}.
 */
function assertSafePathToken(token: string, label: string): void {
  if (typeof token !== "string" || token.length === 0) throw new GitSelectionError(`${label} must be a non-empty string`);
  if (token.startsWith("-")) throw new GitSelectionError(`${label} must not start with '-': ${token}`);
}

async function runGitBuffer(cwd: string, args: string[], options: { timeoutMs?: number } = {}): Promise<Buffer> {
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

  return Buffer.concat(stdoutChunks);
}

async function runGit(cwd: string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const output = await runGitBuffer(cwd, args, options);
  return output.toString("utf8");
}

/**
 * Decodes raw content bytes as UTF-8, verifying the decode round-trips losslessly
 * (i.e. re-encoding the decoded string reproduces the original bytes exactly). This
 * distinguishes genuine UTF-8 text - including non-ASCII UTF-8 such as accented
 * characters - from binary content, which Node's UTF-8 decoder would otherwise
 * silently corrupt via lossy replacement characters.
 */
function decodeUtf8OrThrow(content: Buffer, path: string): string {
  const decoded = content.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(content)) {
    throw new GitBinaryContentError(`Tracked file is not valid UTF-8 text and cannot be captured: ${path}`);
  }
  return decoded;
}

function assertWithinCaptureLimits(fileCount: number): void {
  if (fileCount > DTO_LIMITS.maxFiles) {
    throw new GitCaptureLimitError(`Capture exceeds the maximum tracked-file count of ${DTO_LIMITS.maxFiles} (found ${fileCount})`);
  }
}

function assertContentWithinSizeLimit(content: Buffer, path: string): void {
  if (content.length > DTO_LIMITS.maxFileContentBytes) {
    throw new GitCaptureLimitError(
      `Tracked file exceeds the maximum content size of ${DTO_LIMITS.maxFileContentBytes} bytes: ${path}`,
    );
  }
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
  assertSafePathToken(candidatePath, "Worktree path");
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
  let output: string;
  try {
    output = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (error) {
    throw new GitSelectionError(`Unable to resolve commit reference: ${ref}`, { cause: error });
  }
  const oid = output.trim();
  if (!/^[0-9a-f]{40}$/i.test(oid) && !/^[0-9a-f]{64}$/i.test(oid)) {
    throw new GitSelectionError(`Unable to resolve commit reference: ${ref}`);
  }
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

async function readBlobBuffer(repoRoot: string, sha: string): Promise<Buffer> {
  return runGitBuffer(repoRoot, ["cat-file", "-p", sha]);
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
  assertWithinCaptureLimits(entries.length);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const buffer = await readBlobBuffer(repoRoot, entry.sha);
      assertContentWithinSizeLimit(buffer, entry.path);
      return { path: entry.path, content: decodeUtf8OrThrow(buffer, entry.path) };
    }),
  );
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
 * Resolves the commit oid HEAD currently points to, or null when the worktree has no
 * commits yet (e.g. a freshly initialized repository). Used to detect a clean checkout
 * to a different commit/branch happening mid-capture, which leaves `git status
 * --porcelain` unchanged (clean before and after) but changes which commit's content
 * would be read.
 */
async function resolveHeadOidOrNull(canonicalPath: string): Promise<string | null> {
  try {
    return await resolveCommitOid(canonicalPath, "HEAD");
  } catch {
    return null;
  }
}

/**
 * Hashes the path and content of every tracked file so instability that a porcelain
 * status diff cannot see - e.g. a file already dirty at `begin` time being edited again
 * during the capture window, which leaves the porcelain status letter unchanged - is
 * still detected by comparing this fingerprint before and after the read.
 */
function contentFingerprintFromEntries(entries: { path: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const { path, content } of entries) {
    hash.update(path, "utf8");
    hash.update("\0");
    hash.update(content, "utf8");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readTrackedContentOrMarker(canonicalPath: string, path: string): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(resolve(canonicalPath, path));
  } catch {
    return " missing ";
  }
  return decodeUtf8OrThrow(buffer, path);
}

async function computeTrackedContentFingerprint(canonicalPath: string, trackedPaths: string[]): Promise<string> {
  const entries = await Promise.all(
    trackedPaths.map(async (path) => ({ path, content: await readTrackedContentOrMarker(canonicalPath, path) })),
  );
  return contentFingerprintFromEntries(entries);
}

/**
 * Begins a two-phase worktree capture: records a stability fingerprint (status,
 * resolved HEAD oid, and per-file tracked content) and the tracked path list before
 * reading any file content for the actual capture, so instability introduced mid-capture
 * - including a same-status re-edit of an already-dirty file, or a clean checkout to a
 * different commit - can be detected deterministically by {@link finishWorktreeCapture}.
 */
export async function beginWorktreeCapture(repoRoot: string, worktreePath: string): Promise<WorktreeCaptureBegin> {
  const canonicalPath = await validateWorktreeMembership(repoRoot, worktreePath);
  const fingerprint = await statusFingerprint(canonicalPath);
  const trackedPaths = await listTrackedPaths(canonicalPath);
  const headOid = await resolveHeadOidOrNull(canonicalPath);
  const contentFingerprint = await computeTrackedContentFingerprint(canonicalPath, trackedPaths);
  return { canonicalPath, fingerprint, trackedPaths, headOid, contentFingerprint };
}

export async function finishWorktreeCapture(begin: WorktreeCaptureBegin): Promise<CapturedState> {
  assertWithinCaptureLimits(begin.trackedPaths.length);
  const files = await Promise.all(
    begin.trackedPaths.map(async (path) => {
      const buffer = await readFile(resolve(begin.canonicalPath, path));
      assertContentWithinSizeLimit(buffer, path);
      return { path, content: decodeUtf8OrThrow(buffer, path) };
    }),
  );
  const afterFingerprint = await statusFingerprint(begin.canonicalPath);
  const afterHeadOid = await resolveHeadOidOrNull(begin.canonicalPath);
  const afterContentFingerprint = contentFingerprintFromEntries(files);
  if (
    afterFingerprint !== begin.fingerprint ||
    afterHeadOid !== begin.headOid ||
    afterContentFingerprint !== begin.contentFingerprint
  ) {
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
