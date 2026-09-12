import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import {
  DockerCleanupError,
  INTROSPECTION_TIMEOUT_MS,
  assertEligibleForExecution,
  resolveIntrospectionLimits,
  runIntrospection,
  killAndVerifyContainer,
  type ContainerCleanupBudget,
  type ContainerCleanupDeps,
} from "../../src/execution/dockerRunner.js";

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

/**
 * Real Docker-daemon overload isn't reliably reproducible in a test without flakiness, so
 * these exercise `killAndVerifyContainer` directly against injected fake
 * discovery/kill/verify dependencies - the same dependency-injection technique this
 * project already uses for `node:fs/promises` in `writeGuard.test.ts`, applied here via a
 * first-class swappable `ContainerCleanupDeps` parameter instead of `vi.mock`.
 */

const FAST_BUDGET: ContainerCleanupBudget = {
  discoveryAttempts: 3,
  discoveryIntervalMs: 1,
  verifyAttempts: 3,
  verifyIntervalMs: 1,
};

function makeDeps(overrides: Partial<ContainerCleanupDeps> = {}): ContainerCleanupDeps {
  return {
    findContainerId: vi.fn(async () => "container-id"),
    killContainer: vi.fn(async () => {}),
    isContainerRunning: vi.fn(async () => false),
    ...overrides,
  };
}

describe("killAndVerifyContainer", () => {
  it("kills and confirms the container stopped when it is found and the kill takes effect", async () => {
    const deps = makeDeps();

    await expect(killAndVerifyContainer("run-ok", deps, FAST_BUDGET)).resolves.toBeUndefined();

    expect(deps.killContainer).toHaveBeenCalledWith("container-id");
  });

  it("throws DockerCleanupError instead of silently returning when the container is never found within budget", async () => {
    const deps = makeDeps({ findContainerId: vi.fn(async () => null) });

    await expect(killAndVerifyContainer("run-not-found", deps, FAST_BUDGET)).rejects.toThrow(DockerCleanupError);
    expect(deps.killContainer).not.toHaveBeenCalled();
  });

  it("retries the kill within budget and throws DockerCleanupError instead of silently returning when the container never stops", async () => {
    const deps = makeDeps({ isContainerRunning: vi.fn(async () => true) });

    await expect(killAndVerifyContainer("run-stuck", deps, FAST_BUDGET)).rejects.toThrow(DockerCleanupError);
    expect((deps.killContainer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(FAST_BUDGET.verifyAttempts);
  });

  it("succeeds after retrying the kill when the container stops on a later verification attempt", async () => {
    let checkCount = 0;
    const deps = makeDeps({
      isContainerRunning: vi.fn(async () => {
        checkCount += 1;
        return checkCount < 2;
      }),
    });

    await expect(killAndVerifyContainer("run-eventually-stops", deps, FAST_BUDGET)).resolves.toBeUndefined();
    expect((deps.killContainer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("throws DockerCleanupError instead of silently resolving when isContainerRunning itself keeps erroring", async () => {
    const deps = makeDeps({
      isContainerRunning: vi.fn(async () => {
        throw new Error("docker inspect: daemon socket hiccup");
      }),
    });

    await expect(killAndVerifyContainer("run-inspect-erroring", deps, FAST_BUDGET)).rejects.toThrow(DockerCleanupError);
    expect((deps.killContainer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(FAST_BUDGET.verifyAttempts);
  });
});

describe("runIntrospection", () => {
  it("delegates to the same hardened argv builder as runSnippet (no new sandbox invocation path)", async () => {
    spawn.mockClear();
    const child = makeChild();
    spawn.mockReturnValue(child);

    const pending = runIntrospection({ variant: "current", path: "m.py", content: "def f(): pass" });
    child.emit("close", 0);
    await pending;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, spawnOptions] = spawn.mock.calls[0];
    expect(command).toBe("docker");
    expect(args).toEqual(
      expect.arrayContaining(["run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]),
    );
    expect(args.slice(-3)).toEqual(["python3", "-u", "-"]);
    expect(spawnOptions).toMatchObject({ shell: false });
  });

  it("uses a 5s short timeout for introspection, not DEFAULT_RUN_LIMITS", () => {
    expect(INTROSPECTION_TIMEOUT_MS).toBe(5_000);
    expect(resolveIntrospectionLimits().timeoutMs).toBe(5_000);
    expect(resolveIntrospectionLimits({ timeoutMs: 1_234 }).timeoutMs).toBe(1_234);
  });

  it("parses a <<ACM>> sentinel line into a structured signature result", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const pending = runIntrospection({ variant: "current", path: "m.py", content: "def f(a): pass" });
    child.stdout.emit("data", Buffer.from('<<ACM>>{"ok":true,"parameters":[{"name":"a"}]}\n'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ kind: "signatureResult", parameters: [{ name: "a" }] });
  });

  it("treats only the final matching <<ACM>> line as authoritative when multiple lines match the sentinel prefix", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const pending = runIntrospection({ variant: "current", path: "m.py", content: "def f(): pass" });
    child.stdout.emit(
      "data",
      Buffer.from('<<ACM>>{"ok":true,"parameters":[{"name":"fabricated"}]}\n<<ACM>>{"ok":true,"parameters":[{"name":"real"}]}\n'),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ kind: "signatureResult", parameters: [{ name: "real" }] });
  });

  it("returns a signatureUnavailable-shaped result, not a thrown error, when the <<ACM>> frame is absent", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const pending = runIntrospection({ variant: "current", path: "m.py", content: "def f(): pass" });
    child.stdout.emit("data", Buffer.from("no sentinel here\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ kind: "signatureUnavailable", reason: expect.any(String) });
  });

  it("returns a signatureUnavailable-shaped result, not a thrown error, when the <<ACM>> frame is malformed JSON", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const pending = runIntrospection({ variant: "current", path: "m.py", content: "def f(): pass" });
    child.stdout.emit("data", Buffer.from("<<ACM>>{not valid json\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ kind: "signatureUnavailable", reason: expect.any(String) });
  });

  it("rejects a non-.py target before any container spawn", async () => {
    spawn.mockClear();

    await expect(runIntrospection({ variant: "current", path: "requirements.txt", content: "flask==1.0" })).rejects.toThrow();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("still enforces assertEligibleForExecution as the pre-spawn guard (not weakened)", () => {
    expect(() => assertEligibleForExecution({ path: "README.sh" })).toThrow();
  });
});
