import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { lex, mergeSpans, highlight, type RoleSpan } from "../../webview/highlight.js";

describe("webview/highlight.ts lexer (D6/D7 approximate lexer)", () => {
  it("identifies string, comment, keyword, and number spans as non-overlapping", () => {
    const text = "def go(x):\n    # a comment\n    return x + 42\n";
    const spans = lex(text);
    const textOf = (span: RoleSpan) => text.slice(span.start, span.end);
    expect(spans.find((span) => span.role === "keyword" && textOf(span) === "def")).toBeTruthy();
    expect(spans.find((span) => span.role === "keyword" && textOf(span) === "return")).toBeTruthy();
    expect(spans.find((span) => span.role === "comment" && textOf(span) === "# a comment")).toBeTruthy();
    expect(spans.find((span) => span.role === "number" && textOf(span) === "42")).toBeTruthy();
    // Non-overlapping: sorted by start, no span starts before the previous one ends.
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
  });

  it("identifies plain and triple-quoted string literals", () => {
    const text = 'x = "hello"\ny = \'world\'\nz = """multi\nline"""\n';
    const spans = lex(text);
    const textOf = (span: RoleSpan) => text.slice(span.start, span.end);
    expect(spans.filter((span) => span.role === "string").map(textOf)).toEqual(
      expect.arrayContaining(['"hello"', "'world'", '"""multi\nline"""']),
    );
  });

  it("does not tag an ordinary identifier as any lexer role", () => {
    const text = "value = other_value\n";
    const spans = lex(text);
    const textOf = (span: RoleSpan) => text.slice(span.start, span.end);
    expect(spans.some((span) => textOf(span) === "value" || textOf(span) === "other_value")).toBe(false);
  });

  it("composes lexer spans with AST role spans into one non-overlapping list, AST roles winning ties", () => {
    // "self" is not a Python keyword, so the lexer alone produces no span for it; the AST
    // role span is the only source of color for that occurrence.
    const text = "def go(self):\n    return self.value\n";
    const lexSpans = lex(text);
    const selfOffsetSecond = text.indexOf("self", text.indexOf("self") + 1);
    const roleSpans: RoleSpan[] = [{ start: selfOffsetSecond, end: selfOffsetSecond + 4, role: "self" }];
    const merged = mergeSpans(lexSpans, roleSpans);
    expect(merged.find((span) => span.role === "self")).toEqual({ start: selfOffsetSecond, end: selfOffsetSecond + 4, role: "self" });
    // Still contains the lexer's own findings (e.g. "def"/"return" keywords).
    expect(merged.some((span) => span.role === "keyword")).toBe(true);
    // Fully sorted and non-overlapping.
    for (let i = 1; i < merged.length; i++) expect(merged[i]!.start).toBeGreaterThanOrEqual(merged[i - 1]!.end);
  });

  it("clips a lexer span that partially overlaps a higher-priority AST role span", () => {
    // A pathological case: an AST role span landing in the middle of what the lexer would
    // otherwise treat as a single token region. The AST span wins for its exact range; the
    // lexer's surrounding coverage (if any) is preserved around it, never overlapping.
    const text = "class_name_value";
    const roleSpans: RoleSpan[] = [{ start: 6, end: 10, role: "className" }];
    const merged = mergeSpans([{ start: 0, end: text.length, role: "keyword" }], roleSpans);
    expect(merged).toEqual([
      { start: 0, end: 6, role: "keyword" },
      { start: 6, end: 10, role: "className" },
      { start: 10, end: 16, role: "keyword" },
    ]);
  });

  it("renders highlighted HTML whose textContent equals the original text exactly", () => {
    const dom = new JSDOM();
    const text = "def go(self):\n    return self.value < 3 & 'a<b'\n";
    const html = highlight(text, [{ start: text.indexOf("self", text.indexOf("self") + 1), end: text.indexOf("self", text.indexOf("self") + 1) + 4, role: "self" }], { self: "#569CD6", keyword: "#C586C0" });
    const pre = dom.window.document.createElement("pre");
    pre.innerHTML = html;
    expect(pre.textContent).toBe(text);
  });

  it("renders an unrecognized role without color, still preserving exact text", () => {
    const dom = new JSDOM();
    const text = "plain_local_variable\n";
    const html = highlight(text, [], {});
    const pre = dom.window.document.createElement("pre");
    pre.innerHTML = html;
    expect(pre.textContent).toBe(text);
    expect(html).not.toContain("<span");
  });

  it("never emits an inline style attribute (CSP has no 'unsafe-inline' in style-src)", () => {
    // Regression test: an earlier version wrote `<span style="color:...">`, which the webview's
    // CSP silently drops (no console error, no thrown exception) - the draft rendered
    // completely uncolored with no visible failure. Colors must only ever travel as a
    // `class="tok-ROLE"` attribute; the actual color values are applied via the CSSOM
    // (`applyThemeColors` in webview/index.ts), which CSP's style-src does not govern.
    const text = "def go(self):\n    return self.value\n";
    const selfOffset = text.indexOf("self", text.indexOf("self") + 1);
    const html = highlight(text, [{ start: selfOffset, end: selfOffset + 4, role: "self" }], { self: "#569CD6", keyword: "#C586C0" });
    expect(html).not.toContain("style=");
    expect(html).toContain('class="tok-self"');
    expect(html).toContain('class="tok-keyword"');
  });
});
