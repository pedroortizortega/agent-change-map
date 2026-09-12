import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runSnippet, runVariants, type RunResult } from "../../../src/execution/dockerRunner.js";

/**
 * These tests spawn real, maximally-isolated Docker containers and deliberately attempt
 * dangerous operations - network access, filesystem escape, fork bombs - strictly
 * *inside* the container under test, to prove the isolation holds. Nothing dangerous
 * ever runs on the host.
 */

function listLeakedContainers(): string[] {
  const output = execFileSync("docker", ["ps", "-a", "--filter", "label=agent-change-map-run", "--format", "{{.ID}}"]).toString();
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertNoLeakedContainers(): Promise<void> {
  const deadlineMs = Date.now() + 5_000;
  let leaked = listLeakedContainers();
  while (leaked.length > 0 && Date.now() < deadlineMs) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    leaked = listLeakedContainers();
  }
  expect(leaked, `expected no leaked agent-change-map-run containers, found: ${leaked.join(", ")}`).toEqual([]);
}

afterEach(async () => {
  await assertNoLeakedContainers();
});

function expectVariant(result: RunResult, variant: RunResult["variant"]): void {
  expect(result.variant).toBe(variant);
}

describe("dockerRunner restricted execution (real Docker)", () => {
  it("blocks outbound network access by default", async () => {
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: [
        "import socket",
        "try:",
        "    socket.create_connection(('8.8.8.8', 53), timeout=2)",
        "    print('NETWORK_REACHABLE')",
        "except OSError:",
        "    print('NETWORK_BLOCKED')",
      ].join("\n"),
    });

    expectVariant(result, "current");
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).toContain("NETWORK_BLOCKED");
      expect(result.stdout).not.toContain("NETWORK_REACHABLE");
    }
  }, 20_000);

  it("enforces a read-only root filesystem with only a bounded writable tmpfs at /tmp", async () => {
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: [
        "try:",
        "    open('/escaped.txt', 'w').write('x')",
        "    print('ESCAPE_SUCCEEDED')",
        "except OSError:",
        "    print('ESCAPE_BLOCKED')",
        "with open('/tmp/inside.txt', 'w') as handle:",
        "    handle.write('ok')",
        "print('TMPFS_WRITE_OK', open('/tmp/inside.txt').read())",
      ].join("\n"),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).toContain("ESCAPE_BLOCKED");
      expect(result.stdout).toContain("TMPFS_WRITE_OK ok");
    }
  }, 20_000);

  it("drops capabilities so CAP_NET_RAW-gated raw sockets cannot be created", async () => {
    // Creating a raw socket requires CAP_NET_RAW in the process's effective capability
    // set. --cap-drop=ALL removes it from the container's capability set entirely, so
    // this must fail with PermissionError regardless of the (dropped) network mode.
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: [
        "import socket",
        "try:",
        "    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)",
        "    print('RAW_SOCKET_SUCCEEDED')",
        "except PermissionError:",
        "    print('RAW_SOCKET_BLOCKED')",
      ].join("\n"),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).toContain("RAW_SOCKET_BLOCKED");
    }
  }, 20_000);

  it("runs as a non-root user (privilege bound)", async () => {
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: "import os\nprint('UID', os.getuid())",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).toContain("UID 65534");
    }
  }, 20_000);

  it("stops a fork bomb at the configured PID limit", async () => {
    const result = await runSnippet(
      {
        variant: "current",
        path: "probe.py",
        content: [
          "import os, time",
          "count = 0",
          "try:",
          "    while True:",
          "        pid = os.fork()",
          "        if pid == 0:",
          "            time.sleep(3)",
          "            os._exit(0)",
          "        count += 1",
          "except OSError:",
          "    print('PID_LIMIT_HIT')",
        ].join("\n"),
      },
      { limits: { pids: 16 } },
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).toContain("PID_LIMIT_HIT");
    }
  }, 20_000);

  it("kills the container when it exceeds the memory limit", async () => {
    const result = await runSnippet(
      {
        variant: "current",
        path: "probe.py",
        content: "data = bytearray(300 * 1024 * 1024)\nprint('SHOULD_NOT_PRINT', len(data))",
      },
      { limits: { memory: "64m" } },
    );

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SHOULD_NOT_PRINT");
    }
  }, 20_000);

  // `killAndVerifyContainer`'s worst-case cleanup latency is the discovery budget
  // (DISCOVERY_POLL_ATTEMPTS=100 * DISCOVERY_POLL_INTERVAL_MS=100ms = 10_000ms) plus the
  // verify budget (VERIFY_POLL_ATTEMPTS=100 * VERIFY_POLL_INTERVAL_MS=100ms = 10_000ms),
  // i.e. ~20_000ms, on top of however long it takes `runSnippet` to decide to terminate
  // (its own `timeoutMs`, or the abort-trigger delay in the cancellation test below). Both
  // bounds below are: (that decision delay) + (~20_000ms cleanup budget) + a safety margin
  // to absorb real daemon-load jitter, so a slow-but-still-correct cleanup under load isn't
  // mistaken for a bug. If DISCOVERY_/VERIFY_POLL_ATTEMPTS or *_INTERVAL_MS ever change in
  // dockerRunner.ts, these bounds must be revisited alongside them.
  it("kills and removes the container after the enforced wall-clock timeout", async () => {
    const started = Date.now();
    const result = await runSnippet(
      { variant: "current", path: "probe.py", content: "import time\ntime.sleep(30)\nprint('SHOULD_NOT_PRINT')" },
      { limits: { timeoutMs: 1_000 } },
    );
    const elapsedMs = Date.now() - started;

    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.timeoutMs).toBe(1_000);
      expect(result.stdout).not.toContain("SHOULD_NOT_PRINT");
    }
    // 1_000ms (timer fires) + 20_000ms (worst-case cleanup budget) + 9_000ms margin = 30_000ms.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 35_000);

  it("stops and removes the container on explicit cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    const runPromise = runSnippet(
      { variant: "current", path: "probe.py", content: "import time\ntime.sleep(30)\nprint('SHOULD_NOT_PRINT')" },
      { limits: { timeoutMs: 25_000 }, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 500);

    const result = await runPromise;
    expect(result.kind).toBe("cancelled");
    if (result.kind === "cancelled") {
      expect(result.stdout).not.toContain("SHOULD_NOT_PRINT");
    }
    // 500ms (abort trigger) + 20_000ms (worst-case cleanup budget) + 14_500ms margin = 35_000ms.
  }, 35_000);

  it("reports a non-zero exit as a failure result", async () => {
    const result = await runSnippet({
      variant: "draft",
      path: "probe.py",
      content: "raise RuntimeError('boom')",
    });

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("RuntimeError");
    }
  }, 20_000);

  it("bounds captured output instead of buffering unbounded stdout", async () => {
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: "for _ in range(20000):\n    print('x' * 200)",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    }
  }, 30_000);

  it("refuses to execute and identifies the unsatisfied restriction when Docker rejects an invalid resource limit", async () => {
    const result = await runSnippet(
      { variant: "current", path: "probe.py", content: "print('SHOULD_NOT_RUN')" },
      { limits: { cpus: "not-a-number" } },
    );

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it("labels each variant result and reports a missing variant as unavailable rather than synthesizing it", async () => {
    const results = await runVariants({
      original: { variant: "original", path: "a.py", content: "print('ORIGINAL_OK')" },
      current: { variant: "current", path: "a.py", content: "raise RuntimeError('CURRENT_BROKEN')" },
    });

    expect(results).toHaveLength(3);
    const original = results.find((result) => result.variant === "original");
    const current = results.find((result) => result.variant === "current");
    const draft = results.find((result) => result.variant === "draft");

    expect(original?.kind).toBe("success");
    expect(current?.kind).toBe("failure");
    expect(draft?.kind).toBe("unavailable");
  }, 30_000);

  it("passes the snippet source only via stdin, never as a host mount", async () => {
    const result = await runSnippet({
      variant: "current",
      path: "probe.py",
      content: "import os\nprint('ROOT_LISTING', sorted(os.listdir('/')))",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdout).not.toMatch(/probe\.py/);
    }
  }, 20_000);
});
