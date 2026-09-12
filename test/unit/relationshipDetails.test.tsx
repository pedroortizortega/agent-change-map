import React from "react";
import { render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { suppressAncestorSelfReferences } from "../../webview/graphFilters.js";
import { layoutGraph, type AcmNode } from "../../webview/graphLayout.js";
import { AcmEntityNode } from "../../webview/nodes/AcmEntityNode.js";
import { bindRelationshipDetails } from "../../webview/relationshipDetails.js";
import type { AnalysisGraph, SourceId } from "../../src/protocol.js";

/**
 * PR4 (design.md D10, File Changes table: "Bind against React-rendered container"): this suite
 * now runs `graph` through the real `layoutGraph` (the exact function `index.tsx` calls) and
 * renders every resulting `AcmNode` through the real `AcmEntityNode` component via
 * `@testing-library/react` — the same production pipeline that produces the
 * `.acm-node-relationship-indicator` badge and its `data-relationship-source` attribute.
 * `bindRelationshipDetails` itself stays untouched (D10: it deliberately stays imperative,
 * bound once from `useEffect` against a container ref) — only what this suite renders changes,
 * from PR2b-ii's hand-authored `<g data-relationship-source>` stand-in markup to a real render.
 */
function renderIndicators(graph: AnalysisGraph) {
  const { nodes } = layoutGraph({ graph, diff: [], untrackedPaths: [], overrides: new Map() });
  return render(
    <ReactFlowProvider>
      <div>
        {nodes.map((node) => (
          <AcmEntityNode key={node.id} {...(node as unknown as NodeProps<AcmNode>)} />
        ))}
      </div>
    </ReactFlowProvider>,
  );
}

const span = { path: "a.py", startByte: 0, endByte: 4, startLine: 7, startColumn: 2, endLine: 7, endColumn: 6 };
const graph: AnalysisGraph = {
  snapshot: { repoId: "repo", kind: "worktree", contentDigest: "sha256:x" },
  nodes: [{ id: "a", kind: "function", qualifiedName: "a", span }],
  edges: [
    { kind: "call", source: "a", resolution: { kind: "unresolved" }, span },
    { kind: "call", source: "a", resolution: { kind: "ambiguous", candidates: ["<img src=x onerror=alert(1)>", "b"] }, span },
    { kind: "import", importedName: "package.example", source: "a", resolution: { kind: "resolved", target: "outside" }, span },
  ], diagnostics: [],
};
function setup() {
  const { container } = renderIndicators(graph);
  const navigated: number[] = [];
  const dispose = bindRelationshipDetails(container, graph, [{ sourceId: {} as SourceId, side: "right" }, undefined, undefined], index => navigated.push(index));
  const indicator = container.querySelector<SVGElement>("[data-relationship-source]")!;
  const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return { container, navigated, dispose, indicator, click };
}

describe("relationship details popup", () => {
  it("renders the real AcmEntityNode badge with EDGE_STYLE_UNRESOLVED's indicator-chrome contract (D12: indicator-only, never a drawn edge)", () => {
    const { indicator } = setup();
    expect(indicator.classList.contains("acm-node-relationship-indicator")).toBe(true);
    expect(indicator.getAttribute("data-relationship-source")).toBe("a");
    expect(indicator.getAttribute("role")).toBe("button");
    expect(indicator.getAttribute("aria-haspopup")).toBe("dialog");
    // No drawn edge exists for any of these three relationships (all ambiguous/unresolved, or
    // resolved-but-out-of-view) — layoutGraph must never have emitted an AcmEdge for them.
    const { edges } = layoutGraph({ graph, diff: [], untrackedPaths: [], overrides: new Map() });
    expect(edges).toHaveLength(0);
  });

  it("lists each reason truthfully, escapes text, and only navigates an available recorded location", () => {
    const { navigated, indicator, click, dispose } = setup();
    let nodeClicks = 0; indicator.ownerDocument.addEventListener("click", () => nodeClicks++, true);
    click(indicator);
    const popup = document.querySelector('[role="dialog"]')!;
    expect(popup.querySelectorAll("li")).toHaveLength(3);
    expect(popup.textContent).toContain("Unresolved target");
    expect(popup.textContent).toContain("Ambiguous target");
    expect(popup.textContent).toContain("Known target outside current view: outside");
    expect(popup.textContent).toContain("Import package.example");
    expect(popup.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(popup.querySelector("img")).toBeNull();
    const navigate = [...popup.querySelectorAll("button")].filter(button => button.textContent === "View in code");
    expect(navigate).toHaveLength(1);
    click(navigate[0]);
    expect(navigated).toEqual([0]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(indicator);
    dispose();
  });

  it("supports keyboard activation, Escape, close button, outside click, focus restoration and cleanup", () => {
    const { indicator, click, dispose } = setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    for (const key of ["Enter", " "]) {
      indicator.focus();
      indicator.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(indicator.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close relationship details");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(indicator);
    }
    click(indicator); click(document.querySelector('[aria-label="Close relationship details"]')!);
    expect(indicator.getAttribute("aria-expanded")).toBe("false");
    click(indicator); click(outside);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    click(indicator); dispose(); click(indicator);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    outside.remove();
  });
});

describe("relationship details popup - ancestor self-reference suppression regression", () => {
  const moduleId = "module:pkg.a";
  const classId = "class:pkg.a.C";
  const orphanId = "function:pkg.a.orphan";
  const rawGraph: AnalysisGraph = {
    snapshot: { repoId: "repo", kind: "worktree", contentDigest: "sha256:x" },
    nodes: [
      { id: moduleId, kind: "module", qualifiedName: "pkg.a", span },
      { id: classId, kind: "class", qualifiedName: "pkg.a.C", containerId: moduleId, span },
      { id: orphanId, kind: "function", qualifiedName: "pkg.a.orphan", span },
    ],
    edges: [
      { kind: "contains", source: moduleId, resolution: { kind: "resolved", target: classId }, span },
      // Ancestor self-reference: module is the direct containerId parent of class.
      { kind: "call", source: moduleId, resolution: { kind: "resolved", target: classId }, span },
      { kind: "call", source: classId, resolution: { kind: "unresolved" }, span },
      { kind: "call", source: orphanId, resolution: { kind: "ambiguous", candidates: ["x", "y"] }, span },
    ],
    diagnostics: [],
  };

  it("produces a popup with no <li> for the suppressed edge, and edgeIndex values address the correct (suppressed-array) edges", () => {
    const graph = suppressAncestorSelfReferences(rawGraph);
    // The ancestor self-reference is gone; only the unresolved and ambiguous edges remain
    // alongside the contains edge, shifted down by one position.
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges.some(edge => edge.kind === "call" && edge.source === moduleId && edge.resolution.kind === "resolved" && edge.resolution.target === classId)).toBe(false);

    const { container } = renderIndicators(graph);
    const edgeSources = graph.edges.map(() => undefined);
    const dispose = bindRelationshipDetails(container, graph, edgeSources, () => {});

    // The module's only relationship was the suppressed self-reference; it has no indicator.
    expect(container.querySelector(`[data-relationship-source="${moduleId}"]`)).toBeNull();

    // The class's remaining unresolved edge is listed, addressing its correct position in
    // the already-suppressed `graph.edges` array (index 1, not its pre-suppression index 2).
    const classIndicator = container.querySelector<SVGElement>(`[data-relationship-source="${classId}"]`)!;
    expect(classIndicator).not.toBeNull();
    classIndicator.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const popup = document.querySelector('[role="dialog"]')!;
    const items = Array.from(popup.querySelectorAll("li"));
    expect(items).toHaveLength(1);
    const expectedIndex = graph.edges.findIndex(edge => edge.resolution.kind === "unresolved");
    expect(items[0].getAttribute("data-edge-index")).toBe(String(expectedIndex));
    dispose();
  });
});
