import type { AnalysisGraph, Edge, Entity } from "../src/protocol.js";
import type { CorrelatedDiffEntry } from "../src/navigation/sourceProvider.js";
import { edgePathsFor, type Rect } from "./edgeGeometry.js";
import { changeStatusFor, NESTED_LAYOUT_LIMITS, type ChangeStatus } from "./graphFilters.js";

export interface Position {
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

// Nested containment layout constants (see design.md "Graph Layout Algorithm").
const NODE_H = 32;
const HEADER_H = 20;
const PAD_X = 12;
const PAD_Y = 10;
const GAP_Y = 8;
const NODE_MIN_W = 200;
const ROOT_GAP = 24;
const MARGIN = 16;

interface KindStyle {
  strokeWidth: number;
  dasharray?: string;
  rx: number;
}

export const KIND_STYLE: Record<Entity["kind"], KindStyle> = {
  package: { strokeWidth: 1, dasharray: "2 4", rx: 4 },
  module: { strokeWidth: 1.5, dasharray: "4 3", rx: 4 },
  class: { strokeWidth: 3.5, rx: 2 },
  function: { strokeWidth: 2.5, rx: 10 },
  method: { strokeWidth: 2, rx: 6 },
};

/**
 * The single source of truth for which kinds are draggable containers: exactly the dashed-
 * stroke kinds in `KIND_STYLE` (currently `package`/`module`). Derived from `KIND_STYLE` rather
 * than duplicated as a separate hardcoded list, so the dashed-stroke convention and the
 * draggable convention can never drift apart.
 */
export function isContainerKind(kind: Entity["kind"]): boolean {
  return KIND_STYLE[kind].dasharray !== undefined;
}

/**
 * containerId normalized to `undefined` when absent, referencing a filtered-out/unknown
 * node (orphan), or part of a containment cycle (cycle guard mirroring `sectionScope`'s
 * existing seen-set walk) - all three cases are treated as loose roots with no placeholder.
 */
export function computeChildrenOf(nodes: Entity[], edges: readonly Edge[] = []): Map<string | undefined, Entity[]> {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const map = new Map<string | undefined, Entity[]>();
  for (const node of nodes) {
    let containerId = node.containerId;
    if (containerId !== undefined && !byId.has(containerId)) containerId = undefined;
    if (containerId !== undefined) {
      const seen = new Set<string>([node.id]);
      let current: Entity | undefined = byId.get(containerId);
      let cyclic = false;
      while (current) {
        if (seen.has(current.id)) {
          cyclic = true;
          break;
        }
        seen.add(current.id);
        current = current.containerId ? byId.get(current.containerId) : undefined;
      }
      if (cyclic) containerId = undefined;
    }
    const key = containerId;
    const bucket = map.get(key);
    if (bucket) bucket.push(node);
    else map.set(key, [node]);
  }
  for (const [key, bucket] of map) {
    const ordered = orderSiblings(bucket, edges, byId);
    map.set(key, key === undefined ? clusterConnectedRoots(ordered, edges, byId) : ordered);
  }
  return map;
}

/**
 * A second reordering pass applied ONLY to the top-level (root, `containerId === undefined`)
 * sibling bucket, run after `orderSiblings`' Kahn sort has already produced a dependency-valid
 * order for it. See `graphFilters.ts`'s former home (`graphView.ts`) for the full rationale:
 * this groups root containers into connected components over the resolved, non-`contains`
 * call/import subgraph restricted to roots (via `siblingRootOf`, same as `orderSiblings`), using
 * union-find, then stable-sorts roots by (their component's minimum current rank, their own
 * current rank).
 */
export function clusterConnectedRoots(roots: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[] {
  if (roots.length <= 2) return roots;
  const rootIds = new Set(roots.map((root) => root.id));
  const rankOf = new Map(roots.map((root, index) => [root.id, index] as const));
  const parent = new Map(roots.map((root) => [root.id, root.id] as const));

  const find = (id: string): string => {
    let top = id;
    while (parent.get(top) !== top) top = parent.get(top)!;
    let current = id;
    while (parent.get(current) !== top) {
      const next = parent.get(current)!;
      parent.set(current, top);
      current = next;
    }
    return top;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const edge of edges) {
    if (edge.kind === "contains") continue;
    if (edge.resolution.kind !== "resolved") continue;
    const sourceRoot = siblingRootOf(edge.source, rootIds, byId);
    const targetRoot = siblingRootOf(edge.resolution.target, rootIds, byId);
    if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) continue;
    union(sourceRoot, targetRoot);
  }

  const componentRank = new Map<string, number>();
  for (const root of roots) {
    const component = find(root.id);
    const rank = rankOf.get(root.id)!;
    const existing = componentRank.get(component);
    if (existing === undefined || rank < existing) componentRank.set(component, rank);
  }

  return roots
    .map((root, index) => ({ root, componentRank: componentRank.get(find(root.id))!, ownRank: index }))
    .sort((a, b) => a.componentRank - b.componentRank || a.ownRank - b.ownRank)
    .map((entry) => entry.root);
}

/**
 * Walks `nodeId`'s `containerId` chain (inclusive of `nodeId` itself) until it reaches a
 * member of `bucketMembers` (a `Set` of ids that are direct children in the current sibling
 * bucket), returning that member's id, or `undefined` if the chain never reaches this bucket.
 */
function siblingRootOf(nodeId: string, bucketMembers: ReadonlySet<string>, byId: Map<string, Entity>): string | undefined {
  let current: Entity | undefined = byId.get(nodeId);
  const seen = new Set<string>();
  while (current) {
    if (bucketMembers.has(current.id)) return current.id;
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    current = current.containerId ? byId.get(current.containerId) : undefined;
  }
  return undefined;
}

/**
 * Orders one sibling bucket via Kahn's topological sort over the sibling-restricted
 * non-`contains` subgraph: a resolved edge whose source and target both resolve (via
 * `siblingRootOf`) to two different members of this bucket adds an arc between those members.
 * The ready queue always pops the smallest original array index; a cycle is broken by emitting
 * the remaining node with the smallest original index and continuing. No arcs means the output
 * is exactly the input array order.
 */
export function orderSiblings(bucket: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[] {
  if (bucket.length <= 1) return bucket;
  const memberIndex = new Map(bucket.map((node, index) => [node.id, index] as const));
  const bucketMembers = new Set(bucket.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const node of bucket) {
    adjacency.set(node.id, new Set());
    indegree.set(node.id, 0);
  }

  for (const edge of edges) {
    if (edge.kind === "contains") continue;
    if (edge.resolution.kind !== "resolved") continue;
    const sourceRoot = siblingRootOf(edge.source, bucketMembers, byId);
    const targetRoot = siblingRootOf(edge.resolution.target, bucketMembers, byId);
    if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) continue;
    // An edge's target must render before its source (a callee/import target sits above its
    // caller/importer), so the topological arc runs target -> source.
    const outSet = adjacency.get(targetRoot)!;
    if (!outSet.has(sourceRoot)) {
      outSet.add(sourceRoot);
      indegree.set(sourceRoot, (indegree.get(sourceRoot) ?? 0) + 1);
    }
  }

  const byOriginalIndex = (a: string, b: string): number => memberIndex.get(a)! - memberIndex.get(b)!;
  const remaining = new Set(bucketMembers);
  const ready = bucket.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  ready.sort(byOriginalIndex);
  const order: string[] = [];

  while (order.length < bucket.length) {
    if (ready.length === 0) {
      const remainingIds = Array.from(remaining).sort(byOriginalIndex);
      ready.push(remainingIds[0]);
    }
    const next = ready.shift()!;
    if (!remaining.has(next)) continue;
    order.push(next);
    remaining.delete(next);
    for (const target of adjacency.get(next) ?? []) {
      if (!remaining.has(target)) continue;
      const deg = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, deg);
      if (deg === 0) ready.push(target);
    }
    ready.sort(byOriginalIndex);
  }

