import { describe, expect, it } from "vitest";
import { diffLines } from "../../src/diff/lineDiff.js";

const offsets = { leftStartLine: 1, rightStartLine: 1 };

describe("diffLines", () => {
  it("classifies identical sides as entirely unchanged", () => {
    const content = "a\nb\nc\n";
    expect(diffLines(content, content, offsets)).toEqual([
      { op: "unchanged", leftLine: 1, rightLine: 1, text: "a" },
      { op: "unchanged", leftLine: 2, rightLine: 2, text: "b" },
      { op: "unchanged", leftLine: 3, rightLine: 3, text: "c" },
    ]);
  });

  it("classifies a pure insertion", () => {
    const left = "a\nc\n";
    const right = "a\nb\nc\n";
    expect(diffLines(left, right, offsets)).toEqual([
      { op: "unchanged", leftLine: 1, rightLine: 1, text: "a" },
      { op: "added", rightLine: 2, text: "b" },
      { op: "unchanged", leftLine: 2, rightLine: 3, text: "c" },
    ]);
  });

  it("classifies a pure deletion", () => {
    const left = "a\nb\nc\n";
    const right = "a\nc\n";
    expect(diffLines(left, right, offsets)).toEqual([
      { op: "unchanged", leftLine: 1, rightLine: 1, text: "a" },
      { op: "removed", leftLine: 2, text: "b" },
      { op: "unchanged", leftLine: 3, rightLine: 2, text: "c" },
    ]);
  });

  it("marks every line added when the left side is empty", () => {
    const right = "a\nb\n";
    expect(diffLines("", right, offsets)).toEqual([
      { op: "added", rightLine: 1, text: "a" },
      { op: "added", rightLine: 2, text: "b" },
    ]);
  });

  it("marks every line removed when the right side is empty", () => {
    const left = "a\nb\n";
    expect(diffLines(left, "", offsets)).toEqual([
      { op: "removed", leftLine: 1, text: "a" },
      { op: "removed", leftLine: 2, text: "b" },
    ]);
  });

  it("reflects non-1 leftStartLine/rightStartLine offsets in leftLine/rightLine", () => {
    const left = "a\nb\n";
    const right = "a\nc\n";
    expect(diffLines(left, right, { leftStartLine: 10, rightStartLine: 20 })).toEqual([
      { op: "unchanged", leftLine: 10, rightLine: 20, text: "a" },
      { op: "removed", leftLine: 11, text: "b" },
      { op: "added", rightLine: 21, text: "c" },
    ]);
  });

  it("drops a single trailing empty line, matching the existing contentLines semantics", () => {
    expect(diffLines("a\n", "a\n", offsets)).toEqual([{ op: "unchanged", leftLine: 1, rightLine: 1, text: "a" }]);
    expect(diffLines("a", "a", offsets)).toEqual([{ op: "unchanged", leftLine: 1, rightLine: 1, text: "a" }]);
  });
});
