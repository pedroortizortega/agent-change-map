import { describe, expect, it } from "vitest";
import {
  KIND_STYLE,
  clusterConnectedRoots,
  computeChildrenOf,
  computeLiveDragUpdate,
  isContainerKind,
  layoutGraph,
  measure,
  orderSiblings,
} from "../../webview/graphLayout.js";
import type { AnalysisGraph, Edge, Entity } from "../../src/protocol.js";

const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" };
const span = { path: "pkg/a.py", startByte: 0, endByte: 3, startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };

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

describe("KIND_STYLE / isContainerKind", () => {
  it("encodes the exact per-kind stroke-width/dasharray/rx table", () => {
    expect(KIND_STYLE).toEqual({
      package: { strokeWidth: 1, dasharray: "2 4", rx: 4 },
      module: { strokeWidth: 1.5, dasharray: "4 3", rx: 4 },
      class: { strokeWidth: 3.5, rx: 2 },
      function: { strokeWidth: 2.5, rx: 10 },
      method: { strokeWidth: 2, rx: 6 },
    });
  });

  it("marks exactly the dashed-stroke kinds (package/module) as draggable containers", () => {
    expect(isContainerKind("package")).toBe(true);
    expect(isContainerKind("module")).toBe(true);
    expect(isContainerKind("class")).toBe(false);
    expect(isContainerKind("function")).toBe(false);
    expect(isContainerKind("method")).toBe(false);
  });
});

describe("computeChildrenOf", () => {
  it("buckets nodes by their normalized containerId, treating an orphan (dangling containerId) as a loose root", () => {
    const orphanNodes: Entity[] = [{ id: "module:pkg.a", kind: "module", qualifiedName: "pkg.a", containerId: "package:missing", span }];
    const childrenOf = computeChildrenOf(orphanNodes, []);
    expect(childrenOf.get(undefined)?.map((n) => n.id)).toEqual(["module:pkg.a"]);
    expect(childrenOf.has("package:missing")).toBe(false);
  });

  it("breaks a containerId cycle by treating both cyclic members as loose roots", () => {
    const nodes: Entity[] = [
      { id: "cycle:a", kind: "class", qualifiedName: "cycle.a", containerId: "cycle:b", span },
      { id: "cycle:b", kind: "class", qualifiedName: "cycle.b", containerId: "cycle:a", span },
    ];
    const childrenOf = computeChildrenOf(nodes, []);
    expect(childrenOf.get(undefined)?.map((n) => n.id).sort()).toEqual(["cycle:a", "cycle:b"]);
  });

  it("nests a three-level containment chain under the correct immediate parent", () => {
    const childrenOf = computeChildrenOf(nestedGraph().nodes, nestedGraph().edges);
    expect(childrenOf.get("package:pkg")?.map((n) => n.id)).toEqual(["module:pkg.a"]);
    expect(childrenOf.get("module:pkg.a")?.map((n) => n.id).sort()).toEqual(["class:pkg.a.C", "function:pkg.a.f"]);
    expect(childrenOf.get("class:pkg.a.C")?.map((n) => n.id)).toEqual(["method:pkg.a.C.m"]);
  });
});

