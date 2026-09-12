/**
 * Pure token-role/color data shared by the extension host (`themeResolver.ts`) and the
 * webview bundle (`webview/index.ts`, `webview/highlight.ts`).
 *
 * This module MUST have zero imports. `themeResolver.ts` needs `node:path`/`node:fs` for
 * disk-based theme resolution, which only exists in the extension host's Node.js runtime --
 * a webview panel runs in a browser sandbox with no Node APIs. Before this module existed,
 * the webview imported `TokenRole`/`DEFAULT_PALETTE` directly from `themeResolver.ts`, which
 * dragged its `node:path` import into the webview's bundle and broke at runtime with
 * `GET node:path net::ERR_FAILED` -- the browser has no way to resolve a `node:` URL. Keep
 * every webview-safe export here, and never import a Node builtin into this file.
 */

/** The identifier/lexer-token roles this feature colors. Kept intentionally small per D7/D8. */
export type TokenRole =
  | "self"
  | "parameter"
  | "className"
  | "functionName"
  | "importedName"
  | "builtin"
  | "keyword"
  | "string"
  | "comment"
  | "number";

export const ALL_ROLES: readonly TokenRole[] = [
  "self",
  "parameter",
  "className",
  "functionName",
  "importedName",
  "builtin",
  "keyword",
  "string",
  "comment",
  "number",
];

/**
 * Candidate TextMate scopes per role, most-specific first (used only to seed matching -
 * the actual winner is chosen by longest-prefix/last-rule-wins over the theme's own rule
 * order, per D8 step 7).
 */
export const ROLE_SCOPES: Record<TokenRole, readonly string[]> = {
  self: ["variable.language.self", "variable.language", "variable.parameter"],
  parameter: ["variable.parameter", "variable"],
  className: ["entity.name.type.class", "entity.name.type", "support.class"],
  functionName: ["entity.name.function", "support.function"],
  importedName: ["variable.other.readwrite.alias", "entity.name.namespace", "variable"],
  builtin: ["support.function.builtin", "support.type", "support.class"],
  keyword: ["keyword.control", "keyword"],
  string: ["string"],
  comment: ["comment"],
  number: ["constant.numeric"],
};

/** Candidate semantic token color keys per role, tried by exact-key lookup only (D8 step 7 -
 * no selector-specificity engine for modifiers/language suffixes). */
export const ROLE_SEMANTIC_KEYS: Record<TokenRole, readonly string[]> = {
  self: ["selfParameter", "variable.readonly"],
  parameter: ["parameter"],
  className: ["class"],
  functionName: ["function"],
  importedName: ["namespace"],
  builtin: ["function.defaultLibrary", "class.defaultLibrary"],
  keyword: ["keyword"],
  string: ["string"],
  comment: ["comment"],
  number: ["number"],
};

/** Kind-based default palette: the terminal fallback for a role that resolves nowhere else. */
export const DEFAULT_PALETTE: Record<"light" | "dark" | "highContrast", Record<TokenRole, string>> = {
  dark: {
    self: "#569CD6",
    parameter: "#9CDCFE",
    className: "#4EC9B0",
    functionName: "#DCDCAA",
    importedName: "#9CDCFE",
    builtin: "#4EC9B0",
    keyword: "#C586C0",
    string: "#CE9178",
    comment: "#6A9955",
    number: "#B5CEA8",
  },
  light: {
    self: "#0000FF",
    parameter: "#001080",
    className: "#267F99",
    functionName: "#795E26",
    importedName: "#001080",
    builtin: "#267F99",
    keyword: "#AF00DB",
    string: "#A31515",
    comment: "#008000",
    number: "#098658",
  },
  highContrast: {
    self: "#3B8EEA",
    parameter: "#FFFFFF",
    className: "#4EC9B0",
    functionName: "#DCDCAA",
    importedName: "#FFFFFF",
    builtin: "#4EC9B0",
    keyword: "#C586C0",
    string: "#CE9178",
    comment: "#7CA668",
    number: "#B5CEA8",
  },
};
