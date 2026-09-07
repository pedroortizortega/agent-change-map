import type { AnalysisGraph, Edge, Entity, EdgeResolution } from "../src/protocol.js";
import type { CorrelatedDiffEntry } from "../src/navigation/sourceProvider.js";
import { edgePathFor, type Rect } from "./edgeGeometry.js";

/**
 * Builds the exact strict Content-Security-Policy meta tag this webview emits. No remote
 * scheme (`http:`/`https:`) is ever permitted: scripts require the caller-supplied nonce,
 * inline/eval script execution is impossible under `default-src 'none'`, and styles/images
 * are restricted to the webview's own resource root.
 */
export function buildCspMetaTag(nonce: string, cspSource: string): string {
  const policy = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `script-src-elem 'nonce-${nonce}'`,
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${policy};">`;
}

export type ChangeStatus = "added" | "removed" | "modified" | "unchanged";

function changeStatusFor(qualifiedName: string, diff: CorrelatedDiffEntry[]): ChangeStatus {
  const entry = diff.find((candidate) => candidate.kind === "entity" && candidate.qualifiedName === qualifiedName);
  if (!entry || entry.kind !== "entity") return "unchanged";
  if (!entry.left && entry.right) return "added";
  if (entry.left && !entry.right) return "removed";
  return "modified";
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function resolutionLabel(resolution: EdgeResolution): string {
  if (resolution.kind === "resolved") return `resolved -> ${resolution.target}`;
  if (resolution.kind === "ambiguous") return `ambiguous (${resolution.candidates.length} candidates): ${resolution.candidates.join(", ")}`;
  return "unresolved";
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
 * Threshold above which nested containment layout degrades to the flat vertical stack.
 * Distinct from and independent of the host-side `OVERSIZED_THRESHOLDS` (300/600) gate that
 * decides whether to render at all; this one decides nested-vs-flat only after a graph
 * message has already been posted.
 */
export const NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 } as const;

interface KindStyle {
  strokeWidth: number;
  dasharray?: string;
  rx: number;
}

const KIND_STYLE: Record<Entity["kind"], KindStyle> = {
  package: { strokeWidth: 1, dasharray: "2 4", rx: 4 },
  module: { strokeWidth: 1.5, dasharray: "4 3", rx: 4 },
  class: { strokeWidth: 3.5, rx: 2 },
  function: { strokeWidth: 2.5, rx: 10 },
  method: { strokeWidth: 2, rx: 6 },
};

/** Emits `<rect class="node-box status-*">` with inline geometry-carrying kind encoding
 * (`stroke-width`/`stroke-dasharray`/`rx`/`fill="none"`) shared by both the nested and flat
 * layout paths. */
function renderNodeRect(kind: Entity["kind"], status: ChangeStatus, w: number, h: number): string {
  const style = KIND_STYLE[kind];
  const dash = style.dasharray ? ` stroke-dasharray="${style.dasharray}"` : "";
  return `<rect width="${w}" height="${h}" rx="${style.rx}" stroke-width="${style.strokeWidth}"${dash} fill="none" class="node-box status-${status}"></rect>`;
}

/**
 * containerId normalized to `undefined` when absent, referencing a filtered-out/unknown
 * node (orphan), or part of a containment cycle (cycle guard mirroring `sectionScope`'s
 * existing seen-set walk) - all three cases are treated as loose roots with no placeholder.
 */
function computeChildrenOf(nodes: Entity[], edges: readonly Edge[] = []): Map<string | undefined, Entity[]> {
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
 * order for it. Kahn only moves two roots relative to each other when a direct arc requires it;
 * two roots with no arc between them keep an essentially arbitrary tie-broken position (their
 * existing rank), so a root connected to a distant root by a single call/import edge can still
 * end up with unrelated, unconnected root containers physically sandwiched between them - the
 * "edge cuts through an unrelated sibling module" bug from live testing (see design.md).
 *
 * This groups root containers into connected components over the resolved, non-`contains`
 * call/import subgraph restricted to roots (via `siblingRootOf`, same as `orderSiblings`), using
 * union-find, then stable-sorts roots by (their component's minimum current rank, their own
 * current rank). Every component's representative rank stands in for "average vertical rank" -
 * an unconnected/singleton root's component is just itself, so it never moves. Members of a
 * component keep their relative order to each other (their own current rank), so this can only
 * ever pull a connected group together, never re-litigate Kahn's dependency ordering within it.
 * One pass, no iteration to converge: union-find settles in a single scan and a plain component
 * grouping cannot oscillate the way a naive "move to neighbor's rank" barycenter update can for
 * a single pair of mutually connected nodes swapping positions every pass.
 */
function clusterConnectedRoots(roots: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[] {
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
 * non-`contains` subgraph (see design.md "Sibling ordering"): a resolved edge whose source and
 * target both resolve (via `siblingRootOf`) to two different members of this bucket adds an
 * arc between those members. The ready queue always pops the smallest original array index; a
 * cycle is broken by emitting the remaining node with the smallest original index and
 * continuing. No arcs means the output is exactly the input array order.
 */
function orderSiblings(bucket: Entity[], edges: readonly Edge[], byId: Map<string, Entity>): Entity[] {
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

function measure(node: Entity, childrenOf: Map<string | undefined, Entity[]>, memo: Map<string, Size>): Size {
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
 * Emits `<g transform="translate(localX,localY)">` for `node`, where `localX`/`localY` are
 * offsets relative to the immediate parent's own coordinate system (SVG `transform`s compound
 * with ancestors, so nested `<g>`s must use LOCAL offsets, not absolute ones). Recurses into
 * children at their local offsets while separately tracking each node's ABSOLUTE box in
 * `boxes` for edge anchoring.
 */
/** Renders the additive corner badge for an untracked node, or `""` for a tracked one — a
 * free visual channel that never collides with the kind/status/edge encodings. */
function renderProvenanceBadge(untracked: boolean, w: number): string {
  return untracked ? `<circle class="provenance-untracked" cx="${w - 8}" cy="8" r="3"></circle>` : "";
}

function place(
  node: Entity,
  absX: number,
  absY: number,
  localX: number,
  localY: number,
  childrenOf: Map<string | undefined, Entity[]>,
  memo: Map<string, Size>,
  boxes: Map<string, Rect>,
  out: string[],
  diff: CorrelatedDiffEntry[],
  untrackedPaths: readonly string[],
): void {
  const size = measure(node, childrenOf, memo);
  boxes.set(node.id, { x: absX, y: absY, w: size.w, h: size.h });
  const status = changeStatusFor(node.qualifiedName, diff);
  const untracked = untrackedPaths.includes(node.span.path);
  out.push(
    `<g class="node" data-node-id="${escapeXml(node.id)}" data-node-kind="${node.kind}" data-change-status="${status}" data-provenance="${untracked ? "untracked" : "tracked"}" transform="translate(${localX},${localY})">`,
  );
  out.push(renderNodeRect(node.kind, status, size.w, size.h));
  out.push(`<text class="node-label" x="8" y="20">${escapeXml(node.qualifiedName)}</text>`);
  out.push(renderProvenanceBadge(untracked, size.w));
  let offsetY = HEADER_H + PAD_Y;
  for (const child of childrenOf.get(node.id) ?? []) {
    place(child, absX + PAD_X, absY + offsetY, PAD_X, offsetY, childrenOf, memo, boxes, out, diff, untrackedPaths);
    offsetY += measure(child, childrenOf, memo).h + GAP_Y;
  }
  out.push(`</g>`);
}

const RESOLVED_ARROW: Record<"import" | "call", string> = {
  import: "acm-arrow-import",
  call: "acm-arrow-call",
};

const DEFS = [
  "<defs>",
  '<marker id="acm-arrow-import" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
  '<path d="M0,0 L10,5 L0,10 z" class="arrow-import"></path></marker>',
  '<marker id="acm-arrow-call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
  '<path d="M0,0 L10,5 L0,10 z" class="arrow-call"></path></marker>',
  "</defs>",
].join("");

/**
 * Renders one `<g class="edge">` for a non-`contains` edge, or `undefined` for `contains`
 * (containment is expressed only via nesting - the caller must still iterate `graph.edges`
 * by array index so surviving edges keep their true index). Resolved `import`/`call` edges
 * whose target is laid out draw an elbowed line with an arrowhead at the target; ambiguous,
 * unresolved, and resolved-but-target-not-in-view edges draw a dashed downward stub with no
 * arrowhead, retaining `<title>` and `data-resolution` verbatim.
 */
function renderEdge(edge: Edge, index: number, boxes: Map<string, Rect>): string | undefined {
  if (edge.kind === "contains") return undefined;
  const sourceBox = boxes.get(edge.source);
  if (!sourceBox) return undefined;
  const targetId = edge.resolution.kind === "resolved" ? edge.resolution.target : undefined;
  const targetBox = targetId ? boxes.get(targetId) : undefined;
  const label = resolutionLabel(edge.resolution);
  const path = edgePathFor(boxes, edge.source, targetId);
  if (path === undefined) return undefined;

  let markerAttr = "";
  let dashAttr = "";
  let colorClass: string;
  if (targetBox) {
    markerAttr = ` marker-end="url(#${RESOLVED_ARROW[edge.kind]})"`;
    colorClass = `edge-${edge.kind}`;
  } else {
    dashAttr = ' stroke-dasharray="4 3"';
    colorClass = `resolution-${edge.resolution.kind === "resolved" ? "unresolved" : edge.resolution.kind}`;
  }

  return [
    `<g class="edge" data-edge-index="${index}" data-edge-kind="${edge.kind}" data-resolution="${edge.resolution.kind}">`,
    `<title>${escapeXml(label)}</title>`,
    `<path class="${colorClass}" d="${path}" fill="none"${dashAttr}${markerAttr}></path>`,
    `</g>`,
  ].join("");
}

/**
 * Renders a whole-project or already-sectioned graph as SVG. Nodes are laid out via geometric
 * containment (nested inside their `containerId` box) up to `NESTED_LAYOUT_LIMITS`, above
 * which `renderFlatSvg` takes over; both paths share `renderNodeRect`/`renderEdge` so
 * outline-only kind encoding and drawn edges are preserved either way. Every node and edge
 * carries `data-*` attributes identifying its id/kind and, for edges, its exact resolution
 * status - `ambiguous`/`unresolved` edges are always rendered as an explicit dashed stub with
 * no arrowhead rather than being hidden or silently treated as resolved.
 */
export function renderGraphSvg(graph: AnalysisGraph, diff: CorrelatedDiffEntry[], untrackedPaths: readonly string[] = []): string {
  if (graph.nodes.length > NESTED_LAYOUT_LIMITS.nodes || graph.edges.length > NESTED_LAYOUT_LIMITS.edges) {
    return renderFlatSvg(graph, diff, untrackedPaths);
  }

  const childrenOf = computeChildrenOf(graph.nodes, graph.edges);
  const memo = new Map<string, Size>();
  const boxes = new Map<string, Rect>();
  const nodeLines: string[] = [];
  let rootY = MARGIN;
  let maxRight = MARGIN;
  for (const root of childrenOf.get(undefined) ?? []) {
    place(root, MARGIN, rootY, MARGIN, rootY, childrenOf, memo, boxes, nodeLines, diff, untrackedPaths);
    const size = measure(root, childrenOf, memo);
    maxRight = Math.max(maxRight, MARGIN + size.w);
    rootY += size.h + ROOT_GAP;
  }
  const height = Math.max(120, rootY === MARGIN ? 120 : rootY - ROOT_GAP + MARGIN);
  const width = Math.max(960, maxRight + MARGIN);

  const edgeLines: string[] = [];
  graph.edges.forEach((edge, index) => {
    const rendered = renderEdge(edge, index, boxes);
    if (rendered) edgeLines.push(rendered);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Change map">${DEFS}${nodeLines.join("")}${edgeLines.join("")}</svg>`;
}

/**
 * Flat vertical-stack fallback used above `NESTED_LAYOUT_LIMITS`; keeps today's
 * `y = 24 + index * 48` stack geometry but shares `renderNodeRect`/`renderEdge` with the
 * nested path, so outline-only styling, kind dash/stroke-width, drawn elbow edges, and
 * markers are all preserved even when geometric nesting is skipped.
 */
function renderFlatSvg(graph: AnalysisGraph, diff: CorrelatedDiffEntry[], untrackedPaths: readonly string[] = []): string {
  const nodeSpacingY = 48;
  const flatW = 220;
  const boxes = new Map<string, Rect>();
  const nodeLines = graph.nodes.map((node: Entity, index: number) => {
    const y = 24 + index * nodeSpacingY;
    boxes.set(node.id, { x: 16, y, w: flatW, h: NODE_H });
    const status = changeStatusFor(node.qualifiedName, diff);
    const untracked = untrackedPaths.includes(node.span.path);
    return [
      `<g class="node" data-node-id="${escapeXml(node.id)}" data-node-kind="${node.kind}" data-change-status="${status}" data-provenance="${untracked ? "untracked" : "tracked"}" transform="translate(16,${y})">`,
      renderNodeRect(node.kind, status, flatW, NODE_H),
      `<text class="node-label" x="8" y="20">${escapeXml(node.qualifiedName)}</text>`,
      renderProvenanceBadge(untracked, flatW),
      `</g>`,
    ].join("");
  });

  const edgeLines: string[] = [];
  graph.edges.forEach((edge, index) => {
    const rendered = renderEdge(edge, index, boxes);
    if (rendered) edgeLines.push(rendered);
  });

  const height = Math.max(120, 24 + graph.nodes.length * nodeSpacingY + 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-label="Change map">${DEFS}${nodeLines.join("")}${edgeLines.join("")}</svg>`;
}

/**
 * Restricts a graph to a chosen package/module/class/function scope plus the immediate
 * boundary relationships that reference it, per the "View a section" scenario. Descendants
 * are entities whose `containerId` chain reaches the scope id.
 */
export function sectionScope(graph: AnalysisGraph, scopeId: string): AnalysisGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const inScope = (node: Entity): boolean => {
    let current: Entity | undefined = node;
    const seen = new Set<string>();
    while (current) {
      if (current.id === scopeId) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.containerId ? byId.get(current.containerId) : undefined;
    }
    return false;
  };
  const nodes = graph.nodes.filter(inScope);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => {
    if (nodeIds.has(edge.source)) return true;
    return edge.resolution.kind === "resolved" && nodeIds.has(edge.resolution.target);
  });
  return { ...graph, nodes, edges };
}

export interface GraphFilter {
  scopeIds?: string[];
  relationshipKinds?: Edge["kind"][];
  changeStatuses?: ChangeStatus[];
}

/**
 * Applies display-only filters (scope, relationship kind, change status). Never mutates
 * the comparison itself - it returns a new filtered view over the same immutable graph and
 * diff data, matching the "Apply filters" scenario's "without changing the comparison"
 * requirement.
 */
export function filterGraph(graph: AnalysisGraph, diff: CorrelatedDiffEntry[], filter: GraphFilter): AnalysisGraph {
  let nodes = graph.nodes;
  if (filter.scopeIds && filter.scopeIds.length > 0) {
    const scoped = new Set<string>();
    for (const scopeId of filter.scopeIds) {
      for (const node of sectionScope(graph, scopeId).nodes) scoped.add(node.id);
    }
    nodes = nodes.filter((node) => scoped.has(node.id));
  }
  if (filter.changeStatuses && filter.changeStatuses.length > 0) {
    const statuses = new Set(filter.changeStatuses);
    nodes = nodes.filter((node) => statuses.has(changeStatusFor(node.qualifiedName, diff)));
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  let edges = graph.edges.filter((edge) => nodeIds.has(edge.source) || (edge.resolution.kind === "resolved" && nodeIds.has(edge.resolution.target)));
  if (filter.relationshipKinds && filter.relationshipKinds.length > 0) {
    const kinds = new Set(filter.relationshipKinds);
    edges = edges.filter((edge) => kinds.has(edge.kind));
  }
  return { ...graph, nodes, edges };
}
