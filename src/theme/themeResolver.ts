/**
 * Theme resolution (design D8). Locates the installed extension contributing the
 * workspace's active `workbench.colorTheme`, resolves and merges its `include` chain,
 * and yields a single JSONC-clean, valid JSON document. Color extraction, override
 * layering, and the default-palette degrade path are a later slice - this module only
 * resolves the merged document or fails cleanly (returns `undefined`; never throws).
 *
 * Impure I/O (listing installed extensions, reading theme files from disk) is confined
 * to the injectable {@link ThemeResolverIO} seam consumed by {@link resolveThemeDocument}.
 * The `include`-chain traversal and JSONC stripping below take a plain `readFile`
 * function and are otherwise pure, so they are fixture-testable without mocking `vscode`.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { ALL_ROLES, DEFAULT_PALETTE, ROLE_SCOPES, ROLE_SEMANTIC_KEYS, type TokenRole } from "./tokenPalette.js";

export type { TokenRole };
export { DEFAULT_PALETTE };

/** Maximum number of files allowed in a single `include` chain before resolution is abandoned. */
const MAX_INCLUDE_DEPTH = 5;

export interface ThemeContribution {
  id?: string;
  label?: string;
  path: string;
}

/** Shape of a `vscode.Extension` this module actually reads - kept minimal for fixture-testability. */
export interface ExtensionLike {
  extensionPath: string;
  packageJSON?: {
    contributes?: {
      themes?: ThemeContribution[];
    };
  };
}

export interface ThemeContributorMatch {
  extensionPath: string;
  themePath: string;
}

/**
 * Finds the installed extension contributing `themeId`, matching on the contribution's
 * `id`, falling back to `label` only when `id` is absent. Built-in themes' `label`s are
 * unresolved NLS placeholders (e.g. `%darkPlusColorThemeLabel%`) while `workbench.
 * colorTheme` stores the real `id` (`"Dark Modern"`) - matching by `label` alone would
 * never find them.
 */
export function findThemeContributor(extensions: readonly ExtensionLike[], themeId: string): ThemeContributorMatch | undefined {
  for (const extension of extensions) {
    const themes = extension.packageJSON?.contributes?.themes;
    if (!themes) continue;
    const match = themes.find((theme) => (theme.id ?? theme.label) === themeId);
    if (match) return { extensionPath: extension.extensionPath, themePath: match.path };
  }
  return undefined;
}

export type ReadFileFn = (path: string) => Promise<string>;

export interface ThemeResolverIO {
  listExtensions: () => readonly ExtensionLike[];
  readFile: ReadFileFn;
}

/**
 * Recursively resolves `filePath`'s `include` chain and returns the fully merged
 * document (child keys win over ancestor keys; a key absent on the child falls through
 * to the ancestor's value). Guards against cycles (a visited-path set shared across the
 * whole recursion) and chains deeper than {@link MAX_INCLUDE_DEPTH}. Any failure at any
 * step - missing/unreadable file, malformed JSON (after JSONC stripping), a cycle, or a
 * chain exceeding the depth cap - makes the *entire* resolution fail (`undefined`)
 * rather than silently returning a partial document; the default-palette degrade for
 * that outcome is applied by the caller (slice 3a-ii).
 */
export async function resolveIncludeChain(filePath: string, readFile: ReadFileFn): Promise<Record<string, unknown> | undefined> {
  return resolveIncludeChainInternal(filePath, readFile, new Set<string>(), 1);
}

async function resolveIncludeChainInternal(
  filePath: string,
  readFile: ReadFileFn,
  visited: Set<string>,
  depth: number,
): Promise<Record<string, unknown> | undefined> {
  if (depth > MAX_INCLUDE_DEPTH) return undefined;

  const resolvedPath = resolvePath(filePath);
  if (visited.has(resolvedPath)) return undefined;
  visited.add(resolvedPath);

  let raw: string;
  try {
    raw = await readFile(resolvedPath);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const doc = parsed as Record<string, unknown>;

  const includeValue = doc.include;
  if (typeof includeValue !== "string") {
    return { ...doc };
  }

  const includePath = join(dirname(resolvedPath), includeValue);
  const ancestor = await resolveIncludeChainInternal(includePath, readFile, visited, depth + 1);
  if (!ancestor) return undefined;
  return { ...ancestor, ...doc };
}

/**
 * Strips `//` line comments, `/* *\/` block comments, and trailing commas from `text`,
 * treating it as JSON-with-comments (JSONC). String/escape aware: comment-like sequences
 * inside a JSON string literal (including an escaped quote that would otherwise end the
 * string early) are preserved verbatim rather than treated as the start of a comment.
 */
export function stripJsonc(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\" && i + 1 < n) {
        result += ch + text[i + 1];
        i += 2;
        continue;
      }
      result += ch;
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return stripTrailingCommas(result);
}

