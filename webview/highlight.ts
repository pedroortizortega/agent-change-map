import type { TokenRole } from "../src/theme/tokenPalette.js";

/**
 * A single colorable region of draft text. `start`/`end` are byte-count-agnostic UTF-16 code
 * unit offsets into the exact text being rendered (design D6/D7: the draft view renders plain
 * JS strings, so JS string indices are the correct unit here - byte offsets from the analyzer's
 * `identifierRoles` are relative to the same entity-scoped text and are used as-is by callers).
 */
export interface RoleSpan {
  start: number;
  end: number;
  role: TokenRole;
}

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

/**
 * Minimal in-repo lexer for Python's string/comment/keyword/number spans (design D7 -
 * "approximate by contract", not a full Python grammar). Ordinary identifiers, operators, and
 * punctuation produce no span; only the four recognized categories are tagged.
 */
const TOKEN_PATTERN = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

export function lex(text: string): RoleSpan[] {
  const spans: RoleSpan[] = [];
  const pattern = new RegExp(TOKEN_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    let role: TokenRole | undefined;
    if (value.startsWith("#")) role = "comment";
    else if (value[0] === '"' || value[0] === "'") role = "string";
    else if (/^\d/.test(value)) role = "number";
    else if (KEYWORDS.has(value)) role = "keyword";
    if (role) spans.push({ start, end, role });
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return spans;
}

/**
 * Composes the lexer's generic spans with the analyzer's AST-derived role spans (design D7:
 * "roles come from the analyzer... overlaid by byte offset") into one sorted, non-overlapping
 * list. AST role spans always win over a lexer span at the same offset - a lexer span is
 * clipped (split into up to two remaining pieces) around any overlapping AST span rather than
 * dropped outright, so unrelated coverage on either side of the overlap is preserved.
 */
export function mergeSpans(lexSpans: readonly RoleSpan[], roleSpans: readonly RoleSpan[]): RoleSpan[] {
  const result: RoleSpan[] = [...roleSpans];
  for (const lexSpan of lexSpans) {
    let segments: [number, number][] = [[lexSpan.start, lexSpan.end]];
    for (const role of roleSpans) {
      const next: [number, number][] = [];
      for (const [start, end] of segments) {
        if (role.end <= start || role.start >= end) {
          next.push([start, end]);
          continue;
        }
        if (role.start > start) next.push([start, role.start]);
        if (role.end < end) next.push([role.end, end]);
      }
      segments = next;
    }
    for (const [start, end] of segments) {
      if (end > start) result.push({ start, end, role: lexSpan.role });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders `text` as HTML with each merged role span wrapped in a `<span class="tok-ROLE">`.
 * The actual color per role is never embedded as an inline `style="..."` attribute - the
 * webview's CSP (`style-src` with no `unsafe-inline`) blocks HTML-parsed inline styles, so a
 * literal `style="color:..."` string silently renders unstyled instead of throwing. Colors are
 * applied via CSS custom properties (`--tok-ROLE`, defined in webview/styles.css) that the host
 * page updates through the CSSOM (`element.style.setProperty`, in `applyThemeColors`) - direct
 * CSSOM writes are exempt from CSP's style-src restriction, only HTML-parsed style
 * attributes/`<style>` blocks are governed by it.
 *
 * A role absent from `colors`, or an identifier with no role at all, renders as plain escaped
 * text - never blocks rendering the rest of the snippet (spec scenario "Unresolvable identifier
 * role falls back gracefully"). Escaping only affects `&`/`<`/`>`; the rendered element's
 * `textContent` is exactly `text` (the overlay/textarea synchronization invariant, design D6).
 */
export function highlight(text: string, identifierRoles: readonly RoleSpan[], colors: Partial<Record<TokenRole, string>>): string {
  const lexSpans = lex(text);
  const merged = mergeSpans(lexSpans, identifierRoles.filter((role) => role.start >= 0 && role.end <= text.length && role.end >= role.start));
  let html = "";
  let cursor = 0;
  for (const span of merged) {
    if (span.start < cursor) continue;
    if (span.start > cursor) html += escapeHtml(text.slice(cursor, span.start));
    const hasColor = colors[span.role] !== undefined;
    const segment = escapeHtml(text.slice(span.start, span.end));
    html += hasColor ? `<span class="tok-${span.role}">${segment}</span>` : segment;
    cursor = span.end;
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  return html;
}
