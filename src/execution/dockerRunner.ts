import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type SnippetVariant = "original" | "current" | "draft";

/**
 * A single variant's Python source to execute. `content` is delivered to the container
 * exclusively via stdin (see {@link buildDockerRunArgs}) so no host path - readable or
 * writable - is ever bind-mounted; the container receives nothing but the interpreter
 * image itself and the bytes written to its stdin.
 */
export interface SnippetSource {
  variant: SnippetVariant;
  /** Posix-style path used only to classify eligibility; never mounted or read from disk. */
  path: string;
  content: string;
}

export interface RunLimits {
  /** Wall-clock bound enforced by this runner itself, independent of any Docker-side limit. */
  timeoutMs: number;
  memory: string;
  cpus: string;
  pids: number;
  tmpfsSize: string;
}

export interface RunOptions {
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  onOutput?: (channel: "stdout" | "stderr", data: string) => void;
}

export type RunResult =
  | { variant: SnippetVariant; kind: "success"; exitCode: number; stdout: string; stderr: string }
  | { variant: SnippetVariant; kind: "failure"; exitCode: number; stdout: string; stderr: string }
  | { variant: SnippetVariant; kind: "timeout"; timeoutMs: number; stdout: string; stderr: string }
  | { variant: SnippetVariant; kind: "cancelled"; stdout: string; stderr: string }
  | { variant: SnippetVariant; kind: "unavailable" };

/** Rejected during pre-flight policy validation before any Docker container is created. */
export class RunPolicyRejectedError extends Error {}

/** Raised when the Docker CLI itself cannot be invoked (e.g. missing binary, spawn failure). */
export class DockerRunError extends Error {}

/**
 * Raised when a container's forced termination could not be confirmed within the bounded
 * discovery/verification budget - i.e. the container was never found on the host, or
 * `docker kill` was issued but the container could not be confirmed stopped. This must
 * never be swallowed into a `timeout`/`cancelled` {@link RunResult}: those outcomes mean
 * "the sandbox boundary held and the container is gone", which is not something this
 * runner can honestly claim once cleanup could not be verified.
 */
export class DockerCleanupError extends Error {}

const ALLOWED_EXTENSION = ".py";
const CONTAINER_LABEL_KEY = "agent-change-map-run";
const DOCKER_IMAGE = "python:3.12-slim";
/** Numeric uid:gid of the image's built-in unprivileged "nobody" account. */
const NON_ROOT_USER = "65534:65534";
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
/**
 * Budget for locating the container by its unique label after `docker run` was spawned.
 * A fixed interval (rather than exponential backoff) is used because the expected delay
 * is bounded by the daemon's own container-registration latency, not by an open-ended
 * contention window; ~10s total gives a daemon under real load from the very workload
 * being killed (e.g. a fork bomb or CPU-bound snippet) a realistic chance to register the
 * container before this runner gives up and reports cleanup as unconfirmed.
 */
const DISCOVERY_POLL_INTERVAL_MS = 100;
const DISCOVERY_POLL_ATTEMPTS = 100;
/**
 * Budget for confirming that an issued `docker kill` actually stopped the container,
 * retrying the kill itself on every attempt in case the first signal was lost or the
 * container was still starting up. Same ~10s total budget and rationale as discovery.
 */
const VERIFY_POLL_INTERVAL_MS = 100;
const VERIFY_POLL_ATTEMPTS = 100;

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 10_000,
  memory: "256m",
  cpus: "0.5",
  pids: 64,
  tmpfsSize: "16m",
};

/**
 * Introspection round-trips only run `inspect.signature()` over already-imported code, so
 * they are bounded far more tightly than an ordinary snippet run (design D2).
 */
export const INTROSPECTION_TIMEOUT_MS = 5_000;

/** Merges `overrides` over the introspection-specific defaults - a 5s timeout instead of {@link DEFAULT_RUN_LIMITS}'s 10s - never the other way around. */
export function resolveIntrospectionLimits(overrides: Partial<RunLimits> = {}): RunLimits {
  return { ...DEFAULT_RUN_LIMITS, timeoutMs: INTROSPECTION_TIMEOUT_MS, ...overrides };
}