/**
 * Removes a trailing comma immediately before a closing `}`/`]` (skipping intervening
 * whitespace), string/escape aware so a literal `,}`/`,]`-shaped substring inside a JSON
 * string value is left untouched. Comments must already be stripped from `text` before
 * calling this.
 */
function stripTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\" && i + 1 < n) {
        result += ch + text[i + 1];
        i += 2;
        continue;
      }
      result += ch;
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Thin impure entry point: finds the contributing extension via `listExtensions`, then
 * resolves its `include` chain via `readFile`. Returns `undefined` on any failure
 * (theme not found, extension disabled/uninstalled mid-session, or any `resolveIncludeChain`
 * failure) - never throws.
 */
export async function resolveThemeDocument(themeId: string, io: ThemeResolverIO): Promise<Record<string, unknown> | undefined> {
  const contributor = findThemeContributor(io.listExtensions(), themeId);
  if (!contributor) return undefined;

  const entryPath = join(contributor.extensionPath, contributor.themePath);
  return resolveIncludeChain(entryPath, io.readFile);
}

/**
 * Color extraction, override precedence, and the never-throw degrade path (design D8,
 * slice 3a-ii). Consumes an already-merged, JSONC-clean theme document produced by
 * {@link resolveThemeDocument} / {@link resolveIncludeChain} above — this half has no
 * knowledge of `include`-chain resolution or JSONC stripping.
 */

/** One parsed TextMate rule: the scopes it applies to, and the foreground color it sets. */
interface TokenColorRule {
  scopes: readonly string[];
  foreground: string;
}

/**
 * Parses a document's (or an override's) `tokenColors` entries into `{scopes, foreground}`
 * rules. `scope` may be a single comma-separated string or an array of strings, per the
 * TextMate theme convention. Returns `[]` when `tokenColors` is absent or is not an array
 * (e.g. a `.tmTheme` plist *path string*, which this feature does not parse) - callers then
 * fall through to the next precedence layer instead of throwing.
 */
function extractTokenColorRules(source: { tokenColors?: unknown } | undefined): TokenColorRule[] {
  const raw = source?.tokenColors;
  if (!Array.isArray(raw)) return [];
  const rules: TokenColorRule[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const scopeValue = (entry as { scope?: unknown }).scope;
    const scopes = Array.isArray(scopeValue)
      ? scopeValue.filter((value): value is string => typeof value === "string")
      : typeof scopeValue === "string"
        ? scopeValue.split(",").map((value) => value.trim())
        : [];
    const settings = (entry as { settings?: unknown }).settings;
    const foreground = typeof settings === "object" && settings !== null ? (settings as { foreground?: unknown }).foreground : undefined;
    if (scopes.length === 0 || typeof foreground !== "string") continue;
    rules.push({ scopes, foreground });
  }
  return rules;
}

/**
 * Finds the best-matching rule's foreground color for `candidateScopes`, per D8 step 7:
 * longest dotted-scope prefix wins; ties broken by last-matching-rule-wins (later entries
 * in the `tokenColors` array override earlier ones, matching VS Code's own ordering).
 */
function matchTokenColorScope(rules: readonly TokenColorRule[], candidateScopes: readonly string[]): string | undefined {
  let best: { foreground: string; specificity: number; index: number } | undefined;
  rules.forEach((rule, index) => {
    for (const ruleScope of rule.scopes) {
      for (const candidate of candidateScopes) {
        if (candidate !== ruleScope && !candidate.startsWith(`${ruleScope}.`)) continue;
        const specificity = ruleScope.split(".").length;
        if (!best || specificity > best.specificity || (specificity === best.specificity && index > best.index)) {
          best = { foreground: rule.foreground, specificity, index };
        }
      }
    }
  });
  return best?.foreground;
}

