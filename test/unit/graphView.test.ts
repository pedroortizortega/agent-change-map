import { describe, expect, it } from "vitest";
import { buildCspMetaTag } from "../../webview/graphView.js";
import { renderGraphSvg, sectionScope, filterGraph } from "../../webview/graphView.js";
import type { AnalysisGraph } from "../../src/protocol.js";
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
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "ambiguous", candidates: ["function:pkg.b.g", "function:pkg.c.h"] }, span },
      { kind: "call", source: "function:pkg.a.f", resolution: { kind: "unresolved" }, span },
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
  it("renders every node and edge of a whole-project map as SVG", () => {
    const svg = renderGraphSvg(graph(), []);
    expect(svg).toContain("<svg");
    expect(svg).toContain('data-node-id="module:pkg.a"');
    expect(svg).toContain('data-node-id="function:pkg.a.f"');
    expect(svg).toContain('data-node-id="function:pkg.b.g"');
  });

  it("explicitly marks ambiguous and unresolved edges rather than hiding them", () => {
    const svg = renderGraphSvg(graph(), []);
    expect(svg).toContain('data-resolution="ambiguous"');
    expect(svg).toContain('data-resolution="unresolved"');
    expect(svg.match(/data-resolution="resolved"/g)?.length).toBe(1);
  });

  it("distinguishes added, removed, and modified nodes from unchanged context in a diff", () => {
    const diff: CorrelatedDiffEntry[] = [
      { kind: "entity", qualifiedName: "pkg.a.f", left: undefined, right: graph().nodes[1] },
      { kind: "entity", qualifiedName: "pkg.b.g", left: graph().nodes[2], right: undefined },
    ];
    const svg = renderGraphSvg(graph(), diff);
    expect(svg).toContain('data-change-status="added"');
    expect(svg).toContain('data-change-status="removed"');
    expect(svg).toContain('data-change-status="unchanged"');
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
    expect(original.edges.length).toBe(3);
  });
});

it("lays relationship text below every node box", () => {
  const svg = renderGraphSvg(graph(), []);
  const edgeY = [...svg.matchAll(/class="edge-label [^"]+" x="\d+" y="(\d+)"/g)].map(match => Number(match[1]));
  expect(Math.min(...edgeY)).toBeGreaterThan(24 + (graph().nodes.length - 1) * 48 + 32);
});