describe("orderSiblings", () => {
  it("places a sibling ordered after another sibling due to a call edge below it (B->A places A above B)", () => {
    const byId = new Map<string, Entity>([
      ["function:pkg.m.b", { id: "function:pkg.m.b", kind: "function", qualifiedName: "pkg.m.b", containerId: "module:pkg.m", span }],
      ["function:pkg.m.a", { id: "function:pkg.m.a", kind: "function", qualifiedName: "pkg.m.a", containerId: "module:pkg.m", span }],
    ]);
    const bucket = [byId.get("function:pkg.m.b")!, byId.get("function:pkg.m.a")!];
    const edges: Edge[] = [{ kind: "call", source: "function:pkg.m.b", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span }];
    const ordered = orderSiblings(bucket, edges, byId);
    expect(ordered.map((n) => n.id)).toEqual(["function:pkg.m.a", "function:pkg.m.b"]);
  });

  it("keeps exact array order for siblings with no non-contains edges between them", () => {
    const byId = new Map<string, Entity>([
      ["class:pkg.a.C", { id: "class:pkg.a.C", kind: "class", qualifiedName: "pkg.a.C", containerId: "module:pkg.a", span }],
      ["function:pkg.a.f", { id: "function:pkg.a.f", kind: "function", qualifiedName: "pkg.a.f", containerId: "module:pkg.a", span }],
    ]);
    const bucket = [byId.get("class:pkg.a.C")!, byId.get("function:pkg.a.f")!];
    const ordered = orderSiblings(bucket, [], byId);
    expect(ordered.map((n) => n.id)).toEqual(["class:pkg.a.C", "function:pkg.a.f"]);
  });

  it("emits every sibling exactly once, deterministically, even with a sibling cycle", () => {
    const byId = new Map<string, Entity>([
      ["function:pkg.m.a", { id: "function:pkg.m.a", kind: "function", qualifiedName: "pkg.m.a", containerId: "module:pkg.m", span }],
      ["function:pkg.m.b", { id: "function:pkg.m.b", kind: "function", qualifiedName: "pkg.m.b", containerId: "module:pkg.m", span }],
    ]);
    const bucket = [byId.get("function:pkg.m.a")!, byId.get("function:pkg.m.b")!];
    const edges: Edge[] = [
      { kind: "call", source: "function:pkg.m.a", resolution: { kind: "resolved", target: "function:pkg.m.b" }, span },
      { kind: "call", source: "function:pkg.m.b", resolution: { kind: "resolved", target: "function:pkg.m.a" }, span },
    ];
    const ordered1 = orderSiblings(bucket, edges, byId).map((n) => n.id);
    const ordered2 = orderSiblings(bucket, edges, byId).map((n) => n.id);
    expect(new Set(ordered1)).toEqual(new Set(["function:pkg.m.a", "function:pkg.m.b"]));
    expect(ordered1).toEqual(ordered2); // deterministic
  });
});

