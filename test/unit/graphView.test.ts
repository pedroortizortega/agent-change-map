import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildCspMetaTag } from "../../webview/graphView.js";
import { renderGraphSvg, sectionScope, filterGraph, NESTED_LAYOUT_LIMITS, isAncestorSelfReference, suppressAncestorSelfReferences } from "../../webview/graphView.js";
import type { EdgeVintage } from "../../webview/graphView.js";
import type { AnalysisGraph, Edge, Entity } from "../../src/protocol.js";
import type { CorrelatedDiffEntry } from "../../src/navigation/sourceProvider.js";

function readStylesCss(): string {
  return readFileSync(resolve(__dirname, "../../webview/styles.css"), "utf8");
}

const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" };
const span = { path: "pkg/a.py", startByte: 0, endByte: 3, startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };

function graph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", span },
      { id: "function:pkg.a.f", kind: "function", qualifiedName: "pkg.a.f", containerId: "module:pkg.a", span },
      { id: "function:pkg.b.g", kind: "function", qualifiedName: "pkg.b.g", span },
    ],
    edges: [
      { kind: "contains", source: "module:pkg.a", resolution: { kind: "resolved", target: "function:pkg.a.f" }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "resolved", target: "function:pkg.b.g" }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "ambiguous", candidates: ["function:pkg.b.g", "function:pkg.c.h"] }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "unresolved" }, span },
    ],
    diagnostics: [],
  };
}

/** Three-level containment fixture: package -> module -> class -> method, plus a root function
 * used as the target of resolved import/call edges. */
function nestedGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "package:pkg", kind: "package", qualifiedName: "pkg", span },
      { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", containerId: "package:pkg", span },
      { id: "class:pkg.a.C", kind: "class", qualifiedName: "pkg.a.C", containerId: "module:pkg.a", span },
      { id: "method:pkg.a.C.m", kind: "method", qualifiedName: "pkg.a.C.m", containerId: "class:pkg.a.C", span },
      { id: "function:pkg.a.f", kind: "function", qualifiedName: "pkg.a.f", containerId: "module:pkg.a", span },
      { id: "function:pkg.b.g", kind: "function", qualifiedName: "pkg.b.g", span },
    ],
    edges: [
      { kind: "contains", source: "module:pkg.a", resolution: { kind: "resolved", target: "class:pkg.a.C" }, span },
      { kind: "contains", source: "class:pkg.a.C", resolution: { kind: "resolved", target: "method:pkg.a.C.m" }, span },
      { kind: "import", source: "module:pkg.a", resolution: { kind: "resolved", target: "function:pkg.b.g" }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "resolved", target: "function:pkg.b.g" }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "ambiguous", candidates: ["function:pkg.b.g", "function:pkg.c.h"] }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "unresolved" }, span },
    ],
    diagnostics: [],
  };
}

function parseSvg(svg: string): Document {
  return new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
}

/**
 * Module -> class -> method containment chain, plus two peer functions in the same file that
 * are not each other's ancestor/descendant. Used to exercise `isAncestorSelfReference` and
 * `suppressAncestorSelfReferences` (task 1.1).
 */
