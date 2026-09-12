import { describe, expect, it } from "vitest";
import { createSourceFileMatcher, defaultSourceFileMatcher } from "../../src/analysis/sourceFileMatcher.js";

describe("sourceFileMatcher", () => {
  it("matches .py case-insensitively and excludes non-.py extensions and mid-string occurrences", () => {
    expect(defaultSourceFileMatcher.matches("a.py")).toBe(true);
    expect(defaultSourceFileMatcher.matches("a.PY")).toBe(true);
    expect(defaultSourceFileMatcher.matches("a.pyc")).toBe(false);
    expect(defaultSourceFileMatcher.matches("a.txt")).toBe(false);
    expect(defaultSourceFileMatcher.matches("a")).toBe(false);
    expect(defaultSourceFileMatcher.matches("a.python.txt")).toBe(false);
  });

  it("createSourceFileMatcher supports multiple extensions without pipeline rework", () => {
    const matcher = createSourceFileMatcher([".py", ".sql"]);
    expect(matcher.matches("a.py")).toBe(true);
    expect(matcher.matches("a.sql")).toBe(true);
    expect(matcher.matches("a.txt")).toBe(false);
  });
});
