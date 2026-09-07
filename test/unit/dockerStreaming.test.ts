import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { runSnippet } from "../../src/execution/dockerRunner.js";
it("forwards Docker output before child exit and enables unbuffered Python", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const onOutput = vi.fn();
  let complete = false;
  const pending = runSnippet({ variant: "current", path: "m.py", content: "print('early')" }, { onOutput }).then(result => { complete = true; return result; });
  child.stdout.emit("data", Buffer.from("early"));
  expect(onOutput).toHaveBeenCalledWith("stdout", "early");
  expect(complete).toBe(false);
  expect(spawn.mock.calls[0][1].slice(-3)).toEqual(["python3", "-u", "-"]);
  child.emit("close", 0);
  expect(await pending).toMatchObject({ kind: "success", stdout: "early" });
});

it("preserves split UTF-8 code points in streamed stdout and stderr callbacks", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const onOutput = vi.fn();
  const pending = runSnippet({ variant: "current", path: "m.py", content: "print('é')" }, { onOutput });

  child.stdout.emit("data", Buffer.from([0xc3]));
  child.stdout.emit("data", Buffer.from([0xa9]));
  child.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
  child.stderr.emit("data", Buffer.from([0x9a, 0x80]));
  child.emit("close", 0);

  await expect(pending).resolves.toMatchObject({ kind: "success", stdout: "é", stderr: "🚀" });
  expect(onOutput.mock.calls).toEqual([["stdout", "é"], ["stderr", "🚀"]]);
});