function selfRefGraph(): AnalysisGraph {
  return {
    snapshot,
    nodes: [
      { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", span },
      { id: "class:pkg.a.C", kind: "class", qualifiedName: "pkg.a.C", containerId: "module:pkg.a", span },
      { id: "method:pkg.a.C.m", kind: "method", qualifiedName: "pkg.a.C.m", containerId: "class:pkg.a.C", span },
      { id: "function:pkg.a.f1", kind: "function", qualifiedName: "pkg.a.f1", containerId: "module:pkg.a", span },
      { id: "function:pkg.a.f2", kind: "function", qualifiedName: "pkg.a.f2", containerId: "module:pkg.a", span },
    ],
    edges: [
      { kind: "contains", source: "module:pkg.a", resolution: { kind: "resolved", target: "class:pkg.a.C" }, span },
      { kind: "contains", source: "class:pkg.a.C", resolution: { kind: "resolved", target: "method:pkg.a.C.m" }, span },
      // Direct-parent self-reference: module is the direct containerId parent of class.
      { kind: "call", source: "module:pkg.a", resolution: { kind: "resolved", target: "class:pkg.a.C" }, span },
      // Transitive-ancestor self-reference: module is a multi-step containerId ancestor of method.
      { kind: "call", source: "module:pkg.a", resolution: { kind: "resolved", target: "method:pkg.a.C.m" }, span },
      // Same-file peer edge: neither is the other's ancestor/descendant.
      { kind: "call", source: "function:pkg.a.f1", resolution: { kind: "resolved", target: "function:pkg.a.f2" }, span },
    ],
    diagnostics: [],
  };
}

describe("CSP", () => {
  it("emits a strict nonce-based meta tag with no unsafe sources", () => {
    const tag = buildCspMetaTag("abc123", "vscode-resource:");
    expect(tag).toBe(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: data:; style-src vscode-resource:; script-src 'nonce-abc123'; script-src-elem 'nonce-abc123';">`,
    );
    expect(tag).not.toContain("unsafe-inline");
    expect(tag).not.toContain("unsafe-eval");
    expect(tag).not.toContain("http:");
    expect(tag).not.toContain("https:");
  });
});

describe("graph rendering", () => {
  it("renders every node and edge of a whole-project map as SVG, nesting contained entities", () => {
    const svg = renderGraphSvg(graph(), []);
    expect(svg).toContain("<svg");
    expect(svg).toContain('data-node-id="module:pkg.a"');
    expect(svg).toContain('data-node-id="function:pkg.a.f"');
    expect(svg).toContain('data-node-id="function:pkg.b.g"');
    const doc = parseSvg(svg);
    const parent = doc.querySelector('[data-node-id="module:pkg.a"]');
    const child = doc.querySelector('[data-node-id="function:pkg.a.f"]');
    expect(parent).not.toBeNull();
    expect(child).not.toBeNull();
    expect(parent!.contains(child)).toBe(true);
  });

  it("explicitly marks ambiguous and unresolved edges rather than hiding or arrow-marking them", () => {
    const svg = renderGraphSvg(graph(), []);
    expect(svg).toContain('data-resolution="ambiguous"');
    expect(svg).toContain('data-resolution="unresolved"');
    expect(svg.match(/data-resolution="resolved"/g)?.length).toBe(1);
    const doc = parseSvg(svg);
    const ambiguous = doc.querySelector('[data-resolution="ambiguous"]');
    const unresolved = doc.querySelector('[data-resolution="unresolved"]');
    expect(ambiguous!.querySelector("[marker-end]")).toBeNull();
    expect(unresolved!.querySelector("[marker-end]")).toBeNull();
  });

  it("distinguishes added, removed, and modified nodes from unchanged context in a diff, outline-only", () => {
    const diff: CorrelatedDiffEntry[] = [
      { kind: "entity", qualifiedName: "pkg.a.f", left: undefined, right: graph().nodes[1] },
      { kind: "entity", qualifiedName: "pkg.b.g", left: graph().nodes[2], right: undefined },
    ];
    const svg = renderGraphSvg(graph(), diff);
    expect(svg).toContain('data-change-status="added"');
    expect(svg).toContain('data-change-status="removed"');
    expect(svg).toContain('data-change-status="unchanged"');
    const doc = parseSvg(svg);
    const rects = Array.from(doc.querySelectorAll("rect.node-box"));
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) expect(rect.getAttribute("fill")).toBe("none");
  });

  it("limits a sectioned diagram to the chosen scope plus boundary relationships", () => {
    const scoped = sectionScope(graph(), "module:pkg.a");
    expect(scoped.nodes.map((node) => node.id).sort()).toEqual(["function:pkg.a.f", "module:pkg.a"]);
    expect(scoped.edges.some((edge) => edge.kind === "contains")).toBe(true);
  });

  it("filters by scope, relationship kind, and change status without mutating the source graph", () => {
    const original = graph();
    const filtered = filterGraph(original, [], { relationshipKinds: ["call"] });
    expect(filtered.edges.every((edge) => edge.kind === "call")).toBe(true);
    expect(original.edges.length).toBe(4);
  });

  it("keeps only edges whose index-aligned vintage is current", () => {
    const original = graph();
    const vintages: EdgeVintage[] = ["current", "current", "removed", "current"];
    const filtered = filterGraph(original, [], { vintages: ["current"] }, vintages);
    expect(filtered.edges).toEqual(original.edges.filter((_, i) => vintages[i] === "current"));
  });

  it("filters nothing when filter.vintages itself is absent (undefined), regardless of edge vintage data", () => {
    const original = graph();
    expect(filterGraph(original, [], {}, []).edges).toEqual(original.edges);
    expect(filterGraph(original, [], {}, undefined).edges).toEqual(original.edges);
    expect(filterGraph(original, [], {}).edges).toEqual(original.edges);
  });

  it("hides every edge when filter.vintages is explicitly [] (both toolbar checkboxes unchecked)", () => {
    const original = graph();
    const vintages: EdgeVintage[] = ["current", "current", "removed", "current"];
    const filtered = filterGraph(original, [], { vintages: [] }, vintages);
    expect(filtered.edges).toEqual([]);
  });

  it("composes vintage filtering with relationshipKinds as an intersection", () => {
    const original = graph();
    // index 1 = call/resolved (current), index 2 = call/ambiguous (removed), index 3 = call/unresolved (current)
    const vintages: EdgeVintage[] = ["current", "current", "removed", "current"];
    const filtered = filterGraph(original, [], { relationshipKinds: ["call"], vintages: ["current"] }, vintages);
    expect(filtered.edges).toEqual([original.edges[1], original.edges[3]]);
  });
});

describe("nested containment geometry", () => {
  it("lays out a child entity's box fully inside its container's bounds, three levels deep", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);

    function absoluteBox(id: string): { x: number; y: number; w: number; h: number } {
      let x = 0;
      let y = 0;
      let el: Element | null = doc.querySelector(`[data-node-id="${id}"]`);
      const chain: Element[] = [];
      while (el) {
        chain.unshift(el);
        el = el.parentElement?.closest("[data-node-id]") ?? null;
      }
      for (const node of chain) {
        const transform = node.getAttribute("transform") ?? "";
        const match = /translate\(([\d.-]+),([\d.-]+)\)/.exec(transform);
        if (match) {
          x += Number(match[1]);
          y += Number(match[2]);
        }
      }
      const rect = doc.querySelector(`[data-node-id="${id}"] > rect.node-box`)!;
      return { x, y, w: Number(rect.getAttribute("width")), h: Number(rect.getAttribute("height")) };
    }

    const pkg = absoluteBox("package:pkg");
    const mod = absoluteBox("module:pkg.a");
    const cls = absoluteBox("class:pkg.a.C");
    const method = absoluteBox("method:pkg.a.C.m");

    for (const [outer, inner] of [
      [pkg, mod],
      [mod, cls],
      [cls, method],
    ] as const) {
      expect(inner.x).toBeGreaterThanOrEqual(outer.x);
      expect(inner.y).toBeGreaterThanOrEqual(outer.y);
      expect(inner.x + inner.w).toBeLessThanOrEqual(outer.x + outer.w);
      expect(inner.y + inner.h).toBeLessThanOrEqual(outer.y + outer.h);
    }
  });

  it("renders an orphaned node (container filtered out) as a loose root with no placeholder box", () => {
    const orphanNodes: Entity[] = [
      { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", containerId: "package:missing", span },
    ];
    const orphanGraph: AnalysisGraph = { snapshot, nodes: orphanNodes, edges: [], diagnostics: [] };
    const svg = renderGraphSvg(orphanGraph, []);
    expect(svg).toContain('data-node-id="module:pkg.a"');
    expect(svg).not.toContain("package:missing");
    const doc = parseSvg(svg);
    const node = doc.querySelector('[data-node-id="module:pkg.a"]')!;
    expect(node.parentElement?.closest("[data-node-id]")).toBeNull();
  });
});

