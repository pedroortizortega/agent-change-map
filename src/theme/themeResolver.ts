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