describe("clusterConnectedRoots", () => {
  it("clusters two call-connected top-level containers adjacently even with unrelated roots between them in the original order", () => {
    const nodes: Entity[] = [
      { id: "function:pkg.A", kind: "function", qualifiedName: "pkg.A", span },
      { id: "function:pkg.B", kind: "function", qualifiedName: "pkg.B", span },
      { id: "function:pkg.C", kind: "function", qualifiedName: "pkg.C", span },
      { id: "function:pkg.D", kind: "function", qualifiedName: "pkg.D", span },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const edges: Edge[] = [{ kind: "call", source: "function:pkg.D", resolution: { kind: "resolved", target: "function:pkg.A" }, span }];
    const clustered = clusterConnectedRoots(nodes, edges, byId).map((n) => n.id);
    const indexA = clustered.indexOf("function:pkg.A");
    const indexD = clustered.indexOf("function:pkg.D");
    expect(Math.abs(indexA - indexD)).toBe(1);
  });

  it("leaves two-root graphs untouched (no clustering pass needed or applied)", () => {
    const nodes: Entity[] = [
      { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", span },
      { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", span },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const clustered = clusterConnectedRoots(nodes, [], byId);
    expect(clustered).toEqual(nodes);
  });
});

describe("measure", () => {
  it("gives a leaf entity the minimum node box size", () => {
    const leaf: Entity = { id: "function:pkg.a.f", kind: "function", qualifiedName: "pkg.a.f", span };
    const size = measure(leaf, new Map(), new Map());
    expect(size).toEqual({ w: 200, h: 32 });
  });

  it("sizes a container to fit its children with padding and vertical gaps", () => {
    const childrenOf = computeChildrenOf(nestedGraph().nodes, nestedGraph().edges);
    const memo = new Map();
    const classSize = measure({ id: "class:pkg.a.C", kind: "class", qualifiedName: "pkg.a.C", containerId: "module:pkg.a", span }, childrenOf, memo);
    // class:pkg.a.C contains exactly one leaf child (method), so its size is the leaf's box
    // plus the container's own header/padding.
    expect(classSize.w).toBe(2 * 12 + 200);
    expect(classSize.h).toBe(20 + 2 * 10 + 32);
  });
});

describe("routedPaths", () => {
  it("routes an edge whose straight path crosses an unrelated sibling box with L waypoints", () => {
    const nodes: Entity[] = [
      { id: "module:pkg", kind: "module", qualifiedName: "pkg", span },
      { id: "function:pkg.c", kind: "function", qualifiedName: "pkg.c", containerId: "module:pkg", span },
      { id: "function:pkg.b", kind: "function", qualifiedName: "pkg.b", containerId: "module:pkg", span },
      { id: "function:pkg.a", kind: "function", qualifiedName: "pkg.a", containerId: "module:pkg", span },
    ];
    const edges: Edge[] = [
      { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
      { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.b" }, span },
      { kind: "contains", source: "module:pkg", resolution: { kind: "resolved", target: "function:pkg.a" }, span },
      { kind: "call", source: "function:pkg.a", resolution: { kind: "resolved", target: "function:pkg.c" }, span },
    ];
    const routingGraph: AnalysisGraph = { snapshot, nodes, edges, diagnostics: [] };
    const result = layoutGraph({ graph: routingGraph, diff: [], untrackedPaths: [], overrides: new Map() });
    const callEdge = result.edges.find((e) => e.data.kind === "call")!;
    expect(callEdge.data.path).toContain("L");
  });
});

describe("layoutGraph", () => {
  it("lays out a child entity's box fully inside its container's bounds, three levels deep", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const boxOf = (id: string) => result.boxes.get(id)!;
    const pkg = boxOf("package:pkg");
    const mod = boxOf("module:pkg.a");
    const cls = boxOf("class:pkg.a.C");
    const method = boxOf("method:pkg.a.C.m");
    for (const [outer, inner] of [[pkg, mod], [mod, cls], [cls, method]] as const) {
      expect(inner.x).toBeGreaterThanOrEqual(outer.x);
      expect(inner.y).toBeGreaterThanOrEqual(outer.y);
      expect(inner.x + inner.w).toBeLessThanOrEqual(outer.x + outer.w);
      expect(inner.y + inner.h).toBeLessThanOrEqual(outer.y + outer.h);
    }
  });

  it("emits one AcmNode per entity with the exact data-carrying shape", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    expect(result.nodes).toHaveLength(nestedGraph().nodes.length);
    const moduleNode = result.nodes.find((n) => n.id === "module:pkg.a")!;
    expect(moduleNode.type).toBe("acmEntity");
    expect(moduleNode.draggable).toBe(true); // module is a container kind
    expect(moduleNode.selectable).toBe(true);
    expect(moduleNode.data.nodeId).toBe("module:pkg.a");
    expect(moduleNode.data.kind).toBe("module");
    expect(moduleNode.data.container).toBe(true);
    expect(moduleNode.data.parentId).toBe("package:pkg");
    expect(moduleNode.data.status).toBe("unchanged");
    expect(moduleNode.data.provenance).toBe("tracked");

    const rootFn = result.nodes.find((n) => n.id === "function:pkg.b.g")!;
    expect(rootFn.data.parentId).toBeUndefined();
    expect(rootFn.draggable).toBe(false); // function is not a container kind
  });

  it("assigns a strictly greater zIndex to a deeper-nested node than its ancestor", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const byId = new Map(result.nodes.map((n) => [n.id, n] as const));
    expect(byId.get("module:pkg.a")!.zIndex).toBeLessThan(byId.get("class:pkg.a.C")!.zIndex);
    expect(byId.get("class:pkg.a.C")!.zIndex).toBeLessThan(byId.get("method:pkg.a.C.m")!.zIndex);
  });

  it("only emits edges for resolved relationships with both endpoints in view, excluding contains/ambiguous/unresolved", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    // 6 edges total: 2 contains, 1 import (resolved, in view), 1 call (resolved, in view),
    // 1 ambiguous, 1 unresolved -> only the import + call survive as drawn AcmEdge entries.
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((e) => e.data.kind).sort()).toEqual(["call", "import"]);
    for (const edge of result.edges) {
      expect(edge.data.resolution).toBe("resolved");
      expect(edge.type).toBe("acmKind");
      expect(edge.interactionWidth).toBe(16);
      expect(edge.data.pathId).toBe(`acm-edge-path-${edge.data.edgeIndex}`);
    }
  });

  it("counts ambiguous/unresolved/out-of-view relationships toward the source node's relationshipCount", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const fnNode = result.nodes.find((n) => n.id === "function:pkg.a.f")!;
    // function:pkg.a.f has one resolved-in-view call (not counted) plus one ambiguous and one
    // unresolved call (both counted) -> relationshipCount === 2.
    expect(fnNode.data.relationshipCount).toBe(2);
  });

  it("applies an absolute override position on top of the computed layout position", () => {
    const overrides = new Map([["function:pkg.b.g", { x: 999, y: 111 }]]);
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides });
    const overridden = result.nodes.find((n) => n.id === "function:pkg.b.g")!;
    expect(overridden.position).toEqual({ x: 999, y: 111 });
    // boxes (used for re-routing) stay at the computed layout position, not the override.
    expect(result.boxes.get("function:pkg.b.g")).not.toEqual({ x: 999, y: 111, w: 200, h: 32 });
  });

  it("routes edges against the OVERRIDDEN position, not the stale pre-drag box (regression: edges disconnected from a dragged/refresh-hydrated node)", () => {
    const overrides = new Map([["function:pkg.b.g", { x: 999, y: 111 }]]);
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides });
    const importEdge = result.edges.find((e) => e.data.kind === "import")!;
    // The import edge's target is the overridden node ("function:pkg.b.g"), a 200x32 box whose
    // absolute top-left the override moves to (999, 111). Wherever exactly on that box's border
    // the router anchors (top-center, a side lane, ...), the path's terminal point must land
    // somewhere on/around THAT box — not near the node's stale, pre-override computed box (which
    // sits close to the small nested-graph origin, far outside this range either way).
    const numbers = importEdge.data.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const lastX = numbers[numbers.length - 2];
    const lastY = numbers[numbers.length - 1];
    expect(lastX).toBeGreaterThanOrEqual(999 - 1);
    expect(lastX).toBeLessThanOrEqual(999 + 200 + 1);
    expect(lastY).toBeGreaterThanOrEqual(111 - 1);
    expect(lastY).toBeLessThanOrEqual(111 + 32 + 1);
  });

  it("marks untracked nodes via data.provenance from untrackedPaths", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: ["pkg/a.py"], overrides: new Map() });
    for (const node of result.nodes) expect(node.data.provenance).toBe("untracked");
  });

  it("degrades to a flat stack above NESTED_LAYOUT_LIMITS.nodes, still emitting drawn edges", () => {
    const nodes: Entity[] = Array.from({ length: 61 }, (_, index) => ({
      id: `function:pkg.f${index}`,
      kind: "function" as const,
      qualifiedName: `pkg.f${index}`,
      span,
    }));
    const edges: Edge[] = [{ kind: "call", source: nodes[0].id, resolution: { kind: "resolved", target: nodes[1].id }, span }];
    const bigGraph: AnalysisGraph = { snapshot, nodes, edges, diagnostics: [] };
    const result = layoutGraph({ graph: bigGraph, diff: [], untrackedPaths: [], overrides: new Map() });
    expect(result.flat).toBe(true);
    expect(result.nodes).toHaveLength(nodes.length);
    expect(result.edges).toHaveLength(1);
    expect(result.boxes.get(nodes[1].id)).toEqual({ x: 16, y: 24 + 48, w: 220, h: 32 });
  });

  it("does not degrade to flat at or below NESTED_LAYOUT_LIMITS.nodes", () => {
    const result = layoutGraph({ graph: nestedGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    expect(result.flat).toBe(false);
  });
});