/**
 * Rejects any snippet that is not a genuine, directly-executable Python source file
 * before a Docker container is ever created. Only a plain `.py` path is eligible;
 * everything else - `requirements.txt`, `CMakeLists.txt`, an executable-bit `.md`/`.mdx`
 * file, `README.sh`, or any other extension - is refused here, ahead of any subprocess
 * spawn.
 */
export function assertEligibleForExecution(source: Pick<SnippetSource, "path">): void {
  if (typeof source.path !== "string" || source.path.length === 0) {
    throw new RunPolicyRejectedError("Snippet path must be a non-empty string");
  }
  if (!source.path.endsWith(ALLOWED_EXTENSION)) {
    throw new RunPolicyRejectedError(`Only ${ALLOWED_EXTENSION} source spans may be executed: ${source.path}`);
  }
}

/**
 * Builds the fixed Docker Engine `run` argv: no network, read-only root with a bounded
 * writable tmpfs scoped to `/tmp`, all Linux capabilities dropped, no privilege
 * escalation, a non-root user, and PID/CPU/memory bounds. The label is unique per
 * invocation so callers (and tests) can find and forcibly remove exactly this
 * container without matching any other container on the host.
 */
function buildDockerRunArgs(runId: string, limits: RunLimits): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,size=${limits.tmpfsSize},mode=1777`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    NON_ROOT_USER,
    "--pids-limit",
    String(limits.pids),
    "--cpus",
    limits.cpus,
    "--memory",
    limits.memory,
    "--label",
    `${CONTAINER_LABEL_KEY}=${runId}`,
    DOCKER_IMAGE,
    "python3",
    "-u",
    "-",
  ];
}

async function execDocker(args: string[]): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolveExec, reject) => {
    const proc = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.once("error", (error) => reject(new DockerRunError(`Failed to invoke: docker ${args.join(" ")}`, { cause: error })));
    proc.once("close", (code) => resolveExec({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code }));
  });
}

async function findContainerIdByLabel(runId: string): Promise<string | null> {
  const { stdout } = await execDocker(["ps", "-a", "--filter", `label=${CONTAINER_LABEL_KEY}=${runId}`, "--format", "{{.ID}}"]);
  const id = stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return id ?? null;
}

async function isContainerRunning(id: string): Promise<boolean> {
  const { stdout } = await execDocker(["inspect", "--format", "{{.State.Running}}", id]);
  return stdout.trim() === "true";
}

/**
 * The container-discovery/kill-verification steps, factored out behind an interface so
 * tests can inject deterministic fakes for "container never found" and "kill issued but
 * still running" scenarios without needing to overload a real Docker daemon (which would
 * be flaky). Production code always uses {@link defaultContainerCleanupDeps}.
 */
export interface ContainerCleanupDeps {
  findContainerId: (runId: string) => Promise<string | null>;
  killContainer: (id: string) => Promise<void>;
  isContainerRunning: (id: string) => Promise<boolean>;
}

const defaultContainerCleanupDeps: ContainerCleanupDeps = {
  findContainerId: findContainerIdByLabel,
  killContainer: async (id) => {
    await execDocker(["kill", id]);
  },
  isContainerRunning,
};

/** Poll attempt/interval budget, injectable so unit tests run in milliseconds instead of the real ~10s production budget. */
export interface ContainerCleanupBudget {
  discoveryAttempts: number;
  discoveryIntervalMs: number;
  verifyAttempts: number;
  verifyIntervalMs: number;
}

const DEFAULT_CLEANUP_BUDGET: ContainerCleanupBudget = {
  discoveryAttempts: DISCOVERY_POLL_ATTEMPTS,
  discoveryIntervalMs: DISCOVERY_POLL_INTERVAL_MS,
  verifyAttempts: VERIFY_POLL_ATTEMPTS,
  verifyIntervalMs: VERIFY_POLL_INTERVAL_MS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Forcibly terminates the container carrying this run's unique label and confirms the
 * kill actually took effect before returning. Polls for the container to appear (it may
 * not be listed yet immediately after creation), issues `docker kill`, then re-checks
 * `docker inspect` to confirm it actually stopped - retrying the kill within the same
 * bounded budget if it is still running. Killing only the local `docker run` client
 * process does not reliably propagate to a detached daemon-managed container, so this
 * never relies on that alone.
 *
 * If the container cannot be found, or a kill cannot be confirmed to have stopped it,
 * within the bounded budget, this throws {@link DockerCleanupError} rather than
 * returning normally - callers must never treat a normal return here as optional; an
 * unconfirmed cleanup must not be silently reported as a successful `timeout`/`cancelled`
 * run result.
 */
export async function killAndVerifyContainer(
  runId: string,
  deps: ContainerCleanupDeps = defaultContainerCleanupDeps,
  budget: ContainerCleanupBudget = DEFAULT_CLEANUP_BUDGET,
): Promise<void> {
  let id: string | null = null;
  for (let attempt = 0; attempt < budget.discoveryAttempts; attempt += 1) {
    id = await deps.findContainerId(runId).catch(() => null);
    if (id) break;
    await sleep(budget.discoveryIntervalMs);
  }
  if (!id) {
    throw new DockerCleanupError(
      `Could not locate container for run ${runId} within the discovery budget (${budget.discoveryAttempts} attempts / ${budget.discoveryIntervalMs}ms each); termination could not be confirmed`,
    );
  }

  for (let attempt = 0; attempt < budget.verifyAttempts; attempt += 1) {
    await deps.killContainer(id).catch(() => {});
    // An error from `isContainerRunning` (e.g. the daemon socket hiccupping on `docker
    // inspect`) must never be treated as "confirmed stopped" - that would resolve this
    // function successfully despite cleanup never actually being verified. Treat it the
    // same as "still running": keep retrying within budget, and fall through to
    // DockerCleanupError below if the budget is exhausted.
    const stillRunning = await deps.isContainerRunning(id).catch(() => true);
    if (!stillRunning) return;
    await sleep(budget.verifyIntervalMs);
  }

  throw new DockerCleanupError(
    `Issued docker kill for container ${id} (run ${runId}) but could not confirm it stopped within the verification budget (${budget.verifyAttempts} attempts / ${budget.verifyIntervalMs}ms each)`,
  );
}

