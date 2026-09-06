import { describe, expect, it, vi } from "vitest";
import {
  DockerCleanupError,
  killAndVerifyContainer,
  type ContainerCleanupBudget,
  type ContainerCleanupDeps,
} from "../../src/execution/dockerRunner.js";

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