  return order.map((id) => byId.get(id)!);
}

export function measure(node: Entity, childrenOf: Map<string | undefined, Entity[]>, memo: Map<string, Size>): Size {
  const cached = memo.get(node.id);
  if (cached) return cached;
  const children = childrenOf.get(node.id) ?? [];
  let size: Size;
  if (children.length === 0) {
    size = { w: NODE_MIN_W, h: NODE_H };
  } else {
    const childSizes = children.map((child) => measure(child, childrenOf, memo));
    const w = 2 * PAD_X + Math.max(NODE_MIN_W, ...childSizes.map((childSize) => childSize.w));
    const h = HEADER_H + 2 * PAD_Y + childSizes.reduce((sum, childSize) => sum + childSize.h, 0) + GAP_Y * (children.length - 1);
    size = { w, h };
  }
  memo.set(node.id, size);
  return size;
}

/** Exclude containment before allocating connector ports, while preserving protocol indices. */
export function routedPaths(edges: readonly Edge[], boxes: Map<string, Rect>): Map<number, string | undefined> {
  const visible = edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.kind !== "contains" && edge.resolution.kind === "resolved" && boxes.has(edge.resolution.target));
  const paths = edgePathsFor(boxes, visible.map(({ edge }) => ({
    source: edge.source,
    target: edge.resolution.kind === "resolved" ? edge.resolution.target : undefined,
  })));
  return new Map(visible.map(({ index }, i) => [index, paths[i]]));
}

