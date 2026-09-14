import type { AnalysisGraph, Edge, Entity } from "../src/protocol.js";
import type { CorrelatedDiffEntry } from "../src/navigation/sourceProvider.js";
import { edgePathFor, edgeRoutesFor, pathEndpoints, scopedEdgePathsFor, type Point, type Rect } from "./edgeGeometry.js";
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

/**
 * Minimum clear-space gap (px) `resolveCollisions`/`pushVector` maintain between a pushed box and
 * whatever it was pushed clear of. Intentionally a tunable CONSTANT, not a magic number: the goal
 * is a value that's trivial to change and re-test (box-collision-push wants to compare 5px vs
 * 10px visually) — flip this single number and re-run, no other code needs to change.
 */
export const BOX_MIN_GAP = 15;

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

/**
 * PR4 scoped drag-drop re-route input (design.md Block F, KEEP — see apply-progress.md's PR4
 * section for the real measurement). `movedIds` is the dragged node plus every D14-cascaded
 * descendant (mirrors `onNodeDragStop`'s own cascade in `index.tsx`); `previousRoutes` is the
 * PRIOR `layoutGraph` call's own `LayoutResult.edgeRoutes` — the raw (pre-rounding) waypoints for
 * every edge that pass currently routed, keyed by the edge's position in `AnalysisGraph.edges`
 * (stable across a drag, since a drag never adds/removes edges).
 */
export interface DragCommitScope {
  movedIds: ReadonlySet<string>;
  previousRoutes: ReadonlyMap<number, readonly Point[]>;
}

export interface RoutedPathsResult {
  paths: Map<number, string | undefined>;
  /** Raw (pre-rounding) waypoints per routed edge, keyed by the SAME `AnalysisGraph.edges`
   * position as `paths` — cached by the caller (`index.tsx`) and threaded back in as the NEXT
   * drag-commit's `DragCommitScope.previousRoutes` (PR4). */
  routes: Map<number, Point[]>;
}

/** Exclude containment before allocating connector ports, while preserving protocol indices. */
export function routedPaths(edges: readonly Edge[], boxes: Map<string, Rect>, scope?: DragCommitScope): RoutedPathsResult {
  const visible = edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.kind !== "contains" && edge.resolution.kind === "resolved" && boxes.has(edge.resolution.target));
  const routingEdges = visible.map(({ edge }) => ({
    source: edge.source,
    target: edge.resolution.kind === "resolved" ? edge.resolution.target : undefined,
  }));

  const core = (() => {
    if (!scope) return edgeRoutesFor(boxes, routingEdges);
    // Translate the caller's original-edge-index-keyed `previousRoutes` into the positional
    // indices `coordinateRoutes` (edgeGeometry.ts) uses for THIS `routingEdges` list.
    const previousForCore = new Map<number, readonly Point[]>();
    visible.forEach(({ index }, i) => {
      const previous = scope.previousRoutes.get(index);
      if (previous) previousForCore.set(i, previous);
    });
    // `scopedEdgePathsFor` returns `undefined` when a touched edge couldn't be routed at all —
    // fall back to a REAL full re-route (never a crash, never a silently unrouted edge), per
    // design.md's own scoped-reroute fallback scenario.
    return scopedEdgePathsFor(boxes, routingEdges, scope.movedIds, previousForCore) ?? edgeRoutesFor(boxes, routingEdges);
  })();

  const paths = new Map(visible.map(({ index }, i) => [index, core.paths[i]]));
  const routes = new Map<number, Point[]>();
  visible.forEach(({ index }, i) => {
    const route = core.routes.get(i);
    if (route) routes.set(index, route);
  });
  return { paths, routes };
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
  /** PR4: set only on the ONE `layoutGraph` call that commits a drag-drop (`onNodeDragStop`).
   * When present, edge routing takes the scoped fast path instead of a full coordinated pass —
   * see `routedPaths`'s own doc comment. */
  dragCommit?: DragCommitScope;
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
    /** The path's own rendered start/end coordinates (visual redesign, post-PR4): where the
     * edge visually attaches to its source/target box, used to draw the small port-dot circles
     * in `AcmKindEdge.tsx`. Read off the router's own final `d` string via `pathEndpoints`
     * (see its doc comment) rather than recomputed independently, so a port dot can never
     * disagree with where the edge itself actually starts/ends. */
    startPoint: Point;
    endPoint: Point;
  };
};

