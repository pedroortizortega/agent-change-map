import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderGraphSvg, suppressAncestorSelfReferences } from "../../webview/graphView.js";
import { bindRelationshipDetails } from "../../webview/relationshipDetails.js";
import type { AnalysisGraph, SourceId } from "../../src/protocol.js";

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
  const dom = new JSDOM(`<main>${renderGraphSvg(graph, [])}</main><button id="outside">Outside</button>`, { pretendToBeVisual: true });
  const root = dom.window.document.querySelector("main")!;
  const navigated: number[] = [];
  const dispose = bindRelationshipDetails(root, graph, [{ sourceId: {} as SourceId, side: "right" }, undefined, undefined], index => navigated.push(index));
  const indicator = root.querySelector<SVGElement>("[data-relationship-source]")!;
  const click = (element: Element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return { dom, root, navigated, dispose, indicator, click };
}

describe("relationship details popup", () => {
  it("lists each reason truthfully, escapes text, and only navigates an available recorded location", () => {
    const { dom, root, navigated, indicator, click, dispose } = setup();
    let nodeClicks = 0; root.addEventListener("click", () => nodeClicks++);
    click(indicator);
    const popup = dom.window.document.querySelector('[role="dialog"]')!;
    expect(nodeClicks).toBe(0);
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
    expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(dom.window.document.activeElement).toBe(indicator);
    dispose(); dom.window.close();
  });

  it("supports keyboard activation, Escape, close button, outside click, focus restoration and cleanup", () => {
    const { dom, indicator, click, dispose } = setup();
    const doc = dom.window.document;
    for (const key of ["Enter", " "]) {
      indicator.focus();
      indicator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
      expect(indicator.getAttribute("aria-expanded")).toBe("true");
      expect(doc.activeElement?.getAttribute("aria-label")).toBe("Close relationship details");
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
      expect(doc.activeElement).toBe(indicator);
    }
    click(indicator); click(doc.querySelector('[aria-label="Close relationship details"]')!);
    expect(indicator.getAttribute("aria-expanded")).toBe("false");
    click(indicator); click(doc.querySelector("#outside")!);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    click(indicator); dispose(); click(indicator);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    dom.window.close();
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

    const dom = new JSDOM(`<main>${renderGraphSvg(graph, [])}</main>`, { pretendToBeVisual: true });
    const root = dom.window.document.querySelector("main")!;
    const edgeSources = graph.edges.map(() => undefined);
    const dispose = bindRelationshipDetails(root, graph, edgeSources, () => {});

    // The module's only relationship was the suppressed self-reference; it has no indicator.
    expect(root.querySelector(`[data-relationship-source="${moduleId}"]`)).toBeNull();

    // The class's remaining unresolved edge is listed, addressing its correct position in
    // the already-suppressed `graph.edges` array (index 1, not its pre-suppression index 2).
    const classIndicator = root.querySelector<SVGElement>(`[data-relationship-source="${classId}"]`)!;
    expect(classIndicator).not.toBeNull();
    classIndicator.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const popup = dom.window.document.querySelector('[role="dialog"]')!;
    const items = Array.from(popup.querySelectorAll("li"));
    expect(items).toHaveLength(1);
    const expectedIndex = graph.edges.findIndex(edge => edge.resolution.kind === "unresolved");
    expect(items[0].getAttribute("data-edge-index")).toBe(String(expectedIndex));
    dispose(); dom.window.close();
  });
});