describe("kind encoding", () => {
  it("encodes stroke-width, stroke-dasharray, and rx per kind; containers are strictly thinner than entities", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const rectFor = (id: string) => doc.querySelector(`[data-node-id="${id}"] > rect.node-box`)!;

    const pkgRect = rectFor("package:pkg");
    const modRect = rectFor("module:pkg.a");
    const clsRect = rectFor("class:pkg.a.C");
    const fnRect = rectFor("function:pkg.a.f");
    const methodRect = rectFor("method:pkg.a.C.m");

    expect(pkgRect.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(modRect.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(clsRect.getAttribute("stroke-dasharray")).toBeNull();
    expect(fnRect.getAttribute("stroke-dasharray")).toBeNull();
    expect(methodRect.getAttribute("stroke-dasharray")).toBeNull();

    const containerWidths = [pkgRect, modRect].map((rect) => Number(rect.getAttribute("stroke-width")));
    const entityWidths = [clsRect, fnRect, methodRect].map((rect) => Number(rect.getAttribute("stroke-width")));
    expect(Math.max(...containerWidths)).toBeLessThan(Math.min(...entityWidths));

    expect(clsRect.getAttribute("rx")).not.toBe(fnRect.getAttribute("rx"));
    expect(Number(clsRect.getAttribute("stroke-width"))).not.toBe(Number(fnRect.getAttribute("stroke-width")));

    expect(methodRect.getAttribute("rx")).not.toBe(fnRect.getAttribute("rx"));
    expect(Number(methodRect.getAttribute("stroke-width"))).not.toBe(Number(fnRect.getAttribute("stroke-width")));
  });

  it("encodes the exact KIND_STYLE table per kind (stroke-width, dasharray, rx)", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const rectFor = (id: string) => doc.querySelector(`[data-node-id="${id}"] > rect.node-box`)!;

    const expected: Record<string, { strokeWidth: string; dasharray: string | null; rx: string }> = {
      "package:pkg": { strokeWidth: "1", dasharray: "2 4", rx: "4" },
      "module:pkg.a": { strokeWidth: "1.5", dasharray: "4 3", rx: "4" },
      "class:pkg.a.C": { strokeWidth: "3.5", dasharray: null, rx: "2" },
      "function:pkg.a.f": { strokeWidth: "2.5", dasharray: null, rx: "10" },
      "method:pkg.a.C.m": { strokeWidth: "2", dasharray: null, rx: "6" },
    };
    for (const [id, style] of Object.entries(expected)) {
      const rect = rectFor(id);
      expect(rect.getAttribute("stroke-width")).toBe(style.strokeWidth);
      expect(rect.getAttribute("stroke-dasharray")).toBe(style.dasharray);
      expect(rect.getAttribute("rx")).toBe(style.rx);
    }
  });

  it("renders every node box outline-only (fill=none) with the status class still present", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const rects = Array.from(doc.querySelectorAll("rect.node-box"));
    expect(rects.length).toBe(nestedGraph().nodes.length);
    for (const rect of rects) {
      expect(rect.getAttribute("fill")).toBe("none");
      expect(rect.getAttribute("class")).toMatch(/status-(added|removed|modified|unchanged)/);
    }
  });
});

describe("directional edges and ambiguity", () => {
  it("draws resolved import/call edges with an arrowhead; ambiguous/unresolved edges have none", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const importEdge = doc.querySelector('[data-edge-kind="import"][data-resolution="resolved"]')!;
    const callEdge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    expect(importEdge.querySelector("path")?.getAttribute("marker-end")).toBeTruthy();
    expect(callEdge.querySelector("path")?.getAttribute("marker-end")).toBeTruthy();
    const importD = importEdge.querySelector("path")!.getAttribute("d")!;
    const callD = callEdge.querySelector("path")!.getAttribute("d")!;
    expect(importD.startsWith("M")).toBe(true);
    expect(importD).toContain("L");
    expect(callD.startsWith("M")).toBe(true);
    expect(callD).toContain("L");
    const ambiguous = doc.querySelector('[data-resolution="ambiguous"]')!;
    const unresolved = doc.querySelector('[data-resolution="unresolved"]')!;
    expect(ambiguous.querySelector("path")?.getAttribute("marker-end")).toBeFalsy();
    expect(unresolved.querySelector("path")?.getAttribute("marker-end")).toBeFalsy();
    expect(ambiguous.querySelector("path")).toBeNull();
    expect(unresolved.querySelector("path")).toBeNull();
    expect(doc.querySelector("[data-relationship-source]")).not.toBeNull();
  });

  it("renders every edge path outline-only (fill=none), never filled with the stroke color", () => {
    // Regression: .edge-import/.edge-call previously shared a combined CSS selector with
    // .arrow-import/.arrow-call (the marker arrowhead), which legitimately needs a fill.
    // A simple 2-point Bezier edge path implicitly closed-and-filled to a barely-visible
    // sliver, but a routed multi-waypoint path (M...L...L...C...) fills to a large,
    // visibly wrong polygon once auto-closed. The edge <path> itself must always be
    // outline-only; only the arrowhead marker triangle should be filled.
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    for (const path of Array.from(doc.querySelectorAll("g.edge path"))) {
      expect(path.getAttribute("fill")).toBe("none");
    }
  });

  it("renders no element for contains edges while surviving edges keep their original graph.edges indices", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const edgeGroups = Array.from(doc.querySelectorAll("g.edge"));
    expect(edgeGroups.length).toBe(4); // 6 edges total, 2 are `contains`
    const indices = edgeGroups.map((g) => g.getAttribute("data-edge-index")).sort();
    expect(indices).toEqual(["2", "3", "4", "5"]);
    for (const g of edgeGroups) expect(g.getAttribute("data-edge-kind")).not.toBe("contains");
  });
});