function appendBounded(chunks: Buffer[], chunk: Buffer, budget: { usedBytes: number }): void {
  if (budget.usedBytes >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - budget.usedBytes;
  const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(bounded);
  budget.usedBytes += bounded.length;
}

/**
 * Runs one variant's Python source in a disposable, maximally isolated container: no
 * network, read-only root filesystem with a bounded `/tmp` tmpfs, all capabilities
 * dropped, no new privileges, a non-root user, and PID/CPU/memory bounds. Enforces its
 * own wall-clock timeout (in addition to Docker's own limits) and supports cooperative
 * cancellation via `options.signal`. The container is always removed afterward -
 * `--rm` handles the success/failure/exit path, and an explicit forced `docker kill`
 * targeting this run's unique label handles the timeout/cancellation path - verified via
 * {@link killAndVerifyContainer} before this function returns. If that verification
 * cannot confirm the container actually stopped, this rejects with
 * {@link DockerCleanupError} rather than returning a `timeout`/`cancelled` result that
 * would falsely claim no container from this runner was left behind on the host.
 */
export async function runSnippet(source: SnippetSource, options: RunOptions = {}): Promise<RunResult> {
  assertEligibleForExecution(source);
  if (options.signal?.aborted) return { variant: source.variant, kind: "cancelled", stdout: "", stderr: "" };
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...options.limits };
  const runId = randomUUID();
  const args = buildDockerRunArgs(runId, limits);
  const child = spawn("docker", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const budget = { usedBytes: 0 };
  // Docker's stream chunk boundaries are arbitrary byte boundaries, so decoding each
  // chunk independently corrupts a UTF-8 code point split across two events. Keep one
  // decoder per channel: stdout and stderr are independent byte streams and must never
  // share pending bytes.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const receive = (channel: "stdout" | "stderr", chunks: Buffer[], decoder: StringDecoder, chunk: Buffer): void => {
    const previous = budget.usedBytes;
    appendBounded(chunks, chunk, budget);
    const accepted = budget.usedBytes - previous;
    if (accepted > 0) {
      const text = decoder.write(chunk.subarray(0, accepted));
      if (text) options.onOutput?.(channel, text);
    }
  };
  const flushOutput = (): void => {
    const stdout = stdoutDecoder.end();
    if (stdout) options.onOutput?.("stdout", stdout);
    const stderr = stderrDecoder.end();
    if (stderr) options.onOutput?.("stderr", stderr);
  };
  child.stdout.on("data", (chunk: Buffer) => receive("stdout", stdoutChunks, stdoutDecoder, chunk));
  child.stderr.on("data", (chunk: Buffer) => receive("stderr", stderrChunks, stderrDecoder, chunk));

  child.stdin.write(source.content, "utf8");
  child.stdin.end();

  let closed = false;
  let outcomeKind: "timeout" | "cancelled" | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const terminate = (kind: "timeout" | "cancelled"): void => {
    if (closed || outcomeKind) return;
    outcomeKind = kind;
    cleanupPromise = killAndVerifyContainer(runId).finally(() => child.kill("SIGKILL"));
    // Suppress the default unhandled-rejection warning here; the same rejection is
    // re-thrown below via `await cleanupPromise` once the child process has closed.
    void cleanupPromise.catch(() => {});
  };

  const timer = setTimeout(() => terminate("timeout"), limits.timeoutMs);
  const onAbort = (): void => terminate("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolveClose, reject) => {
      child.once("error", (error) => {
        flushOutput();
        reject(new DockerRunError("Failed to start docker run", { cause: error }));
      });
      child.once("close", (code) => {
        closed = true;
        flushOutput();
        resolveClose(code);
      });
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  // If termination was requested, the cleanup promise has necessarily already settled by
  // this point (its `.finally` is what triggers `child.kill`, which precedes the child's
  // `close` event awaited above). Awaiting it here re-throws `DockerCleanupError` instead
  // of letting this function fall through to a `timeout`/`cancelled` result that would
  // falsely claim the sandbox boundary held.
  if (cleanupPromise) {
    await cleanupPromise;
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (outcomeKind === "timeout") return { variant: source.variant, kind: "timeout", timeoutMs: limits.timeoutMs, stdout, stderr };
  if (outcomeKind === "cancelled") return { variant: source.variant, kind: "cancelled", stdout, stderr };
  if (exitCode === 0) return { variant: source.variant, kind: "success", exitCode, stdout, stderr };
  return { variant: source.variant, kind: "failure", exitCode: exitCode ?? -1, stdout, stderr };
}

const ACM_SENTINEL = "<<ACM>>";

export interface IntrospectionParameter {
  name: string;
  kind?: string;
  annotation?: string | null;
  defaultRepr?: string | null;
  required?: boolean;
}

export type IntrospectionOutcome =
  | { kind: "signatureResult"; parameters: IntrospectionParameter[] }
  | { kind: "signatureUnavailable"; reason: string };

/**
 * Scans `stdout` for lines beginning with the `<<ACM>>` sentinel and returns the JSON
 * payload of only the *final* matching line. Earlier matches are ignored on purpose:
 * attacker-controlled `print()` output inside the introspected/called code could forge an
 * earlier sentinel-prefixed line, but it cannot control what this runner appends *after*
 * its own real result frame, so the last match is always the authoritative one.
 */
function parseAcmFrame(stdout: string): unknown {
  let lastPayload: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(ACM_SENTINEL)) {
      lastPayload = line.slice(ACM_SENTINEL.length);
    }
  }
  if (lastPayload === undefined) return undefined;
  try {
    return JSON.parse(lastPayload);
  } catch {
    return undefined;
  }
}

