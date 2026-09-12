import { describe, expect, it } from "vitest";
import { EDGE_STYLE_BY_KIND, EDGE_STYLE_UNRESOLVED, edgeStyleFor } from "../../webview/edgeStyleConfig.js";

/**
 * PR4 (design.md §5, D13 "Palette C, Theme-Native Charts"): every stroke/particle-fill value in
 * this module must be a CSS custom-property *reference* (`var(--acm-edge-*)`) — never a raw hex.
 * The actual theme-resolved colours only ever live in `styles.css`'s `var(--vscode-charts-*,
 * <fallback>)` chain, never hard-coded in this config module.
 */
const CSS_VAR_INVARIANT = /^var\(--acm-edge-(import|call|ambiguous)\)$/;

describe("EDGE_STYLE_BY_KIND", () => {
  it("styles import edges as dashed, filled arrow, with the import CSS variable", () => {
    expect(EDGE_STYLE_BY_KIND.import).toEqual({
      stroke: "var(--acm-edge-import)",
      strokeWidth: 3,
      dashArray: "8 6",
      arrow: "filled",
      particle: { radius: 3, fill: "var(--acm-edge-import)", durationMs: 2600 },
    });
  });

  it("styles call edges as solid (no dashArray), filled arrow, with the call CSS variable", () => {
    expect(EDGE_STYLE_BY_KIND.call).toEqual({
      stroke: "var(--acm-edge-call)",
      strokeWidth: 3,
      dashArray: undefined,
      arrow: "filled",
      particle: { radius: 3, fill: "var(--acm-edge-call)", durationMs: 1800 },
    });
  });
});

describe("EDGE_STYLE_UNRESOLVED", () => {
  it("is dotted, open arrow, distinct from both import's dash and call's solid, using the ambiguous CSS variable", () => {
    expect(EDGE_STYLE_UNRESOLVED).toEqual({
      stroke: "var(--acm-edge-ambiguous)",
      strokeWidth: 3,
      dashArray: "2 5",
      arrow: "open",
      particle: { radius: 3, fill: "var(--acm-edge-ambiguous)", durationMs: 3200 },
    });
  });
});

describe("edgeStyleFor", () => {
  it("dispatches a resolved import edge to EDGE_STYLE_BY_KIND.import", () => {
    expect(edgeStyleFor("import", "resolved")).toBe(EDGE_STYLE_BY_KIND.import);
  });

  it("dispatches a resolved call edge to EDGE_STYLE_BY_KIND.call", () => {
    expect(edgeStyleFor("call", "resolved")).toBe(EDGE_STYLE_BY_KIND.call);
  });

  it("routes an ambiguous resolution to EDGE_STYLE_UNRESOLVED regardless of kind", () => {
    expect(edgeStyleFor("import", "ambiguous")).toBe(EDGE_STYLE_UNRESOLVED);
    expect(edgeStyleFor("call", "ambiguous")).toBe(EDGE_STYLE_UNRESOLVED);
  });

  it("routes an unresolved resolution to EDGE_STYLE_UNRESOLVED regardless of kind", () => {
    expect(edgeStyleFor("import", "unresolved")).toBe(EDGE_STYLE_UNRESOLVED);
    expect(edgeStyleFor("call", "unresolved")).toBe(EDGE_STYLE_UNRESOLVED);
  });
});

describe("invariant: no raw hex ever leaks into the config module", () => {
  it("asserts every stroke/particle.fill in EDGE_STYLE_BY_KIND and EDGE_STYLE_UNRESOLVED is a var(--acm-edge-*) reference", () => {
    const styles = [...Object.values(EDGE_STYLE_BY_KIND), EDGE_STYLE_UNRESOLVED];
    for (const style of styles) {
      expect(style.stroke).toMatch(CSS_VAR_INVARIANT);
      expect(style.particle.fill).toMatch(CSS_VAR_INVARIANT);
    }
  });
});
