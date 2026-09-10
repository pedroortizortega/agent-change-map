import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findThemeContributor,
  resolveIncludeChain,
  resolveThemeDocument,
  stripJsonc,
  type ExtensionLike,
} from "../../src/theme/themeResolver.js";

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "themes");

/** {@link ReadFileFn}-shaped seam over the real filesystem, decoding as UTF-8. */
const readFixtureFile = (path: string) => readFile(path, "utf8");

async function loadBuiltinExtension(): Promise<ExtensionLike> {
  const raw = await readFile(join(FIXTURES_DIR, "builtin-package.json"), "utf8");
  const packageJSON = JSON.parse(raw) as ExtensionLike["packageJSON"];
  return { extensionPath: FIXTURES_DIR, packageJSON };
}

describe("findThemeContributor", () => {
  it("matches a built-in theme by id even though its label is an unresolved NLS placeholder", async () => {
    const extension = await loadBuiltinExtension();

    const match = findThemeContributor([extension], "Dark Modern");

    expect(match).toEqual({ extensionPath: FIXTURES_DIR, themePath: "./dark-modern.json" });
  });

  it("does not match by label alone (the built-in label is an NLS placeholder, not a real theme name)", async () => {
    const extension = await loadBuiltinExtension();

    const match = findThemeContributor([extension], "%darkPlusColorThemeLabel%");

    expect(match).toBeUndefined();
  });

  it("returns undefined when no installed extension contributes the requested theme id", async () => {
    const extension = await loadBuiltinExtension();

    const match = findThemeContributor([extension], "Some Theme Nobody Has Installed");

    expect(match).toBeUndefined();
  });
});

describe("resolveIncludeChain", () => {
  it("resolves and merges a multi-level include chain (dark-modern -> dark-plus -> dark-vs), child wins over ancestor", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "dark-modern.json"), readFixtureFile);

    expect(doc).toBeDefined();
    // dark-plus overrides the class-scope color from dark-vs.
    const tokenColors = doc!.tokenColors as Array<{ scope: string[]; settings: { foreground: string } }>;
    const classRule = tokenColors.find((rule) => rule.scope.includes("entity.name.type.class"));
    expect(classRule?.settings.foreground).toBe("#4EC9B0FF");
  });

  it("yields colors from an include ancestor when the child level defines none of its own", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "dark-modern.json"), readFixtureFile);

    // dark-modern.json itself defines neither tokenColors nor semanticTokenColors.
    expect(doc!.semanticTokenColors).toBeDefined();
    expect((doc!.semanticTokenColors as Record<string, unknown>).newOperator).toBeDefined();
  });

  it("does not infinite-loop on an include cycle and degrades to undefined instead of hanging or throwing", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "cycle-a.json"), readFixtureFile);

    expect(doc).toBeUndefined();
  });

  it("stops at the include-chain depth cap (5) and degrades to undefined rather than resolving past it", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "depth-1.json"), readFixtureFile);

    expect(doc).toBeUndefined();
  });

  it("resolves each include path relative to the INCLUDING file's directory, not the root or cwd", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "nested", "parent.json"), readFixtureFile);

    // Neither parent.json nor child.json define their own tokenColors, so a successfully
    // resolved doc can only have reached them via sibling.json - which is only reachable
    // if child.json's "../sibling.json" is resolved relative to child.json's OWN
    // directory (`nested/child/`), not the resolver's cwd or the root fixture dir (either
    // of which would fail to find the file and degrade the whole chain to undefined).
    expect(doc).toBeDefined();
    const tokenColors = doc!.tokenColors as Array<{ scope: string }>;
    expect(tokenColors.some((rule) => rule.scope === "marker.from.sibling")).toBe(true);
  });

  it("returns undefined for a missing or unreadable theme file", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "does-not-exist.json"), readFixtureFile);

    expect(doc).toBeUndefined();
  });

  it("resolves a JSONC theme file (line/block comments, trailing commas) into valid, comment-free JSON", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "jsonc-comments.json"), readFixtureFile);

    expect(doc).toBeDefined();
    const tokenColors = doc!.tokenColors as Array<{ scope: string; settings: { foreground: string } }>;
    expect(tokenColors).toHaveLength(2);
    expect(tokenColors[0]?.settings.foreground).toBe("#ABCDEF");
  });

  it("preserves comment-like and trailing-comma-like sequences that are inside string literals of the JSONC fixture", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "jsonc-comments.json"), readFixtureFile);

    const tokenColors = doc!.tokenColors as Array<{ scope: string }>;
    expect(tokenColors[0]?.scope).toBe("source.python //not-a-comment");
    expect(tokenColors[1]?.scope).toBe("string.quoted /* not a real block comment */ end");
  });
});

describe("stripJsonc", () => {
  it("strips // line comments and /* */ block comments outside strings", () => {
    const input = '{\n  // a comment\n  "a": 1, /* inline */\n  "b": 2\n}';

    const stripped = stripJsonc(input);

    expect(JSON.parse(stripped)).toEqual({ a: 1, b: 2 });
  });

  it("strips trailing commas in objects and arrays", () => {
    const input = '{ "a": [1, 2, 3,], "b": 4, }';

    const stripped = stripJsonc(input);

    expect(JSON.parse(stripped)).toEqual({ a: [1, 2, 3], b: 4 });
  });

  it("does NOT strip a comment-like sequence inside a string literal", () => {
    const input = '{ "scope": "source.python //not-a-comment and /* not-a-block */" }';

    const stripped = stripJsonc(input);

    expect(JSON.parse(stripped)).toEqual({ scope: "source.python //not-a-comment and /* not-a-block */" });
  });

  it("does NOT terminate a string early on an escaped quote, and does not false-trigger comment stripping around it", () => {
    const input = '{ "a": "a\\"//b" }';

    const stripped = stripJsonc(input);

    expect(JSON.parse(stripped)).toEqual({ a: 'a"//b' });
  });

  it("does NOT strip a literal trailing-comma-like substring inside a string", () => {
    const input = '{ "a": "a,}" }';

    const stripped = stripJsonc(input);

    expect(JSON.parse(stripped)).toEqual({ a: "a,}" });
  });

  it("degrades to undefined via resolveIncludeChain when the stripped result is still invalid JSON, instead of throwing", async () => {
    const doc = await resolveIncludeChain(join(FIXTURES_DIR, "tmtheme-path.json"), async () => "{ this is not valid json even after stripping");

    expect(doc).toBeUndefined();
  });
});

describe("resolveThemeDocument (impure seam wired to the pure resolver)", () => {
  it("wires listExtensions -> findThemeContributor and readFile -> resolveIncludeChain to resolve a real theme id", async () => {
    const extension: ExtensionLike = {
      extensionPath: FIXTURES_DIR,
      packageJSON: { contributes: { themes: [{ id: "Dark Modern", label: "%placeholder%", path: "./dark-modern.json" }] } },
    };

    const doc = await resolveThemeDocument("Dark Modern", {
      listExtensions: () => [extension],
      readFile: readFixtureFile,
    });

    expect(doc).toBeDefined();
    expect((doc!.semanticTokenColors as Record<string, unknown>).newOperator).toBeDefined();
  });

  it("returns undefined without throwing when no installed extension contributes the theme id", async () => {
    const doc = await resolveThemeDocument("Nonexistent Theme", {
      listExtensions: () => [],
      readFile: readFixtureFile,
    });

    expect(doc).toBeUndefined();
  });
});
