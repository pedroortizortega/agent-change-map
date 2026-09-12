import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { AcmEntityNode } from "../../webview/nodes/AcmEntityNode.js";
import type { AcmNode } from "../../webview/graphLayout.js";

/** PR2b-ii: `AcmEntityNode` now renders `<Handle>` (so React Flow can compute edge connection
 * points — see index.tsx's doc comment on `HANDLE_STYLE`), which throws outside a
 * `ReactFlowProvider`. */
function renderNode(props: NodeProps<AcmNode>) {
  return render(<ReactFlowProvider><AcmEntityNode {...props} /></ReactFlowProvider>);
}

function makeProps(overrides: Partial<AcmNode["data"]> = {}): NodeProps<AcmNode> {
  const data: AcmNode["data"] = {
    nodeId: "n1",
    kind: "function",
    qualifiedName: "pkg.mod.fn",
    status: "unchanged",
    provenance: "tracked",
    container: false,
    parentId: undefined,
    relationshipCount: 0,
    box: { x: 0, y: 0, w: 120, h: 40 },
    ...overrides,
  };
  return {
    id: data.nodeId,
    type: "acmEntity",
    data,
    selected: false,
    isConnectable: true,
    zIndex: 0,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: data.box.w,
    height: data.box.h,
  } as unknown as NodeProps<AcmNode>;
}

describe("AcmEntityNode", () => {
  it("exposes the node/kind/change-status data-attribute contract", () => {
    const { container } = renderNode(makeProps({ nodeId: "n42", kind: "class", status: "modified" }));
    const el = container.querySelector('[data-node-id="n42"]');
    expect(el).toBeTruthy();
    expect(el?.getAttribute("data-node-kind")).toBe("class");
    expect(el?.getAttribute("data-change-status")).toBe("modified");
    expect(el?.getAttribute("data-provenance")).toBe("tracked");
  });

  it("renders a leaf node (container: false) without the container marker", () => {
    const { container } = renderNode(makeProps({ container: false, kind: "function" }));
    const el = container.querySelector('[data-node-id="n1"]');
    expect(el?.classList.contains("acm-node-container")).toBe(false);
    expect(el?.classList.contains("acm-node-leaf")).toBe(true);
  });

  it("renders a container node (container: true) with the container marker and a dashed stroke", () => {
    const { container } = renderNode(makeProps({ container: true, kind: "module" }));
    const el = container.querySelector('[data-node-id="n1"]');
    expect(el?.classList.contains("acm-node-container")).toBe(true);
    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("stroke-dasharray")).toBeTruthy();
  });

  it("does not set a dasharray for a non-container kind", () => {
    const { container } = renderNode(makeProps({ container: false, kind: "function" }));
    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("stroke-dasharray")).toBeFalsy();
  });

  it("shows a provenance marker for untracked nodes and hides it for tracked ones", () => {
    const untracked = renderNode(makeProps({ provenance: "untracked" }));
    expect(untracked.container.querySelector(".acm-node-provenance-untracked")).toBeTruthy();

    const tracked = renderNode(makeProps({ provenance: "tracked" }));
    expect(tracked.container.querySelector(".acm-node-provenance-untracked")).toBeFalsy();
  });

  it("shows a relationship indicator only when relationshipCount is greater than zero", () => {
    const withRelationships = renderNode(makeProps({ relationshipCount: 3 }));
    expect(withRelationships.container.querySelector(".acm-node-relationship-indicator")).toBeTruthy();

    const withoutRelationships = renderNode(makeProps({ relationshipCount: 0 }));
    expect(withoutRelationships.container.querySelector(".acm-node-relationship-indicator")).toBeFalsy();
  });

  it("renders the qualified name as the label text", () => {
    const { container } = renderNode(makeProps({ qualifiedName: "pkg.mod.Widget" }));
    expect(container.textContent).toContain("pkg.mod.Widget");
  });
});