export interface LayoutResult {
  nodes: AcmNode[];
  edges: AcmEdge[];
  boxes: Map<string, Rect>;
  relationshipCounts: Map<string, number>;
  flat: boolean;
  /** PR4: raw (pre-rounding) waypoints per routed edge, keyed by its `AnalysisGraph.edges`
   * position — cache this and thread it back as the NEXT drag-commit's
   * `DragCommitScope.previousRoutes` (see `index.tsx`'s `onNodeDragStop`). */
  edgeRoutes: Map<number, Point[]>;
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
export function boxesForRouting(boxes: Map<string, Rect>, overrides: ReadonlyMap<string, Position>): Map<string, Rect> {
  if (overrides.size === 0) return boxes;
  const merged = new Map(boxes);
  for (const [id, box] of boxes) {
    const override = overrides.get(id);
    if (override) merged.set(id, { ...box, x: override.x, y: override.y });
  }
  return merged;
}

function buildEdges(
  edges: readonly Edge[],
  boxes: Map<string, Rect>,
  overrides: ReadonlyMap<string, Position>,
  scope?: DragCommitScope,
): { edges: AcmEdge[]; routes: Map<number, Point[]> } {
  const { paths, routes } = routedPaths(edges, boxesForRouting(boxes, overrides), scope);
  const result: AcmEdge[] = [];
  edges.forEach((edge, index) => {
    if (edge.kind === "contains") return;
    if (edge.resolution.kind !== "resolved") return;
    const targetId = edge.resolution.target;
    if (!boxes.has(targetId)) return;
    const path = paths.get(index);
    if (path === undefined) return;
    const pathId = `acm-edge-path-${index}`;
    const { start, end } = pathEndpoints(path);
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
        startPoint: start,
        endPoint: end,
      },
    });
  });
  return { edges: result, routes };
}

export interface LiveDragUpdate {
  /** Live absolute positions for the DRAGGED node AND every one of its cascaded descendants
   * (D14, mirroring `onNodeDragStop`'s own cascade — see `movedDescendantIds` below), each keyed
   * by node id. Regression fix: this used to be a single `{nodeId, position}` pair covering only
   * the directly-dragged node, which left a container's descendants visually frozen at their
   * pre-drag spot mid-drag while only the container itself tracked the pointer (the "container
   * moved away from its stranded children" symptom). Every id in `movedDescendantIds`, plus
   * `nodeId` itself, is guaranteed to have an entry here (when a box exists for it in `layout`). */
  positions: Map<string, Position>;
  edgeOverrides: Map<number, { path: string; startPoint: Point; endPoint: Point }>;
}

/**
 * Pure state transition for an in-progress drag (design.md §4, "Live re-routing during a
 * drag"). This is the fix for a real regression: `<ReactFlow nodes={...}>` was fed straight
 * from `layoutGraph`'s own absolute-position output (via `useMemo`), which only reflects a
 * COMMITTED `positionOverrides` entry (written on drop) — never React Flow's own in-progress
 * drag position. Because the controlled `nodes` prop never changed reference during the drag,
 * the dragged box visually snapped back to its pre-drag position on every re-render mid-gesture
 * (looking static), while the previous edge-preview logic re-anchored edges against whatever it
 * read independently — producing lines detached from both the box and the pointer. The fix:
 * this function's `position` result must be merged into whatever feeds the `nodes` prop (so the
 * box itself visually tracks the live position), and its `edgeOverrides` must be applied to the
 * SAME live position, so the box and its lines move together.
 *
 * `layout` is the layout as of the START of this drag gesture (pre-drag `boxes`/`edges`,
 * unaffected by this drag in progress). `overrides` are any already-committed absolute
 * positions from earlier drags. `position` is the CURRENT in-progress position React Flow's own
 * `onNodesChange` just reported for `nodeId`. `movedDescendantIds` mirrors `onNodeDragStop`'s
 * own D14 cascade (a dragged container also carries its nested descendants).
 *
 * Returns `undefined` only when `nodeId` has no box in `layout.boxes` (defensive — should not
 * happen for a real drag event).
 */