describe("orthogonal edges", () => {
  function assertOrthogonal(d: string): { say: number; tay: number } {
    expect(d).not.toMatch(/[CQ]/);
    const points = Array.from(d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g), m => ({ x: Number(m[1]), y: Number(m[2]) }));
    for (let i = 1; i < points.length; i++) {
      expect(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y).toBe(true);
    }
    return { say: points[0].y, tay: points.at(-1)!.y };
  }

  it("keeps arrowheads compact independently of connector stroke width", () => {
    const doc = parseSvg(renderGraphSvg(nestedGraph(), []));
    for (const marker of Array.from(doc.querySelectorAll("marker"))) {
      expect(marker.getAttribute("markerUnits")).toBe("userSpaceOnUse");
      expect(Number(marker.getAttribute("markerWidth"))).toBeLessThanOrEqual(8);
    }
  });

  it("renders a resolved edge as a clean orthogonal connector", () => {
    const minimalGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", span },
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.a", resolution: { kind: "resolved", target: "function:pkg.b" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(minimalGraph, []);
    const doc = parseSvg(svg);
    const callEdge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    const path = callEdge.querySelector("path")!;
    const d = path.getAttribute("d")!;
    assertOrthogonal(d);
    expect(path.getAttribute("marker-end")).toBeTruthy();
  });

  it("enters the nearest target boundary when the target sits above the source", () => {
    const upGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.top", kind: "function", qualifiedName: "pkg.top", span },
        { id: "function:pkg.bottom", kind: "function", qualifiedName: "pkg.bottom", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.bottom", resolution: { kind: "resolved", target: "function:pkg.top" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(upGraph, []);
    const doc = parseSvg(svg);
    const edge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    const path = edge.querySelector("path")!;
    const d = path.getAttribute("d")!;
    const { say, tay } = assertOrthogonal(d);
    expect(tay).toBeLessThan(say);
    expect(path.getAttribute("marker-end")).toBeTruthy();
  });
});

describe("node label styling", () => {
  it("emits class=\"node-label\" on every <text> in nested layout", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const texts = Array.from(doc.querySelectorAll("g.node > text"));
    expect(texts.length).toBe(nestedGraph().nodes.length);
    for (const text of texts) expect(text.getAttribute("class")).toBe("node-label");
  });

  it("emits class=\"node-label\" on every <text> in flat layout", () => {
    const nodes: Entity[] = Array.from({ length: NESTED_LAYOUT_LIMITS.nodes + 1 }, (_, index) => ({
      id: `function:pkg.f${index}`,
      kind: "function" as const,
      qualifiedName: `pkg.f${index}`,
      span,
    }));
    const bigGraph: AnalysisGraph = { snapshot, nodes, edges: [], diagnostics: [] };
    const svg = renderGraphSvg(bigGraph, []);
    const doc = parseSvg(svg);
    const texts = Array.from(doc.querySelectorAll("g.node > text"));
    expect(texts.length).toBe(nodes.length);
    for (const text of texts) expect(text.getAttribute("class")).toBe("node-label");
  });

  it("declares a font-family for .node text in styles.css", () => {
    const css = readStylesCss();
    const rule = /\.node\s+text\s*\{[^}]*font-family\s*:/;
    expect(css).toMatch(rule);
  });
});

describe("provenance", () => {
  function provenanceGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [
        { id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", span: { ...span, path: "pkg/a.py" } },
        { id: "module:pkg.b", kind: "module", qualifiedName: "pkg.b", span: { ...span, path: "pkg/b.py" } },
      ],
      edges: [],
      diagnostics: [],
    };
  }

  it("marks an untracked node with data-provenance and a badge circle; a tracked node gets neither", () => {
    const svg = renderGraphSvg(provenanceGraph(), [], ["pkg/a.py"]);
    const doc = parseSvg(svg);
    const untrackedNode = doc.querySelector('[data-node-id="module:pkg.a"]')!;
    const trackedNode = doc.querySelector('[data-node-id="module:pkg.b"]')!;
    expect(untrackedNode.getAttribute("data-provenance")).toBe("untracked");
    expect(untrackedNode.querySelector("circle.provenance-untracked")).not.toBeNull();
    expect(trackedNode.getAttribute("data-provenance")).toBe("tracked");
    expect(trackedNode.querySelector("circle.provenance-untracked")).toBeNull();
  });

  it("composes the provenance badge with a non-unchanged status without altering kind stroke-width", () => {
    const diff: CorrelatedDiffEntry[] = [{ kind: "entity", qualifiedName: "pkg.a", left: provenanceGraph().nodes[0], right: undefined }];
    const svg = renderGraphSvg(provenanceGraph(), diff, ["pkg/a.py"]);
    const doc = parseSvg(svg);
    const node = doc.querySelector('[data-node-id="module:pkg.a"]')!;
    const rect = node.querySelector("rect.node-box")!;
    expect(rect.getAttribute("class")).toBe("node-box status-removed");
    expect(rect.getAttribute("stroke-width")).toBe("1.5");
    expect(node.getAttribute("data-provenance")).toBe("untracked");
    expect(node.querySelector("circle.provenance-untracked")).not.toBeNull();
  });

  it("marks every node tracked when untrackedPaths is omitted", () => {
    const svg = renderGraphSvg(provenanceGraph(), []);
    const doc = parseSvg(svg);
    for (const id of ["module:pkg.a", "module:pkg.b"]) {
      const node = doc.querySelector(`[data-node-id="${id}"]`)!;
      expect(node.getAttribute("data-provenance")).toBe("tracked");
      expect(node.querySelector("circle.provenance-untracked")).toBeNull();
    }
  });
});