/**
 * Counts, per source node id, edges eligible for a relationship indicator: a non-`contains`
 * edge whose source is in `boxes` and whose target is either unresolved/ambiguous or resolved
 * to a node outside the current view.
 */
function relationshipCountsFor(graph: AnalysisGraph, boxes: ReadonlyMap<string, Rect>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains" && boxes.has(edge.source) && (edge.resolution.kind !== "resolved" || !boxes.has(edge.resolution.target))) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    }
  }
  return counts;
}

/** Computes absolute `boxes` (and per-node containment `depth`) for a containment subtree,
 * without emitting any markup. Replaces `place()` as the sole placement pass (§2 - `place`'s
 * SVG-string emission is gone; only its box-computation arithmetic survives here). */
function probeBoxes(
  node: Entity,
  absX: number,
  absY: number,
  depth: number,
  childrenOf: Map<string | undefined, Entity[]>,
  memo: Map<string, Size>,
  boxes: Map<string, Rect>,
  depths: Map<string, number>,
): void {
  const size = measure(node, childrenOf, memo);
  boxes.set(node.id, { x: absX, y: absY, w: size.w, h: size.h });
  depths.set(node.id, depth);
  let offsetY = HEADER_H + PAD_Y;
  for (const child of childrenOf.get(node.id) ?? []) {
    probeBoxes(child, absX + PAD_X, absY + offsetY, depth + 1, childrenOf, memo, boxes, depths);
    offsetY += measure(child, childrenOf, memo).h + GAP_Y;
  }
}

export interface LayoutInput {
  graph: AnalysisGraph;
  diff: CorrelatedDiffEntry[];
  untrackedPaths: readonly string[];
  overrides: ReadonlyMap<string, Position>;
}

export type AcmNode = {
  id: string;
  type: "acmEntity";
  position: { x: number; y: number };
  draggable: boolean;
  selectable: true;
  zIndex: number;
  className?: string;
  width: number;
  height: number;
  data: {
    nodeId: string;
    kind: Entity["kind"];
    qualifiedName: string;
    status: ChangeStatus;
    provenance: "tracked" | "untracked";
    container: boolean;
    parentId: string | undefined;
    relationshipCount: number;
    box: Rect;
  };
};

export type AcmEdge = {
  id: string;
  source: string;
  target: string;
  type: "acmKind";
  interactionWidth: 16;
  className?: string;
  data: {
    edgeIndex: number;
    kind: "import" | "call";
    resolution: Edge["resolution"]["kind"];
    path: string;
    pathId: string;
    title: string;
  };
};

export interface LayoutResult {
  nodes: AcmNode[];
  edges: AcmEdge[];
  boxes: Map<string, Rect>;
  relationshipCounts: Map<string, number>;
  flat: boolean;
}

/** Reverses `childrenOf`'s bucketing into a per-node normalized parent id, so orphan/cycle/
 * filtered-out containerId references (already resolved to `undefined` by `computeChildrenOf`)
 * are reflected consistently in `data.parentId` rather than echoing the raw, possibly-dangling
 * `Entity.containerId`. */
function parentIdsFrom(childrenOf: Map<string | undefined, Entity[]>): Map<string, string | undefined> {
  const parentIds = new Map<string, string | undefined>();
  for (const [parentId, children] of childrenOf) {
    for (const child of children) parentIds.set(child.id, parentId);
  }
  return parentIds;
}

function buildNodes(
  nodes: Entity[],
  childrenOf: Map<string | undefined, Entity[]>,
  boxes: Map<string, Rect>,
  depths: Map<string, number>,
  diff: CorrelatedDiffEntry[],
  untrackedPaths: readonly string[],
  relationshipCounts: Map<string, number>,
  overrides: ReadonlyMap<string, Position>,
): AcmNode[] {
  const parentIds = parentIdsFrom(childrenOf);
  return nodes.map((node) => {
    const box = boxes.get(node.id)!;
    const override = overrides.get(node.id);
    const position = override ?? { x: box.x, y: box.y };
    const status = changeStatusFor(node.qualifiedName, diff);
    const untracked = untrackedPaths.includes(node.span.path);
    const container = isContainerKind(node.kind);
    return {
      id: node.id,
      type: "acmEntity",
      position,
      draggable: container,
      selectable: true,
      zIndex: depths.get(node.id) ?? 0,
      width: box.w,
      height: box.h,
      data: {
        nodeId: node.id,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        status,
        provenance: untracked ? "untracked" : "tracked",
        container,
        parentId: parentIds.get(node.id),
        relationshipCount: relationshipCounts.get(node.id) ?? 0,
        box,
      },
    };
  });
}