export function computeLiveDragUpdate(input: {
  layout: Pick<LayoutResult, "boxes" | "edges">;
  overrides: ReadonlyMap<string, Position>;
  nodeId: string;
  position: Position;
  movedDescendantIds: readonly string[];
  /** box-collision-push: resolves ANOTHER box's own cascaded descendants when THAT box gets
   * pushed (not the dragged node's own descendants — that's `movedDescendantIds`, above). Reused
   * from `positionOverrides.ts`'s `descendantsOf`, consistently with the existing D14 cascade.
   * Optional (defaults to no descendants) so existing call sites/tests without collision push
   * keep working unchanged. */
  descendantsOfId?: (id: string) => readonly string[];
}): LiveDragUpdate | undefined {
  const { layout, overrides, nodeId, position, movedDescendantIds, descendantsOfId } = input;
  const before = layout.boxes.get(nodeId);
  if (!before) return undefined;
  const dx = position.x - before.x;
  const dy = position.y - before.y;

  const liveBoxes = new Map(boxesForRouting(layout.boxes, overrides));
  const draggedBox = liveBoxes.get(nodeId);
  if (!draggedBox) return undefined;
  liveBoxes.set(nodeId, { ...draggedBox, x: position.x, y: position.y });
  const movedIds = new Set<string>([nodeId, ...movedDescendantIds]);
  const positions = new Map<string, Position>([[nodeId, position]]);
  for (const descendantId of movedDescendantIds) {
    const box = liveBoxes.get(descendantId);
    if (!box) continue;
    const livePosition = { x: box.x + dx, y: box.y + dy };
    liveBoxes.set(descendantId, { ...box, ...livePosition });
    positions.set(descendantId, livePosition);
  }

  // box-collision-push: live (mid-gesture) preview of push-away, so the pushed box(es) visually
  // move responsively during the drag itself rather than only snapping clear on drop.
  if (descendantsOfId) {
    const pushed = resolveCollisions({ boxes: liveBoxes, movedIds, descendantsOf: descendantsOfId });
    for (const [id, pushedPosition] of pushed) {
      const box = liveBoxes.get(id);
      if (!box) continue;
      liveBoxes.set(id, { ...box, x: pushedPosition.x, y: pushedPosition.y });
      positions.set(id, pushedPosition);
      movedIds.add(id);
    }
  }

  const edgeOverrides = new Map<number, { path: string; startPoint: Point; endPoint: Point }>();
  for (const edge of layout.edges) {
    if (!movedIds.has(edge.source) && !movedIds.has(edge.target)) continue;
    const path = edgePathFor(liveBoxes, edge.source, edge.target);
    if (!path) continue;
    const { start, end } = pathEndpoints(path);
    edgeOverrides.set(edge.data.edgeIndex, { path, startPoint: start, endPoint: end });
  }

  return { positions, edgeOverrides };
}

/**
 * AABB (axis-aligned bounding box) overlap amount between two rects, or `undefined` when they
 * don't overlap. `overlapX`/`overlapY` are each strictly positive when defined.
 */
function overlapAmount(a: Rect, b: Rect): { overlapX: number; overlapY: number } | undefined {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapX <= 0 || overlapY <= 0) return undefined;
  return { overlapX, overlapY };
}

/**
 * Minimum-translation push vector to move `target` clear of `mover` by at least `BOX_MIN_GAP`
 * px, along whichever axis has the SMALLER overlap (the standard AABB push-out heuristic — the
 * shortest way to separate two overlapping rectangles). Direction is away from `mover`'s center;
 * ties (equal centers) push in the positive direction, deterministically. `BOX_MIN_GAP` is added
 * on top of the raw overlap distance so the two boxes end up with real clear space between them,
 * not merely touching at 0px — this only pads a push that's ALREADY happening (triggered by a
 * genuine overlap); it does not enforce a minimum gap between boxes that never overlapped.
 */
function pushVector(mover: Rect, target: Rect, overlap: { overlapX: number; overlapY: number }): Position {
  const moverCenterX = mover.x + mover.w / 2;
  const moverCenterY = mover.y + mover.h / 2;
  const targetCenterX = target.x + target.w / 2;
  const targetCenterY = target.y + target.h / 2;
  if (overlap.overlapX < overlap.overlapY) {
    const sign = targetCenterX >= moverCenterX ? 1 : -1;
    return { x: sign * (overlap.overlapX + BOX_MIN_GAP), y: 0 };
  }
  const sign = targetCenterY >= moverCenterY ? 1 : -1;
  return { x: 0, y: sign * (overlap.overlapY + BOX_MIN_GAP) };
}