describe("CSS custom properties", () => {
  it("declares --acm-* custom properties on :root and status/edge/provenance rules reference them", () => {
    const css = readStylesCss();
    const acmVars = [
      "--acm-status-added",
      "--acm-status-removed",
      "--acm-status-modified",
      "--acm-status-unchanged",
      "--acm-edge-import",
      "--acm-edge-call",
      "--acm-edge-ambiguous",
      "--acm-provenance-untracked",
    ];
    const rootMatch = /:root\s*\{([^}]*)\}/.exec(css);
    expect(rootMatch).not.toBeNull();
    const rootBlock = rootMatch![1];
    for (const name of acmVars) {
      expect(rootBlock).toContain(name);
    }
    expect(css).toMatch(/\.node-box\.status-added\s*\{[^}]*var\(--acm-status-added\)/);
    expect(css).toMatch(/\.node-box\.status-removed\s*\{[^}]*var\(--acm-status-removed\)/);
    expect(css).toMatch(/\.node-box\.status-modified\s*\{[^}]*var\(--acm-status-modified\)/);
    expect(css).toMatch(/\.node-box\.status-unchanged\s*\{[^}]*var\(--acm-status-unchanged\)/);
    expect(css).toMatch(/\.edge-import\s*\{[^}]*var\(--acm-edge-import\)/);
    expect(css).toMatch(/\.arrow-import\s*\{[^}]*var\(--acm-edge-import\)/);
    expect(css).toMatch(/\.edge-call\s*\{[^}]*var\(--acm-edge-call\)/);
    expect(css).toMatch(/\.arrow-call\s*\{[^}]*var\(--acm-edge-call\)/);
    expect(css).toMatch(/\.resolution-ambiguous,\s*\n?\s*\.resolution-unresolved\s*\{[^}]*var\(--acm-edge-ambiguous\)/);
    expect(css).toMatch(/\.provenance-untracked\s*\{[^}]*var\(--acm-provenance-untracked\)/);
  });
});

describe("flat-degradation threshold", () => {
  it("degrades to the flat stack above NESTED_LAYOUT_LIMITS.nodes yet stays outline-only with drawn edges", () => {
    const nodes: Entity[] = Array.from({ length: NESTED_LAYOUT_LIMITS.nodes + 1 }, (_, index) => ({
      id: `function:pkg.f${index}`,
      kind: "function" as const,
      qualifiedName: `pkg.f${index}`,
      span,
    }));
    const edges = [{ kind: "call" as const, source: nodes[0].id, resolution: { kind: "resolved" as const, target: nodes[1].id }, span }];
    const bigGraph: AnalysisGraph = { snapshot, nodes, edges, diagnostics: [] };
    const svg = renderGraphSvg(bigGraph, []);
    const doc = parseSvg(svg);
    const rects = Array.from(doc.querySelectorAll("rect.node-box"));
    expect(rects.length).toBe(nodes.length);
    for (const rect of rects) expect(rect.getAttribute("fill")).toBe("none");
    const edgeGroup = doc.querySelector("g.edge")!;
    expect(edgeGroup.querySelector("path")?.getAttribute("marker-end")).toBeTruthy();
  });
});

describe("edge routing via edgeGeometry", () => {
  it("routes an edge whose straight path crosses an unrelated sibling box with L waypoints", () => {
    // Array order is [target, obstacle, source]: with the source->call->target arc reordering
    // siblings so the target renders above the source (see "sibling ordering" describe block),
    // this order places the obstacle exactly between them post-reorder, matching the direct
    // pre-reorder stacking intent. Nested one level under a module so the top-level connected-
    // component clustering pass (which only reorders root containers and would otherwise pull
    // the connected a/c pair together, eliminating the very obstacle this test needs) never
    // gets a say - the nodes here are siblings of each other, not top-level roots.
    const routingGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "module:pkg", kind: "module", qualifiedName: "pkg", span },
        { id: "function:pkg.c", kind: "function", qualifiedName: "pkg.c", containerId: "module:pkg", span },
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", containerId: "module:pkg", span },
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", containerId: "module:pkg", span },
      ],
      edges: [
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.b" }, span },
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.a" }, span },
        { kind: "call", source: "function:pkg.a", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
      ],
      diagnostics: [],
    };
    const svg = renderGraphSvg(routingGraph, []);
    const doc = parseSvg(svg);
    const edge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    const d = edge.querySelector("path")!.getAttribute("d")!;
    expect(d).toContain("L");
  });

  it("uses the nearest-facing boundaries for a non-crossing aligned edge", () => {
    // A minimal two-node fixture (no other boxes exist to obstruct, regardless of sibling
    // ordering) isolates the wiring proof from the sibling-ordering behavior covered above.
    const minimalGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", span },
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.a", resolution: { kind: "resolved", target: "function:pkg.b" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(minimalGraph, []);
    const doc = parseSvg(svg);
    const callEdge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    const d = callEdge.querySelector("path")!.getAttribute("d")!;
    // An unobstructed aligned pair needs only a straight vertical connector.
    function absoluteBox(id: string): { x: number; y: number; w: number; h: number } {
      const el = doc.querySelector(`[data-node-id="${id}"]`)!;
      const transform = el.getAttribute("transform") ?? "";
      const match = /translate\(([\d.-]+),([\d.-]+)\)/.exec(transform);
      const rect = doc.querySelector(`[data-node-id="${id}"] > rect.node-box`)!;
      return {
        x: Number(match![1]),
        y: Number(match![2]),
        w: Number(rect.getAttribute("width")),
        h: Number(rect.getAttribute("height")),
      };
    }
    const source = absoluteBox("function:pkg.a");
    const target = absoluteBox("function:pkg.b");
    const sax = source.x + source.w / 2;
    const say = source.y < target.y ? source.y + source.h : source.y;
    const tax = target.x + target.w / 2;
    const tay = source.y < target.y ? target.y : target.y + target.h;
    const expected = `M${sax},${say} L${tax},${tay}`;
    expect(d).toBe(expected);
  });
});