function isIntrospectionFrame(value: unknown): value is { ok: true; parameters: IntrospectionParameter[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    Array.isArray((value as { parameters?: unknown }).parameters)
  );
}

const MAX_REASON_DETAIL_LENGTH = 500;

/** Formats a non-success `RunResult` as a `reason` string that carries actual diagnostic
 * detail (the sandboxed process's own stderr/stdout, truncated) rather than just its bare
 * `kind` ("failure"/"timeout"/"cancelled") - the earlier bare-kind reason gave the UI (and
 * whoever is debugging it) no way to tell an ImportError from a syntax error from a genuine
 * timeout. */
function describeRunFailure(result: Exclude<RunResult, { kind: "success" }>): string {
  if (result.kind === "unavailable") return result.kind;
  const detail = (result.stderr || result.stdout).trim();
  if (!detail) return result.kind;
  const truncated = detail.length > MAX_REASON_DETAIL_LENGTH ? `${detail.slice(0, MAX_REASON_DETAIL_LENGTH)}…` : detail;
  return `${result.kind}: ${truncated}`;
}

function toIntrospectionOutcome(result: RunResult): IntrospectionOutcome {
  if (result.kind !== "success") {
    return { kind: "signatureUnavailable", reason: describeRunFailure(result) };
  }
  const frame = parseAcmFrame(result.stdout);
  if (!isIntrospectionFrame(frame)) {
    return { kind: "signatureUnavailable", reason: "malformed or absent <<ACM>> introspection frame" };
  }
  return { kind: "signatureResult", parameters: frame.parameters };
}

