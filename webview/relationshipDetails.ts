import type { AnalysisGraph } from "../src/protocol.js";
import type { HostToWebviewMessage } from "../src/webviewProtocol.js";

type EdgeSources = Extract<HostToWebviewMessage, { type: "graph" }>["edgeSources"];

/** Nonmodal disclosure scoped to the current graph snapshot. Dispose before refresh replaces it. */
export function bindRelationshipDetails(root: HTMLElement, graph: AnalysisGraph, edgeSources: EdgeSources, navigate: (index: number) => void): () => void {
  const doc = root.ownerDocument; const win = doc.defaultView!;
  const labels = new Map(graph.nodes.map(node => [node.id, node.qualifiedName]));
  let popup: HTMLDivElement | undefined;
  let trigger: SVGElement | undefined;
  const close = (restoreFocus = true): void => {
    popup?.remove(); popup = undefined;
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.removeAttribute("aria-controls");
    if (restoreFocus && trigger?.isConnected) trigger.focus();
    trigger = undefined;
  };
  const position = (): void => {
    if (!popup || !trigger) return;
    const anchor = trigger.getBoundingClientRect(); const bounds = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, win.innerWidth - bounds.width - 8));
    const preferredTop = anchor.bottom + 8;
    const top = preferredTop + bounds.height <= win.innerHeight - 8 ? preferredTop : anchor.top - bounds.height - 8;
    popup.style.left = `${left}px`; popup.style.top = `${Math.max(8, top)}px`;
  };
  const open = (button: SVGElement): void => {
    if (trigger === button) { close(); return; }
    close(false); trigger = button;
    const source = button.getAttribute("data-relationship-source")!;
    popup = doc.createElement("div"); popup.className = "relationship-popup"; popup.id = "relationship-details";
    popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", `Relationship details for ${labels.get(source) ?? source}`);
    const heading = doc.createElement("strong"); heading.textContent = `Relationships from ${labels.get(source) ?? source}`;
    const dismiss = doc.createElement("button"); dismiss.type = "button"; dismiss.className = "relationship-popup-close";
    dismiss.textContent = "×"; dismiss.setAttribute("aria-label", "Close relationship details"); dismiss.addEventListener("click", () => close());
    const list = doc.createElement("ol");
    graph.edges.forEach((edge, index) => {
      if (edge.source !== source || edge.kind === "contains" || (edge.resolution.kind === "resolved" && labels.has(edge.resolution.target))) return;
      const item = doc.createElement("li"); item.dataset.edgeIndex = String(index); item.dataset.resolution = edge.resolution.kind;
      const kind = doc.createElement("strong"); kind.textContent = edge.kind === "call" ? "Call" : `Import${edge.importedName ? ` ${edge.importedName}` : ""}`;
      const reason = doc.createElement("p");
      switch (edge.resolution.kind) {
        case "unresolved": reason.textContent = "Unresolved target. No target could be identified."; break;
        case "ambiguous": reason.textContent = `Ambiguous target. Candidates: ${edge.resolution.candidates.map(id => labels.get(id) ?? id).join(", ")}`; break;
        case "resolved": reason.textContent = `Known target outside current view: ${edge.resolution.target}`; break;
      }
      const location = doc.createElement("p"); location.className = "relationship-location";
      location.textContent = `${edge.span.path}:${edge.span.startLine}:${edge.span.startColumn + 1}`;
      item.append(kind, reason, location);
      if (edgeSources[index]) {
        const view = doc.createElement("button"); view.type = "button"; view.textContent = "View in code";
        view.addEventListener("click", () => { close(); navigate(index); }); item.append(view);
      } else {
        const unavailable = doc.createElement("p"); unavailable.textContent = "Recorded location unavailable."; item.append(unavailable);
      }
      list.append(item);
    });
    popup.append(heading, dismiss, list); doc.body.append(popup);
    button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-controls", popup.id);
    position(); dismiss.focus();
  };
  const indicatorFor = (event: Event): SVGElement | null => {
    const target = event.target as Element | null;
    const indicator = typeof target?.closest === "function" ? target.closest<SVGElement>("[data-relationship-source]") : null;
    return indicator && root.contains(indicator) ? indicator : null;
  };
  const click = (event: MouseEvent): void => {
    const button = indicatorFor(event);
    if (!button) return;
    event.stopImmediatePropagation(); event.preventDefault(); open(button);
  };
  const keydown = (event: KeyboardEvent): void => {
    const button = indicatorFor(event);
    if (button && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopImmediatePropagation(); open(button);
    }
  };
  const outside = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (popup && target && !popup.contains(target) && !trigger?.contains(target)) close();
  };
  const escape = (event: KeyboardEvent): void => {
    if (popup && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  };
  root.addEventListener("click", click, true); root.addEventListener("keydown", keydown, true);
  doc.addEventListener("click", outside); doc.addEventListener("keydown", escape);
  win.addEventListener("resize", position); doc.addEventListener("scroll", position, true);
  return () => {
    close(false);
    root.removeEventListener("click", click, true); root.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("click", outside); doc.removeEventListener("keydown", escape);
    win.removeEventListener("resize", position); doc.removeEventListener("scroll", position, true);
  };
}