describe("sibling ordering", () => {
  function siblingY(doc: Document, id: string): number {
    const el = doc.querySelector(`[data-node-id="${id}"]`)!;
    const transform = el.getAttribute("transform") ?? "";
    const match = /translate\(([\d.-]+),([\d.-]+)\)/.exec(transform);
    return Number(match![2]);
  }

  it("places a sibling ordered after another sibling due to a call edge below it (B->A places A above B)", () => {
    const orderedGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "module:pkg.m", kind: "module", qualifiedName: "pkg.m", span },
        { id: "function:pkg.m.b", kind: "function", qualifiedName: "pkg.m.b", containerId: "module:pkg.m", span },
        { id: "function:pkg.m.a", kind: "function", qualifiedName: "pkg.m.a", containerId: "module:pkg.m", span },
      ],
      edges: [
        { kind: "contains", source: "module:pkg.m", resolution: { kind: "resolved", target: "function:pkg.m.b" }, span },
        { kind: "contains", source: "module:pkg.m", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span },
        { kind: "call", source: "function:pkg.m.b", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span },
      ],
      diagnostics: [],
    };
    const svg = renderGraphSvg(orderedGraph, []);
    const doc = parseSvg(svg);
    const yA = siblingY(doc, "function:pkg.m.a");
    const yB = siblingY(doc, "function:pkg.m.b");
    expect(yA).toBeLessThan(yB);
  });

  it("keeps exact array order for siblings with no non-contains edges between them", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    // nestedGraph's package:pkg module bucket has only one member (module:pkg.a); use the
    // class:pkg.a.C -> method:pkg.a.C.m + function:pkg.a.f bucket under module:pkg.a instead.
    const yClass = siblingY(doc, "class:pkg.a.C");
    const yFn = siblingY(doc, "function:pkg.a.f");
    expect(yClass).toBeLessThan(yFn); // original array order: class before function
  });

  it("emits every sibling exactly once, deterministically, even with a sibling cycle", () => {
    const cyclicGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "module:pkg.m", kind: "module", qualifiedName: "pkg.m", span },
        { id: "function:pkg.m.a", kind: "function", qualifiedName: "pkg.m.a", containerId: "module:pkg.m", span },
        { id: "function:pkg.m.b", kind: "function", qualifiedName: "pkg.m.b", containerId: "module:pkg.m", span },
      ],
      edges: [
        { kind: "contains", source: "module:pkg.m", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span },
        { kind: "contains", source: "module:pkg.m", resolution: { kind: "resolved", target: "function:pkg.m.b" }, span },
        { kind: "call", source: "function:pkg.m.a", resolution: { kind: "resolved", target: "function:pkg.m.b" }, span },
        { kind: "call", source: "function:pkg.m.b", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span },
      ],
      diagnostics: [],
    };
    const svg1 = renderGraphSvg(cyclicGraph, []);
    const svg2 = renderGraphSvg(cyclicGraph, []);
    const doc1 = parseSvg(svg1);
    expect(doc1.querySelectorAll('[data-node-id="function:pkg.m.a"]').length).toBe(1);
    expect(doc1.querySelectorAll('[data-node-id="function:pkg.m.b"]').length).toBe(1);
    expect(svg1).toBe(svg2); // deterministic
  });

  it("applies the same ordering rule to root-level nodes", () => {
    const rootGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", span },
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.b", resolution: { kind: "resolved", target: "function:pkg.a" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(rootGraph, []);
    const doc = parseSvg(svg);
    const yA = siblingY(doc, "function:pkg.a");
    const yB = siblingY(doc, "function:pkg.b");
    expect(yA).toBeLessThan(yB);
  });
});

describe("top-level container clustering", () => {
  function siblingY(doc: Document, id: string): number {
    const el = doc.querySelector(`[data-node-id="${id}"]`)!;
    const transform = el.getAttribute("transform") ?? "";
    const match = /translate\(([\d.-]+),([\d.-]+)\)/.exec(transform);
    return Number(match![2]);
  }

  // Regression: Kahn's sibling sort only reorders two top-level containers relative to each
  // other when a dependency arc directly requires it. Two roots with no arc between them keep
  // an essentially arbitrary tie-broken position (original array index), so a root connected to
  // a distant root by a single call/import edge can still end up with unrelated root containers
  // sandwiched physically between them - exactly the "edge cuts through an unrelated sibling
  // module" bug reported from live testing. Here "moduleD" calls "moduleA" but the original
  // array order is [A, B, C, D] with B and C carrying no edges at all: plain Kahn leaves that
  // order exactly as-is (there is no arc forcing B or C to move), stranding B and C between A
  // and D. A barycenter/connected-component reordering pass should pull A and D adjacent to
  // each other, leaving no other root container's box between them.
  it("clusters two call-connected top-level containers adjacently even with unrelated roots between them in the original order", () => {
    const clusterGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.A", kind: "function", qualifiedName: "pkg.A", span },
        { id: "function:pkg.B", kind: "function", qualifiedName: "pkg.B", span },
        { id: "function:pkg.C", kind: "function", qualifiedName: "pkg.C", span },
        { id: "function:pkg.D", kind: "function", qualifiedName: "pkg.D", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.D", resolution: { kind: "resolved", target: "function:pkg.A" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(clusterGraph, []);
    const doc = parseSvg(svg);
    const order = ["function:pkg.A", "function:pkg.B", "function:pkg.C", "function:pkg.D"]
      .map((id) => ({ id, y: siblingY(doc, id) }))
      .sort((a, b) => a.y - b.y)
      .map((entry) => entry.id);
    const indexA = order.indexOf("function:pkg.A");
    const indexD = order.indexOf("function:pkg.D");
    expect(Math.abs(indexA - indexD)).toBe(1);
  });

  it("leaves two-root graphs exactly as Kahn ordered them (no clustering pass needed or applied)", () => {
    const rootGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", span },
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.b", resolution: { kind: "resolved", target: "function:pkg.a" }, span }],
      diagnostics: [],
    };
    const svg = renderGraphSvg(rootGraph, []);
    const doc = parseSvg(svg);
    expect(siblingY(doc, "function:pkg.a")).toBeLessThan(siblingY(doc, "function:pkg.b"));
  });
});