/**
 * Exact-key lookup only into a semantic-token-color map (either the theme's own
 * `semanticTokenColors` or the `editor.semanticTokenColorCustomizations.rules` override) -
 * no selector-specificity engine for modifiers/language suffixes, per D8 step 7's
 * deliberate accuracy ceiling. A matched entry may be a bare color string or a
 * `{ foreground }` object, per VS Code's own semantic token color schema.
 */
function matchSemanticTokenColor(semanticColors: Record<string, unknown>, candidateKeys: readonly string[]): string | undefined {
  for (const key of candidateKeys) {
    const entry = semanticColors[key];
    if (typeof entry === "string") return entry;
    if (typeof entry === "object" && entry !== null && typeof (entry as { foreground?: unknown }).foreground === "string") {
      return (entry as { foreground: string }).foreground;
    }
  }
  return undefined;
}

function asSemanticColorMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Highest-precedence overrides, sourced from workspace configuration (design D8 step 6). */
export interface ThemeOverrides {
  /** Raw value of `editor.semanticTokenColorCustomizations` (its `.rules` object is used). */
  semanticTokenColorCustomizations?: unknown;
  /** The `workbench.colorCustomizations.textMateRules` array, already extracted by the caller. */
  colorCustomizationsTextMateRules?: unknown;
}

export interface ThemeTokens {
  kind: "light" | "dark" | "highContrast";
  colors: Record<TokenRole, string>;
}

/**
 * Maps a resolved theme document to per-role colors, in the precedence order design D8
 * mandates: `editor.semanticTokenColorCustomizations` override -> `workbench.
 * colorCustomizations.textMateRules` override -> theme `semanticTokenColors` -> theme
 * `tokenColors` scope fallback -> kind-based default palette. Never throws: an absent or
 * malformed `themeDocument` (e.g. `undefined`, or a `tokenColors` plist path string)
 * simply yields fewer matches, falling through to the default palette for those roles.
 */
export function resolveTokenColors(
  themeDocument: Record<string, unknown> | undefined,
  kind: "light" | "dark" | "highContrast",
  overrides: ThemeOverrides = {},
): ThemeTokens {
  const palette = DEFAULT_PALETTE[kind];
  const themeTokenColorRules = extractTokenColorRules(themeDocument);
  const themeSemanticColors = asSemanticColorMap(themeDocument?.semanticTokenColors);
  const overrideSemanticColors = asSemanticColorMap(
    typeof overrides.semanticTokenColorCustomizations === "object" && overrides.semanticTokenColorCustomizations !== null
      ? (overrides.semanticTokenColorCustomizations as { rules?: unknown }).rules
      : undefined,
  );
  const overrideTokenColorRules = extractTokenColorRules({ tokenColors: overrides.colorCustomizationsTextMateRules });

  const colors = {} as Record<TokenRole, string>;
  for (const role of ALL_ROLES) {
    colors[role] =
      matchSemanticTokenColor(overrideSemanticColors, ROLE_SEMANTIC_KEYS[role]) ??
      matchTokenColorScope(overrideTokenColorRules, ROLE_SCOPES[role]) ??
      matchSemanticTokenColor(themeSemanticColors, ROLE_SEMANTIC_KEYS[role]) ??
      matchTokenColorScope(themeTokenColorRules, ROLE_SCOPES[role]) ??
      palette[role];
  }
  return { kind, colors };
}

export interface ThemeResolutionInput {
  themeId: string;
  kind: "light" | "dark" | "highContrast";
  io: ThemeResolverIO;
  overrides?: ThemeOverrides;
}

/**
 * The never-throw entry point (design D8's "total and silent-to-the-user-but-logged"
 * degradation contract): resolves the theme document and extracts colors, but any failure
 * anywhere in that pipeline - theme not found, extension disabled mid-session, malformed
 * JSON, an `include` cycle/depth overflow, a plist-path `tokenColors` - degrades to the
 * full kind-based default palette rather than throwing or rejecting.
 */
export async function resolveThemeTokens(input: ThemeResolutionInput): Promise<ThemeTokens> {
  try {
    const document = await resolveThemeDocument(input.themeId, input.io);
    return resolveTokenColors(document, input.kind, input.overrides);
  } catch {
    return { kind: input.kind, colors: { ...DEFAULT_PALETTE[input.kind] } };
  }
}
