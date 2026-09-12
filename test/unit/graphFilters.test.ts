import { describe, expect, it } from "vitest";
import {
  buildCspMetaTag,
  changeStatusFor,
  filterGraph,
  isAncestorSelfReference,
  sectionScope,
  suppressAncestorSelfReferences,
  NESTED_LAYOUT_LIMITS,
} from "../../webview/graphFilters.js";
import type { EdgeVintage } from "../../webview/graphFilters.js";
import type { AnalysisGraph, Edge, Entity } from "../../src/protocol.js";
import type { CorrelatedDiffEntry } from "../../src/navigation/sourceProvider.js";

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

/**
 * Module -> class -> method containment chain, plus two peer functions in the same file that
 * are not each other's ancestor/descendant. Used to exercise `isAncestorSelfReference` and
 * `suppressAncestorSelfReferences`.
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

describe("NESTED_LAYOUT_LIMITS", () => {
  it("carries the exact nested-vs-flat degradation thresholds", () => {
    expect(NESTED_LAYOUT_LIMITS).toEqual({ nodes: 60, edges: 120 });
  });
});

describe("changeStatusFor", () => {
  it("classifies an entity present only on the right side as added", () => {
    const diff: CorrelatedDiffEntry[] = [{ kind: "entity", qualifiedName: "pkg.a.f", left: undefined, right: graph().nodes[1] }];
    expect(changeStatusFor("pkg.a.f", diff)).toBe("added");
  });

  it("classifies an entity present only on the left side as removed", () => {
    const diff: CorrelatedDiffEntry[] = [{ kind: "entity", qualifiedName: "pkg.b.g", left: graph().nodes[2], right: undefined }];
    expect(changeStatusFor("pkg.b.g", diff)).toBe("removed");
  });

  it("classifies an entity present on both sides as modified", () => {
    const diff: CorrelatedDiffEntry[] = [{ kind: "entity", qualifiedName: "pkg.a.f", left: graph().nodes[1], right: graph().nodes[1] }];
    expect(changeStatusFor("pkg.a.f", diff)).toBe("modified");
  });

  it("classifies an entity absent from the diff entirely as unchanged", () => {
    expect(changeStatusFor("pkg.a.f", [])).toBe("unchanged");
  });
});

describe("sectionScope", () => {
  it("limits a sectioned diagram to the chosen scope plus boundary relationships", () => {
    const scoped = sectionScope(graph(), "module:pkg.a");
    expect(scoped.nodes.map((node) => node.id).sort()).toEqual(["function:pkg.a.f", "module:pkg.a"]);
    expect(scoped.edges.some((edge) => edge.kind === "contains")).toBe(true);
  });
});

describe("filterGraph", () => {
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
    const vintages: EdgeVintage[] = ["current", "current", "removed", "current"];
    const filtered = filterGraph(original, [], { relationshipKinds: ["call"], vintages: ["current"] }, vintages);
    expect(filtered.edges).toEqual([original.edges[1], original.edges[3]]);
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
    const unresolved: Edge = { kind: "call", source: "module:pkg.a", resolution: { kind: "unresolved" }, span };
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
    const unknown: Edge = { kind: "call", source: "module:pkg.a", resolution: { kind: "resolved", target: "function:does.not.exist" }, span };
    expect(isAncestorSelfReference(unknown, g.nodes)).toBe(false);
  });

  it("is false and terminates on a containerId cycle (a<->b)", () => {
    const nodes: Entity[] = [
      { id: "cycle:a", kind: "class", qualifiedName: "cycle.a", containerId: "cycle:b", span },
      { id: "cycle:b", kind: "class", qualifiedName: "cycle.b", containerId: "cycle:a", span },
      { id: "peer:c", kind: "function", qualifiedName: "peer.c", span },
    ];
    const edge: Edge = { kind: "call", source: "peer:c", resolution: { kind: "resolved", target: "cycle:a" }, span };
    expect(isAncestorSelfReference(edge, nodes)).toBe(false);
  });

  it("is false and terminates on a dangling containerId", () => {
    const nodes: Entity[] = [
      { id: "dangling:a", kind: "class", qualifiedName: "dangling.a", containerId: "dangling:missing", span },
      { id: "peer:c", kind: "function", qualifiedName: "peer.c", span },
    ];
    const edge: Edge = { kind: "call", source: "peer:c", resolution: { kind: "resolved", target: "dangling:a" }, span };
    expect(isAncestorSelfReference(edge, nodes)).toBe(false);
  });

  it("is true when edge.source === edge.resolution.target", () => {
    const g = selfRefGraph();
    const selfEdge: Edge = { kind: "call", source: "function:pkg.a.f1", resolution: { kind: "resolved", target: "function:pkg.a.f1" }, span };
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
});