/**
 * Merges any absolute position `overrides` on top of the computed layout `boxes`, producing the
 * box set edge routing must use so it never disagrees with what `buildNodes` actually renders a
 * node at. Without this, a dragged (or refresh-hydrated, see `positionOverrides.ts`) node's
 * `AcmNode.position` moves via its override while `routedPaths`/`edgePathsFor` kept routing
 * against the pre-drag `boxes` entry — every edge touching that node (or a container's dragged
 * descendant) then anchors at the node's OLD location, visibly disconnected from its new one.
 * `result.boxes` itself (the `LayoutResult` field `onNodeDragStop`'s cascade math and
 * `positionOverrides.pruneTo` key off) intentionally stays the raw, un-overridden layout — only
 * the boxes fed into routing are merged, here, at the call site.
 */
function boxesForRouting(boxes: Map<string, Rect>, overrides: ReadonlyMap<string, Position>): Map<string, Rect> {
  if (overrides.size === 0) return boxes;
  const merged = new Map(boxes);
  for (const [id, box] of boxes) {
    const override = overrides.get(id);
    if (override) merged.set(id, { ...box, x: override.x, y: override.y });
  }
  return merged;
}

function buildEdges(edges: readonly Edge[], boxes: Map<string, Rect>, overrides: ReadonlyMap<string, Position>): AcmEdge[] {
  const paths = routedPaths(edges, boxesForRouting(boxes, overrides));
  const result: AcmEdge[] = [];
  edges.forEach((edge, index) => {
    if (edge.kind === "contains") return;
    if (edge.resolution.kind !== "resolved") return;
    const targetId = edge.resolution.target;
    if (!boxes.has(targetId)) return;
    const path = paths.get(index);
    if (path === undefined) return;
    const pathId = `acm-edge-path-${index}`;
    result.push({
      id: `e${index}`,
      source: edge.source,
      target: targetId,
      type: "acmKind",
      interactionWidth: 16,
      data: {
        edgeIndex: index,
        kind: edge.kind,
        resolution: edge.resolution.kind,
        path,
        pathId,
        title: `resolved -> ${targetId}`,
      },
    });
  });
  return result;
}

/** THE entry point index.tsx calls. */
export function layoutGraph(input: LayoutInput): LayoutResult {
  const { graph, diff, untrackedPaths, overrides } = input;
  const flat = graph.nodes.length > NESTED_LAYOUT_LIMITS.nodes || graph.edges.length > NESTED_LAYOUT_LIMITS.edges;

  const boxes = new Map<string, Rect>();
  const depths = new Map<string, number>();

  if (flat) {
    const flatW = 220;
    const nodeSpacingY = 48;
    for (const [index, node] of graph.nodes.entries()) {
      boxes.set(node.id, { x: 16, y: 24 + index * nodeSpacingY, w: flatW, h: NODE_H });
      depths.set(node.id, 0);
    }
    const relationshipCounts = relationshipCountsFor(graph, boxes);
    const childrenOf = new Map<string | undefined, Entity[]>([[undefined, graph.nodes]]);
    const nodes = buildNodes(graph.nodes, childrenOf, boxes, depths, diff, untrackedPaths, relationshipCounts, overrides);
    const edges = buildEdges(graph.edges, boxes, overrides);
    return { nodes, edges, boxes, relationshipCounts, flat };
  }

  const childrenOf = computeChildrenOf(graph.nodes, graph.edges);
  const memo = new Map<string, Size>();
  let probeY = MARGIN;
  for (const root of childrenOf.get(undefined) ?? []) {
    probeBoxes(root, MARGIN, probeY, 0, childrenOf, memo, boxes, depths);
    probeY += measure(root, childrenOf, memo).h + ROOT_GAP;
  }
  const relationshipCounts = relationshipCountsFor(graph, boxes);
  const nodes = buildNodes(graph.nodes, childrenOf, boxes, depths, diff, untrackedPaths, relationshipCounts, overrides);
  const edges = buildEdges(graph.edges, boxes, overrides);
  return { nodes, edges, boxes, relationshipCounts, flat };
}
