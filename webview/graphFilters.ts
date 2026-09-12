import type { AnalysisGraph, Edge, Entity } from "../src/protocol.js";
import type { CorrelatedDiffEntry } from "../src/navigation/sourceProvider.js";

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

/** Whether an edge is present on the current/worktree side, or only on the original side. */
export type EdgeVintage = "current" | "removed";

/**
 * Threshold above which nested containment layout degrades to the flat vertical stack.
 * Distinct from and independent of the host-side `OVERSIZED_THRESHOLDS` (300/600) gate that
 * decides whether to render at all; this one decides nested-vs-flat only after a graph
 * message has already been posted.
 */
export const NESTED_LAYOUT_LIMITS = { nodes: 60, edges: 120 } as const;

/** Now exported (was module-private) so `graphLayout.ts` imports it rather than
 * re-implementing the diff-status classification. */
export function changeStatusFor(qualifiedName: string, diff: CorrelatedDiffEntry[]): ChangeStatus {
  const entry = diff.find((candidate) => candidate.kind === "entity" && candidate.qualifiedName === qualifiedName);
  if (!entry || entry.kind !== "entity") return "unchanged";
  if (!entry.left && entry.right) return "added";
  if (entry.left && !entry.right) return "removed";
  return "modified";
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

/**
 * True when `edge`'s source entity is a transitive `containerId` ancestor of its resolved
 * target (the `Main(x)` -> `class Main` shape). Peer edges between siblings are false.
 * Unresolved/ambiguous/`contains` edges and unknown ids are false. Visited-set guarded,
 * mirroring `sectionScope`'s walk, so a `containerId` cycle terminates and returns false.
 * Equal source/target counts as a self-reference and is suppressed.
 */
export function isAncestorSelfReference(edge: Edge, nodes: readonly Entity[]): boolean {
  if (edge.kind === "contains") return false;
  if (edge.resolution.kind !== "resolved") return false;
  const target = edge.resolution.target;
  if (edge.source === target) return true;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  let current: Entity | undefined = byId.get(target);
  while (current) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const containerId = current.containerId;
    if (containerId === undefined) return false;
    if (containerId === edge.source) return true;
    current = byId.get(containerId);
  }
  return false;
}

/** Unconditional pre-filter: drops every `isAncestorSelfReference` edge. Nodes untouched. */
export function suppressAncestorSelfReferences(graph: AnalysisGraph): AnalysisGraph {
  const edges = graph.edges.filter((edge) => !isAncestorSelfReference(edge, graph.nodes));
  return { ...graph, edges };
}

export interface GraphFilter {
  scopeIds?: string[];
  relationshipKinds?: Edge["kind"][];
  changeStatuses?: ChangeStatus[];
  vintages?: EdgeVintage[];
}

/**
 * Applies display-only filters (scope, relationship kind, change status, vintage). Never
 * mutates the comparison itself - it returns a new filtered view over the same immutable
 * graph and diff data, matching the "Apply filters" scenario's "without changing the
 * comparison" requirement. `vintages` is index-aligned with the **input** `graph.edges`
 * (mirroring `buildEdgeSourceIndex`'s convention). Unlike `scopeIds`/`relationshipKinds`/
 * `changeStatuses`, an empty `filter.vintages` does NOT mean "no restriction": the vintage
 * toolbar is a checkbox pair, not a multi-select dropdown, so "nothing checked" means "show
 * nothing" (an explicit `[]` hides every edge). Only an entirely absent `filter.vintages`
 * (`undefined` - the field was never supplied) skips vintage filtering altogether.
 */
export function filterGraph(graph: AnalysisGraph, diff: CorrelatedDiffEntry[], filter: GraphFilter, vintages?: readonly EdgeVintage[]): AnalysisGraph {
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
  let indexedEdges = graph.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => nodeIds.has(edge.source) || (edge.resolution.kind === "resolved" && nodeIds.has(edge.resolution.target)));
  if (filter.relationshipKinds && filter.relationshipKinds.length > 0) {
    const kinds = new Set(filter.relationshipKinds);
    indexedEdges = indexedEdges.filter(({ edge }) => kinds.has(edge.kind));
  }
  if (filter.vintages !== undefined && vintages) {
    const allowed = new Set(filter.vintages);
    indexedEdges = indexedEdges.filter(({ index }) => allowed.has(vintages[index]));
  }
  const edges = indexedEdges.map(({ edge }) => edge);
  return { ...graph, nodes, edges };
}