describe("viewBox", () => {
  it("includes all routed lanes and arrowheads in the nested-layout viewport", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const root = doc.querySelector("svg")!;
    const width = root.getAttribute("width");
    const height = root.getAttribute("height");
    const [x, y, w, h] = root.getAttribute("viewBox")!.split(" ").map(Number);
    expect(w).toBe(Number(width)); expect(h).toBe(Number(height));
    for (const path of Array.from(doc.querySelectorAll("g.edge path"))) {
      for (const match of path.getAttribute("d")!.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
        expect(Number(match[1])).toBeGreaterThanOrEqual(x + 16);
        expect(Number(match[1])).toBeLessThanOrEqual(x + w - 16);
        expect(Number(match[2])).toBeGreaterThanOrEqual(y + 16);
        expect(Number(match[2])).toBeLessThanOrEqual(y + h - 16);
      }
    }
  });

  it("carries viewBox=\"0 0 {width} {height}\" matching width/height on the flat-layout root", () => {
    const nodes: Entity[] = Array.from({ length: NESTED_LAYOUT_LIMITS.nodes + 1 }, (_, index) => ({
      id: `function:pkg.f${index}`,
      kind: "function" as const,
      qualifiedName: `pkg.f${index}`,
      span,
    }));
    const bigGraph: AnalysisGraph = { snapshot, nodes, edges: [], diagnostics: [] };
    const svg = renderGraphSvg(bigGraph, []);
    const doc = parseSvg(svg);
    const root = doc.querySelector("svg")!;
    const width = root.getAttribute("width");
    const height = root.getAttribute("height");
    expect(root.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
  });
});

