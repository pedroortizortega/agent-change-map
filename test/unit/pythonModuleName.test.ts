import { describe, expect, it } from "vitest";
import { mapPathsToModules, type PythonModuleEntry } from "../../src/execution/pythonModuleName.js";

function byName(entries: PythonModuleEntry[]): Record<string, PythonModuleEntry> {
  const out: Record<string, PythonModuleEntry> = {};
  for (const entry of entries) {
    out[entry.dottedName] = entry;
  }
  return out;
}

describe("mapPathsToModules", () => {
  it("maps a flat file at the root to its own name, not a package", () => {
    const result = mapPathsToModules(["foo.py"]);
    expect(result).toEqual([{ dottedName: "foo", posixPath: "foo.py", isPackage: false }]);
  });

  it("maps a package member through the package when __init__.py is present", () => {
    const result = mapPathsToModules(["pkg/mod.py", "pkg/__init__.py"]);
    const map = byName(result);
    expect(map["pkg"]).toEqual({ dottedName: "pkg", posixPath: "pkg/__init__.py", isPackage: true });
    expect(map["pkg.mod"]).toEqual({ dottedName: "pkg.mod", posixPath: "pkg/mod.py", isPackage: false });
    expect(result).toHaveLength(2);
  });

  it("maps a package's own __init__.py alone to the package name", () => {
    const result = mapPathsToModules(["pkg/__init__.py"]);
    expect(result).toEqual([{ dottedName: "pkg", posixPath: "pkg/__init__.py", isPackage: true }]);
  });

  it("resolves nested multi-level packages when every intermediate __init__.py is present", () => {
    const result = mapPathsToModules(["a/b/c.py", "a/__init__.py", "a/b/__init__.py"]);
    const map = byName(result);
    expect(map["a"]).toEqual({ dottedName: "a", posixPath: "a/__init__.py", isPackage: true });
    expect(map["a.b"]).toEqual({ dottedName: "a.b", posixPath: "a/b/__init__.py", isPackage: true });
    expect(map["a.b.c"]).toEqual({ dottedName: "a.b.c", posixPath: "a/b/c.py", isPackage: false });
    expect(result).toHaveLength(3);
  });

  it("excludes a file whose directory is missing __init__.py from the output entirely", () => {
    const result = mapPathsToModules(["pkg/mod.py"]);
    expect(result).toEqual([]);
  });

  it("excludes non-identifier directory or file segments", () => {
    const digitDir = mapPathsToModules(["1pkg/mod.py", "1pkg/__init__.py"]);
    expect(digitDir).toEqual([]);

    const hyphenDir = mapPathsToModules(["my-pkg/mod.py", "my-pkg/__init__.py"]);
    expect(hyphenDir).toEqual([]);

    const hyphenFile = mapPathsToModules(["my-mod.py"]);
    expect(hyphenFile).toEqual([]);

    const digitFile = mapPathsToModules(["1mod.py"]);
    expect(digitFile).toEqual([]);
  });

  it("prefers the package on a pkg.py vs pkg/__init__.py collision", () => {
    const result = mapPathsToModules(["pkg.py", "pkg/__init__.py"]);
    expect(result).toEqual([{ dottedName: "pkg", posixPath: "pkg/__init__.py", isPackage: true }]);
  });

  it("returns an empty array for empty input", () => {
    expect(mapPathsToModules([])).toEqual([]);
  });

  it("skips a root-level __init__.py rather than emitting an empty dotted name", () => {
    const result = mapPathsToModules(["__init__.py"]);
    expect(result).toEqual([]);
  });

  it("sorts the output by dottedName", () => {
    const result = mapPathsToModules(["z.py", "a.py", "pkg/__init__.py", "pkg/mod.py"]);
    expect(result.map((entry) => entry.dottedName)).toEqual(["a", "pkg", "pkg.mod", "z"]);
  });
});