/**
 * Box-collision push-away (box-collision-push, direct-inline change — see
 * openspec/changes/box-collision-push/apply-progress.md for the full design writeup). Pure AABB
 * push-out resolution: given the CURRENT absolute `boxes` (with every id in `movedIds` already at
 * its live/final dragged position — the dragged box itself plus any D14-cascaded descendants,
 * which move as a rigid group and are therefore never individually re-checked against each
 * other), returns the NEW absolute positions for every OTHER box that must be pushed clear of a
 * mover, plus (bounded, see below) any box pushed clear of one of THOSE pushed boxes in turn.
 *
 * Design choices (first version, intentionally NOT a full physics simulation):
 *  - Push axis = the axis of MINIMUM overlap (shortest separating distance), the standard AABB
 *    resolution heuristic — see `pushVector`.
 *  - A pushed box that is itself a container carries its own descendants along with it (via the
 *    caller-supplied `descendantsOf`), consistently with the existing D14 drag cascade: a
 *    container's visual containment must never break just because it got pushed rather than
 *    dragged directly.
 *  - Chain reactions (pushing B into C, which now overlaps D) are resolved by a greedy
 *    fixed-point loop: at each step, the SINGLE most significant remaining overlap (by area)
 *    anywhere in the CURRENT working set is resolved, and the pushed box joins the "active"
 *    (can-push-others) set for the next step. Crucially, "active" is CUMULATIVE — every box ever
 *    pushed stays eligible both as a future mover AND as a future target — so two boxes pushed
 *    away from the same original mover in different steps still get re-checked against EACH
 *    OTHER on a later step, instead of being permanently exempted from one another the moment
 *    both happen to be "movers" at once. (An earlier version partitioned movers into per-iteration
 *    batches and skipped any target that was itself a same-batch mover, which let two
 *    simultaneously-pushed siblings end up overlapping each other with no later step ever
 *    re-checking that specific pair — see `boxCollision.test.ts`'s
 *    "same-iteration double-push" case.) The loop stops as soon as no active box overlaps any
 *    pushable target, or after `maxIterations` steps (default 50) as a safety cap against
 *    pathological/non-converging clusters — in that rare case the function returns whatever
 *    partial resolution it reached rather than looping forever; callers should treat a result
 *    that still leaves visible overlap as a signal to raise the cap or investigate the cluster,
 *    not as silent data corruption.
 *  - Never returns an entry for a mover id itself (movers are governed by the existing
 *    drag/D14-cascade mechanism, not by this function) — an original mover can push others but is
 *    never itself a valid push target.
 */
export function resolveCollisions(input: {
  boxes: ReadonlyMap<string, Rect>;
  movedIds: ReadonlySet<string>;
  descendantsOf: (id: string) => readonly string[];
  maxIterations?: number;
}): Map<string, Position> {
  const { boxes, movedIds, descendantsOf, maxIterations = 50 } = input;
  const working = new Map(boxes);
  const pushed = new Map<string, Position>();
  const active = new Set(movedIds);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let best: { moverId: string; targetId: string; overlapX: number; overlapY: number } | undefined;
    let bestArea = 0;
    for (const moverId of active) {
      const moverBox = working.get(moverId);
      if (!moverBox) continue;
      for (const [targetId, targetBox] of working) {
        if (targetId === moverId || movedIds.has(targetId)) continue;
        // A container and its own descendants are EXPECTED to nest (their bounding rects overlap
        // by design, rigidly moving together) — that is not a collision to resolve, in either
        // direction.
        if (descendantsOf(moverId).includes(targetId) || descendantsOf(targetId).includes(moverId)) continue;
        const overlap = overlapAmount(moverBox, targetBox);
        if (!overlap) continue;
        const area = overlap.overlapX * overlap.overlapY;
        if (area > bestArea) {
          bestArea = area;
          best = { moverId, targetId, ...overlap };
        }
      }
    }
    if (!best) break; // no remaining overlap between any active (mover or already-pushed) box and a pushable target

    const moverBox = working.get(best.moverId)!;
    const targetBox = working.get(best.targetId)!;
    const { x: dx, y: dy } = pushVector(moverBox, targetBox, best);
    const groupIds = [best.targetId, ...descendantsOf(best.targetId)];
    for (const id of groupIds) {
      const box = working.get(id);
      if (!box) continue;
      const newBox = { ...box, x: box.x + dx, y: box.y + dy };
      working.set(id, newBox);
      pushed.set(id, { x: newBox.x, y: newBox.y });
      active.add(id);
    }
  }

  for (const id of movedIds) pushed.delete(id);
  return pushed;
}

