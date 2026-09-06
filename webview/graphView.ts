import type { AnalysisGraph, Edge, Entity, EdgeResolution } from "../src/protocol.js";
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

/**
 * Renders a whole-project or already-sectioned graph as SVG. Every node and edge carries
 * `data-*` attributes identifying its id/kind and, for edges, its exact resolution status -
 * `ambiguous`/`unresolved` edges are always rendered with an explicit visible label rather
 * than being hidden or silently treated as resolved.
 */
export function renderGraphSvg(graph: AnalysisGraph, diff: CorrelatedDiffEntry[]): string {
  const nodeSpacingY = 48;
  const nodeLines = graph.nodes.map((node: Entity, index: number) => {
    const y = 24 + index * nodeSpacingY;
    const status = changeStatusFor(node.qualifiedName, diff);
    return [
      `<g class="node" data-node-id="${escapeXml(node.id)}" data-node-kind="${node.kind}" data-change-status="${status}" transform="translate(16,${y})">`,
      `<rect width="220" height="32" rx="4" class="node-box status-${status}"></rect>`,
      `<text x="8" y="20">${escapeXml(node.qualifiedName)}</text>`,
      `</g>`,
    ].join("");
  });

  const edgeLines = graph.edges.map((edge: Edge, index: number) => {
    const label = resolutionLabel(edge.resolution);
    return [
      `<g class="edge" data-edge-index="${index}" data-edge-kind="${edge.kind}" data-resolution="${edge.resolution.kind}">`,
      `<title>${escapeXml(label)}</title>`,
      `<text class="edge-label resolution-${edge.resolution.kind}" x="4" y="${24 + graph.nodes.length * nodeSpacingY + 24 + index * 20}">${escapeXml(`${edge.source} --${edge.kind}--> ${label}`)}</text>`,
      `</g>`,
    ].join("");
  });

  const height = Math.max(120, 24 + graph.nodes.length * nodeSpacingY + graph.edges.length * 20 + 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" role="img" aria-label="Change map">${nodeLines.join("")}${edgeLines.join("")}</svg>`;
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