describe("data-* contract stability", () => {
  it("preserves the full node/edge data-* attribute set with exact current values", () => {
    const svg = renderGraphSvg(nestedGraph(), []);
    const doc = parseSvg(svg);
    const moduleNode = doc.querySelector('[data-node-id="module:pkg.a"]')!;
    expect(moduleNode.getAttribute("data-node-kind")).toBe("module");
    expect(moduleNode.getAttribute("data-change-status")).toBe("unchanged");

    const callEdge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    expect(callEdge.getAttribute("data-edge-index")).not.toBeNull();
    expect(callEdge.getAttribute("data-edge-kind")).toBe("call");
    expect(callEdge.getAttribute("data-resolution")).toBe("resolved");
  });

  it("preserves the full data-* contract, KIND_STYLE, and status classes on a routed fixture", () => {
    const routedGraph: AnalysisGraph = {
      snapshot,
      nodes: [
        { id: "module:pkg", kind: "module", qualifiedName: "pkg", span },
        { id: "function:pkg.c", kind: "function", qualifiedName: "pkg.c", containerId: "module:pkg", span },
        { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", containerId: "module:pkg", span },
        { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", containerId: "module:pkg", span },
      ],
      edges: [
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.b" }, span },
        { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.a" }, span },
        { kind: "call", source: "function:pkg.a", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
      ],
      diagnostics: [],
    };
    const svg = renderGraphSvg(routedGraph, []);
    const doc = parseSvg(svg);
    const edge = doc.querySelector('[data-edge-kind="call"][data-resolution="resolved"]')!;
    const d = edge.querySelector("path")!.getAttribute("d")!;
    expect(d).toContain("L"); // confirm this fixture is genuinely routed

    for (const id of ["function:pkg.a", "function:pkg.b", "function:pkg.c"]) {
      const node = doc.querySelector(`[data-node-id="${id}"]`)!;
      expect(node.getAttribute("data-node-kind")).toBe("function");
      expect(node.getAttribute("data-change-status")).toBe("unchanged");
      expect(node.getAttribute("data-provenance")).toBe("tracked");
      const rect = node.querySelector("rect.node-box")!;
      expect(rect.getAttribute("fill")).toBe("none");
      expect(rect.getAttribute("stroke-width")).toBe("2.5");
      expect(rect.getAttribute("rx")).toBe("10");
      expect(rect.getAttribute("class")).toBe("node-box status-unchanged");
    }
    expect(edge.getAttribute("data-edge-index")).not.toBeNull();
    expect(edge.getAttribute("data-edge-kind")).toBe("call");
    expect(edge.getAttribute("data-resolution")).toBe("resolved");
  });
});

describe("relationship detail indicators", () => {
  it("groups all unavailable endpoints into one accessible source indicator without dangling paths", () => {
    const input = graph();
    input.edges.push({ kind: "import", source: "function:pkg.a.f", resolution: { kind: "resolved", target: "module:outside" }, span });
    const doc = parseSvg(renderGraphSvg(input, []));
    const indicators = doc.querySelectorAll("[data-relationship-source]");
    expect(indicators.length).toBe(1);
    expect(indicators[0].getAttribute("data-relationship-source")).toBe("function:pkg.a.f");
    expect(indicators[0].getAttribute("role")).toBe("button");
    expect(indicators[0].getAttribute("tabindex")).toBe("0");
    expect(indicators[0].getAttribute("aria-label")).toContain("3 relationship");
    expect(doc.querySelectorAll("g.edge path").length).toBe(1);
    expect(doc.querySelector('[data-edge-index="4"]')!.getAttribute("data-resolution")).toBe("resolved");
  });
});

describe("isAncestorSelfReference", () => {
  it("is true for a module -> own class edge (direct containerId parent)", () => {
    const g = selfRefGraph();
    const edge = g.edges[2];
    expect(isAncestorSelfReference(edge, g.nodes)).toBe(true);
  });

  it("is true for a module -> own nested method edge (transitive, multi-step ancestor)", () => {
    const g = selfRefGraph();
    const edge = g.edges[3];
    expect(isAncestorSelfReference(edge, g.nodes)).toBe(true);
  });

  it("is false for a peer function -> sibling function edge in the same file", () => {
    const g = selfRefGraph();
    const edge = g.edges[4];
    expect(isAncestorSelfReference(edge, g.nodes)).toBe(false);
  });

  it("is false for contains-kind edges", () => {
    const g = selfRefGraph();
    expect(isAncestorSelfReference(g.edges[0], g.nodes)).toBe(false);
    expect(isAncestorSelfReference(g.edges[1], g.nodes)).toBe(false);
  });

  it("is false for unresolved and ambiguous edges", () => {
    const g = selfRefGraph();
    const unresolved: Edge = {
      kind: "call",
      source: "module:pkg.a",
      resolution: { kind: "unresolved" },
      span,
    };
    const ambiguous: Edge = {
      kind: "call",
      source: "module:pkg.a",
      resolution: { kind: "ambiguous", candidates: ["class:pkg.a.C", "method:pkg.a.C.m"] },
      span,
    };
    expect(isAncestorSelfReference(unresolved, g.nodes)).toBe(false);
    expect(isAncestorSelfReference(ambiguous, g.nodes)).toBe(false);
  });

  it("is false for an edge referencing an unknown id", () => {
    const g = selfRefGraph();
    const unknown: Edge = {
      kind: "call",
      source: "module:pkg.a",
      resolution: { kind: "resolved", target: "function:does.not.exist" },
      span,
    };
    expect(isAncestorSelfReference(unknown, g.nodes)).toBe(false);
  });

  it("is false and terminates on a containerId cycle (a<->b)", () => {
    const nodes: Entity[] = [
      { id: "cycle:a", kind: "class", qualifiedName: "cycle.a", containerId: "cycle:b", span },
      { id: "cycle:b", kind: "class", qualifiedName: "cycle.b", containerId: "cycle:a", span },
      { id: "peer:c", kind: "function", qualifiedName: "peer.c", span },
    ];
    const edge: Edge = {
      kind: "call",
      source: "peer:c",
      resolution: { kind: "resolved", target: "cycle:a" },
      span,
    };
    expect(isAncestorSelfReference(edge, nodes)).toBe(false);
  });

  it("is false and terminates on a dangling containerId", () => {
    const nodes: Entity[] = [
      { id: "dangling:a", kind: "class", qualifiedName: "dangling.a", containerId: "dangling:missing", span },
      { id: "peer:c", kind: "function", qualifiedName: "peer.c", span },
    ];
    const edge: Edge = {
      kind: "call",
      source: "peer:c",
      resolution: { kind: "resolved", target: "dangling:a" },
      span,
    };
    expect(isAncestorSelfReference(edge, nodes)).toBe(false);
  });

  it("is true when edge.source === edge.resolution.target", () => {
    const g = selfRefGraph();
    const selfEdge: Edge = {
      kind: "call",
      source: "function:pkg.a.f1",
      resolution: { kind: "resolved", target: "function:pkg.a.f1" },
      span,
    };
    expect(isAncestorSelfReference(selfEdge, g.nodes)).toBe(true);
  });
});

describe("suppressAncestorSelfReferences", () => {
  it("drops only the ancestor self-reference edges, leaving nodes untouched", () => {
    const g = selfRefGraph();
    const suppressed = suppressAncestorSelfReferences(g);
    expect(suppressed.nodes).toEqual(g.nodes);
    expect(suppressed.edges).toHaveLength(g.edges.length - 2);
    expect(suppressed.edges).not.toContainEqual(g.edges[2]);
    expect(suppressed.edges).not.toContainEqual(g.edges[3]);
    expect(suppressed.edges).toContainEqual(g.edges[4]);
  });

  it("emits no <g class=\"edge\"> for a suppressed edge, and excludes it from indicator counts", () => {
    const before = selfRefGraph();
    const beforeSvg = renderGraphSvg(before, []);
    const beforeDoc = parseSvg(beforeSvg);
    // Before suppression, both self-reference calls (module -> class, module -> class -> method)
    // are drawn like any other resolved call, alongside the peer edge: 3 drawn call edges.
    expect(beforeDoc.querySelectorAll("g.edge").length).toBe(3);

    const suppressed = suppressAncestorSelfReferences(before);
    const svg = renderGraphSvg(suppressed, []);
    const doc = parseSvg(svg);
    const edgeGroups = Array.from(doc.querySelectorAll("g.edge"));
    // Only the same-file peer edge (f1 -> f2) remains drawable; the two ancestor
    // self-reference edges are gone entirely, not merely hidden.
    expect(edgeGroups).toHaveLength(1);
    expect(edgeGroups[0].querySelector("title")!.textContent).toContain("function:pkg.a.f2");
    // No relationship indicator is created for the suppressed edges either (their targets
    // had boxes, so they would have been drawn, never routed into an indicator).
    expect(doc.querySelector('[data-relationship-source="module:pkg.a"]')).toBeNull();
  });
});