/**
 * Pure "drop" counterpart to `computeLiveDragUpdate` (box-collision-push follow-up fix — see
 * apply-progress.md's "multi-drag stale-box" section). Given the pre-drag `layoutGraph` `boxes`,
 * the ALREADY-COMMITTED `overrides` from any prior drag/push in this session, the dragged node's
 * id and DROP position, its own D14-cascaded descendant ids, and the same `descendantsOf`
 * callback used everywhere else, returns the full set of NEW absolute positions to persist: the
 * dragged node itself, its cascaded descendants (rigid group), and any box(es) `resolveCollisions`
 * pushes clear (plus their own cascaded descendants, handled internally by `resolveCollisions`).
 *
 * Root-cause fix: `layoutGraph`'s own `LayoutResult.boxes` is INTENTIONALLY never merged with
 * `overrides` (see `boxesForRouting`'s doc comment) — it always reflects each box's ORIGINAL,
 * un-dragged layout position. Resolving collisions directly against that raw map (the previous
 * behavior, inlined in `index.tsx`'s `onNodeDragStop`) meant that any box already moved by an
 * EARLIER drag in the same session was checked against its STALE pre-override position instead of
 * where it actually currently renders — silently missing real on-screen overlaps (or computing a
 * push distance/direction from the wrong starting point) whenever a later drag interacts with an
 * already-pushed/dragged box. This is the confirmed root cause of the reported bug: dragging
 * multiple stacked containers bottom-to-top left one container's box visually overlapping a
 * DIFFERENT container's content once a prior push's position was never accounted for. The fix:
 * build the collision working set from `boxesForRouting(boxes, overrides)` — the SAME merge
 * `computeLiveDragUpdate` and edge routing already use — so both the dragged node's own dx/dy AND
 * every other box's current position are correct before `resolveCollisions` runs.
 */
export function resolveDragCommit(input: {
  boxes: ReadonlyMap<string, Rect>;
  overrides: ReadonlyMap<string, Position>;
  nodeId: string;
  position: Position;
  movedDescendantIds: readonly string[];
  descendantsOf: (id: string) => readonly string[];
}): Map<string, Position> {
  const { boxes, overrides, nodeId, position, movedDescendantIds, descendantsOf } = input;
  const committedBoxes = new Map(boxesForRouting(new Map(boxes), overrides));
  const before = committedBoxes.get(nodeId);
  const dx = position.x - (before?.x ?? position.x);
  const dy = position.y - (before?.y ?? position.y);
  if (before) committedBoxes.set(nodeId, { ...before, x: position.x, y: position.y });

  const committed = new Map<string, Position>([[nodeId, position]]);
  const movedIds = new Set<string>([nodeId]);
  for (const descendantId of movedDescendantIds) {
    movedIds.add(descendantId);
    const box = committedBoxes.get(descendantId);
    if (!box) continue;
    const newPosition = { x: box.x + dx, y: box.y + dy };
    committed.set(descendantId, newPosition);
    committedBoxes.set(descendantId, { ...box, ...newPosition });
  }

  const pushed = resolveCollisions({ boxes: committedBoxes, movedIds, descendantsOf });
  for (const [id, pushedPosition] of pushed) committed.set(id, pushedPosition);

  return committed;
}

/** THE entry point index.tsx calls. */
export function layoutGraph(input: LayoutInput): LayoutResult {
  const { graph, diff, untrackedPaths, overrides, dragCommit } = input;
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
    const { edges, routes } = buildEdges(graph.edges, boxes, overrides, dragCommit);
    return { nodes, edges, boxes, relationshipCounts, flat, edgeRoutes: routes };
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
  const { edges, routes } = buildEdges(graph.edges, boxes, overrides, dragCommit);
  return { nodes, edges, boxes, relationshipCounts, flat, edgeRoutes: routes };
}