/**
 * Thin wrapper over {@link runSnippet}: same hardened argv, same sandbox flags, same
 * `assertEligibleForExecution` pre-spawn guard - only the timeout is tightened to
 * {@link INTROSPECTION_TIMEOUT_MS} and the result is parsed out of the `<<ACM>>` sentinel
 * frame instead of returned as a raw {@link RunResult}. Never throws on a malformed or
 * absent frame; that shape is reported as `signatureUnavailable` instead.
 */
export async function runIntrospection(source: SnippetSource, options: RunOptions = {}): Promise<IntrospectionOutcome> {
  const limits = resolveIntrospectionLimits(options.limits);
  const result = await runSnippet(source, { ...options, limits });
  return toIntrospectionOutcome(result);
}

/**
 * The outcome of a `runCall()` invocation. `result` always carries the full
 * {@link RunResult} - same shape as an ordinary snippet run, including `success`/
 * `failure`/`timeout`/`cancelled` - so a raised exception surfaces exactly like a run
 * failure (captured stderr, non-zero exit). `returnRepr` is present only when the run
 * succeeded and the `<<ACM>>` sentinel frame parsed as a well-formed call result.
 */
export interface CallOutcome {
  result: RunResult;
  returnRepr?: string;
}

function isCallFrame(value: unknown): value is { ok: true; repr: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { repr?: unknown }).repr === "string"
  );
}

/**
 * Thin wrapper over {@link runSnippet}: same hardened argv, same sandbox flags, same
 * `assertEligibleForExecution` pre-spawn guard, ordinary {@link DEFAULT_RUN_LIMITS}
 * timeout (a call may legitimately take longer than a 5s introspection round-trip).
 * Never throws on a malformed or absent `<<ACM>>` frame; that shape is simply reported
 * without a `returnRepr`, leaving `result` (success/failure/timeout/cancelled) as the
 * authoritative outcome - a target that raised inside the driver surfaces as an ordinary
 * `failure` result with its captured stderr, not a thrown error from this function.
 */
export async function runCall(source: SnippetSource, options: RunOptions = {}): Promise<CallOutcome> {
  const result = await runSnippet(source, options);
  if (result.kind !== "success") return { result };
  const frame = parseAcmFrame(result.stdout);
  if (!isCallFrame(frame)) return { result };
  return { result, returnRepr: frame.repr };
}

/**
 * Runs each available variant under equivalent restrictions and labels every result by
 * variant. A variant with no source is reported as `unavailable` rather than being
 * synthesized or silently skipped.
 */
export async function runVariants(
  sources: Partial<Record<SnippetVariant, SnippetSource>>,
  options: RunOptions = {},
): Promise<RunResult[]> {
  const variants: SnippetVariant[] = ["original", "current", "draft"];
  const results: RunResult[] = [];
  for (const variant of variants) {
    const source = sources[variant];
    if (!source) {
      results.push({ variant, kind: "unavailable" });
      continue;
    }
    results.push(await runSnippet(source, options));
  }
  return results;
}
