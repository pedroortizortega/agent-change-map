import type { EdgeResolution } from "../src/protocol.js";

export type EdgeKind = "import" | "call";

export interface EdgeKindStyle {
  /** CSS custom-property reference. NEVER a raw hex — the property value is theme-resolved
   *  (Palette C, D13): `--acm-edge-*` resolves via `var(--vscode-charts-*, <fallback>)` in
   *  `styles.css`, so every installed VS Code theme supplies its own contrast-tuned colour. */
  stroke: `var(--acm-edge-${string})`;
  strokeWidth: number;
  dashArray?: string;
  arrow: "filled" | "open" | "none";
  particle: { radius: number; fill: `var(--acm-edge-${string})`; durationMs: number };
}

/** Dash assignment: `import` dashed (structural/dependency), `call` solid (execution flow).
 *  `call`'s particle is faster (1800ms) than `import`'s (2600ms) — execution reads as faster
 *  than dependency; both are decorative and constant (D9), never mutated by hover. */
export const EDGE_STYLE_BY_KIND: Readonly<Record<EdgeKind, EdgeKindStyle>> = {
  import: {
    stroke: "var(--acm-edge-import)",
    strokeWidth: 3,
    dashArray: "8 6",
    arrow: "filled",
    particle: { radius: 3, fill: "var(--acm-edge-import)", durationMs: 2600 },
  },
  call: {
    stroke: "var(--acm-edge-call)",
    strokeWidth: 3,
    dashArray: undefined,
    arrow: "filled",
    particle: { radius: 3, fill: "var(--acm-edge-call)", durationMs: 1800 },
  },
};

/** Applies to ambiguous/unresolved relationships. Consumed ONLY by the relationship-indicator
 *  chrome (D12, resolved: indicator-only) — never by a drawn edge, since these relationships
 *  have no in-view target node and cannot exist as a React Flow edge (`graphLayout.ts`'s
 *  `buildEdges` never emits an `AcmEdge` for a non-resolved relationship). Dotted (`2 5`) so it
 *  can never be confused with `import`'s dash at a glance; slower particle (3200ms) and an open
 *  arrowhead, both purely for the indicator's own chrome. */
export const EDGE_STYLE_UNRESOLVED: EdgeKindStyle = {
  stroke: "var(--acm-edge-ambiguous)",
  strokeWidth: 3,
  dashArray: "2 5",
  arrow: "open",
  particle: { radius: 3, fill: "var(--acm-edge-ambiguous)", durationMs: 3200 },
};

export function edgeStyleFor(kind: EdgeKind, resolution: EdgeResolution["kind"]): EdgeKindStyle {
  if (resolution !== "resolved") return EDGE_STYLE_UNRESOLVED;
  return EDGE_STYLE_BY_KIND[kind];
}
