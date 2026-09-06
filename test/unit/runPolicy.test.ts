import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from "node:child_process";
import { assertEligibleForExecution, runSnippet, RunPolicyRejectedError } from "../../src/execution/dockerRunner.js";

describe("execution run policy", () => {
  it("rejects requirements.txt without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "requirements.txt" })).toThrow(RunPolicyRejectedError);
  });

  it("rejects CMakeLists.txt without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "CMakeLists.txt" })).toThrow(RunPolicyRejectedError);
  });

  it("rejects an executable .md file without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "notes.md" })).toThrow(RunPolicyRejectedError);
  });

  it("rejects an executable .mdx file without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "notes.mdx" })).toThrow(RunPolicyRejectedError);
  });

  it("rejects README.sh without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "README.sh" })).toThrow(RunPolicyRejectedError);
  });

  it("rejects an empty path without creating a Docker container", () => {
    expect(() => assertEligibleForExecution({ path: "" })).toThrow(RunPolicyRejectedError);
  });

  it("accepts a valid .py path", () => {
    expect(() => assertEligibleForExecution({ path: "src/module.py" })).not.toThrow();
  });

  it("rejects a non-.py snippet end-to-end through runSnippet without spawning docker", async () => {
    vi.mocked(spawn).mockClear();

    await expect(
      runSnippet({ variant: "current", path: "requirements.txt", content: "flask==1.0\n" }),
    ).rejects.toThrow(RunPolicyRejectedError);

    expect(spawn).not.toHaveBeenCalled();
  });
});