describe("computeLiveDragUpdate", () => {
  /** Regression coverage for the live-drag visual-freeze bug: `<ReactFlow nodes={...}>` is fed
   * from `layoutGraph`'s own absolute-position output, which never reflects React Flow's own
   * in-progress drag position — only the committed `positionOverrides` written on drop. Without
   * this function's result being merged back into whatever feeds the `nodes` prop, a dragged
   * box visually snaps back to its pre-drag position on every re-render mid-gesture (looking
   * static), while any edge-preview logic reading a DIFFERENT position than what's rendered
   * produces edges detached from both the box and the pointer — exactly the reported symptom. */
  function twoFunctionGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [
        { id: "function:pkg.f", kind: "function", qualifiedName: "pkg.f", span },
        { id: "function:pkg.g", kind: "function", qualifiedName: "pkg.g", span },
      ],
      edges: [{ kind: "call", source: "function:pkg.f", resolution: { kind: "resolved", target: "function:pkg.g" }, span }],
      diagnostics: [],
    };
  }

  it("reports the dragged node's exact live position, not the stale pre-drag layout position", () => {
    const layout = layoutGraph({ graph: twoFunctionGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const before = layout.boxes.get("function:pkg.f")!;
    const livePosition = { x: before.x + 500, y: before.y + 300 };

    const update = computeLiveDragUpdate({
      layout,
      overrides: new Map(),
      nodeId: "function:pkg.f",
      position: livePosition,
      movedDescendantIds: [],
    });

    expect(update).toBeDefined();
    expect(update!.position).toEqual(livePosition);
    expect(update!.position).not.toEqual({ x: before.x, y: before.y });
  });

  it("re-anchors edges touching the dragged node against the LIVE position, not the stale committed box", () => {
    const layout = layoutGraph({ graph: twoFunctionGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const staleEdge = layout.edges.find((edge) => edge.source === "function:pkg.f")!;
    const before = layout.boxes.get("function:pkg.f")!;
    const livePosition = { x: before.x + 500, y: before.y + 300 };

    const update = computeLiveDragUpdate({
      layout,
      overrides: new Map(),
      nodeId: "function:pkg.f",
      position: livePosition,
      movedDescendantIds: [],
    });

    const liveEdge = update!.edgeOverrides.get(staleEdge.data.edgeIndex);
    expect(liveEdge).toBeDefined();
    // The re-anchored edge must actually move with the live position — not stay pinned at the
    // stale, pre-drag anchor (which is exactly the "lines offset from where you're dragging"
    // symptom the user reported).
    expect(liveEdge!.startPoint).not.toEqual(staleEdge.data.startPoint);
  });

  it("leaves edges that do not touch the dragged node (or its cascaded descendants) untouched", () => {
    const layout = layoutGraph({ graph: twoFunctionGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const before = layout.boxes.get("function:pkg.f")!;

    const update = computeLiveDragUpdate({
      layout,
      overrides: new Map(),
      nodeId: "function:pkg.f",
      position: { x: before.x + 500, y: before.y + 300 },
      movedDescendantIds: [],
    });

    // Only the one edge touching "function:pkg.f" exists in this fixture, and it DOES get an
    // override; a node with no edges at all produces an empty override map.
    const isolatedUpdate = computeLiveDragUpdate({
      layout: { boxes: layout.boxes, edges: [] },
      overrides: new Map(),
      nodeId: "function:pkg.g",
      position: { x: 0, y: 0 },
      movedDescendantIds: [],
    });
    expect(update!.edgeOverrides.size).toBe(1);
    expect(isolatedUpdate!.edgeOverrides.size).toBe(0);
  });

  it("returns undefined for a node absent from the layout's boxes", () => {
    const layout = layoutGraph({ graph: twoFunctionGraph(), diff: [], untrackedPaths: [], overrides: new Map() });
    const update = computeLiveDragUpdate({
      layout,
      overrides: new Map(),
      nodeId: "function:pkg.does-not-exist",
      position: { x: 0, y: 0 },
      movedDescendantIds: [],
    });
    expect(update).toBeUndefined();
  });
});
