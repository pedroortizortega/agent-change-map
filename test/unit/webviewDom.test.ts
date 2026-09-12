import { JSDOM } from "jsdom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeMapSession } from "../../src/webviewHost.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";
import { DraftStore } from "../../src/editing/draftStore.js";
import { stubReactFlowDom } from "./webviewDomSetup.js";
import type { AnalysisGraph } from "../../src/protocol.js";
import type { WebviewToHostMessage } from "../../src/webviewProtocol.js";

/**
 * PR2b-ii scope (design.md §3, §"Testing Strategy"): `@testing-library/react` + jsdom, driven
 * through the exact same `ChangeMapSession`/`postMessage` boundary the old suite used. Narrowed
 * relative to the pre-React-Flow suite it replaces: pan/zoom/drag/hover are React Flow's own
 * built-in behavior now (not this codebase's to unit-test), pixel-position assertions are
 * already covered — exactly and cheaply — by `graphLayout.test.ts`'s pure-data layer, and
 * per-kind edge styling is PR4's scope. What remains here: the node/edge `data-*` attribute
 * contract, click-to-navigate, and the ported panels' id/behavior parity.
 */

let dom: JSDOM;
const content = "print('current')\n";
const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:right" };
const leftSnapshot = { ...snapshot, kind: "commit" as const, resolvedOid: "a".repeat(40), contentDigest: "sha256:left" };
const node = { id: "module:m", kind: "module" as const, qualifiedName: "m", span: { path: "m.py", startByte: 0, endByte: content.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 } };
const graph: AnalysisGraph = { snapshot, nodes: [node], edges: [], diagnostics: [] };
const intents: WebviewToHostMessage[] = [];
let session: ChangeMapSession;
let run: ReturnType<typeof vi.fn>;
let writePreviewGate: Promise<void> | undefined;

const element = <T extends Element>(selector: string): T => {
  const found = dom.window.document.querySelector(selector);
  expect(found, `Missing ${selector}`).not.toBeNull();
  return found as T;
};
// React 18/19's automatic batching does not synchronously flush a `dispatch()` triggered from a
// real `dispatchEvent(...)` call made outside `act()` in a non-browser (jsdom/Node) environment
// — it schedules the commit through the `scheduler` package instead, so a bare assertion
// immediately after `click(...)` reads stale DOM. Wrapping every state-changing DOM interaction
// (and every simulated host `post`) in `act()` forces a synchronous flush, matching what a real
// browser's event loop does implicitly.
const click = (selector: string) => act(() => { element<HTMLElement>(selector).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
/**
 * React tracks each controlled input/textarea's last-seen value via an internal
 * `_valueTracker` so it can tell a genuine user edit apart from React itself having just set
 * `.value` during render. Assigning `.value =` directly (bypassing the element's own property
 * setter) fools that tracker into thinking nothing changed, so a plain `dispatchEvent("input")`
 * afterwards never reaches `onChange` — the standard workaround (used by
 * `@testing-library/react`'s `fireEvent`) is to set the value through the *native* prototype
 * setter first, exactly as a real keystroke would.
 */
const typeInto = (selector: string, value: string) => {
  const el = element<HTMLInputElement | HTMLTextAreaElement>(selector);
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => { el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
};
/**
 * React 19 still synthesizes `onMouseEnter`/`onMouseLeave` (which React Flow wires to
 * `onNodeMouseEnter`/`onEdgeMouseEnter`/etc.) from the native, bubbling `mouseover`/`mouseout`
 * events (`registerDirectEvent("onMouseEnter", ["mouseout", "mouseover"])` in react-dom).
 * Crucially, its enter/leave synthesis SKIPS entirely when `relatedTarget` resolves to an
 * element React itself manages (`getClosestInstanceFromNode`) — using `document.body` (the
 * `createRoot` container itself) as `relatedTarget`, as an initial attempt did, hits exactly that
 * bail-out and silently no-ops. Leaving `relatedTarget` unset (`null`, matching a real pointer
 * arriving from outside any React-rendered element, e.g. from the OS chrome) avoids the bail-out
 * and reproduces a genuine hover.
 */
const hoverEnter = (selector: string) => act(() => {
  element<HTMLElement>(selector).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
});
const hoverLeave = (selector: string) => act(() => {
  element<HTMLElement>(selector).dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true }));
});

beforeEach(async () => {
  vi.resetModules();
  intents.length = 0;
  writePreviewGate = undefined;
  dom = new JSDOM("", { pretendToBeVisual: true });
  stubReactFlowDom(dom);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("MessageEvent", dom.window.MessageEvent);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: (message: WebviewToHostMessage) => { intents.push(message); void session.handleIntent(message); } }));
  const store = new SnapshotStore();
  store.store({ snapshot, files: [{ path: "m.py", content, provenance: "tracked" }] });
  store.store({ snapshot: leftSnapshot, files: [{ path: "m.py", content: "print('initial')\n", provenance: "tracked" }] });
  run = vi.fn(async source => ({ variant: source.variant, kind: "success", exitCode: 0, stdout: "ok\n", stderr: "" }));
  session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(async request => {
    await writePreviewGate;
    const confirmed = await request.confirm({ path: "/repo/m.py", previousContent: content, nextContent: request.replacement, isDestructive: true });
    if (!confirmed) throw new Error("Write declined");
    return { path: "/repo/m.py", previousContent: content, newContent: request.replacement, backupPath: "/repo/m.py.bak" };
  }), runSnippet: run, post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
  await act(async () => { await import("../../webview/index.js"); });
  act(() => { session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, []); });
});
afterEach(async () => {
  // React's scheduler defers some passive-effect flushing to a macrotask (Node's
  // `setImmediate`); without a tick to let it drain, it can fire after globals are unstubbed
  // and throw "window is not defined" as an unhandled error attributed to a later test.
  await new Promise((resolve) => setImmediate(resolve));
  dom.window.close();
  vi.unstubAllGlobals();
});

describe("node/edge data-* contract", () => {
  it("renders the node data-* attribute contract after a graph render", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    const el = element('[data-node-id="module:m"]');
    expect(el.getAttribute("data-node-kind")).toBe("module");
    expect(el.getAttribute("data-change-status")).toBe("unchanged");
    expect(el.getAttribute("data-provenance")).toBe("tracked");
  });

  it("marks an untracked node's provenance from the host's untrackedPaths", async () => {
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, [], { untrackedPaths: ["m.py"] });
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]').getAttribute("data-provenance")).toBe("untracked"));
  });

  it("renders the edge data-* attribute contract for a resolved, in-view relationship", async () => {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    const otherNode = { ...node, id: "module:other", qualifiedName: "other" };
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, { ...graph, nodes: [node, otherNode], edges: [{ kind: "call", source: node.id, resolution: { kind: "resolved", target: otherNode.id }, span: edgeSpan }] }, []);
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="0"]')).not.toBeNull());
    const edgeEl = element('[data-edge-index="0"]');
    expect(edgeEl.getAttribute("data-edge-kind")).toBe("call");
    expect(edgeEl.getAttribute("data-resolution")).toBe("resolved");
  });

  it("renders exactly one <animateMotion> per drawn edge (import and call), whose mpath/href matches that edge's own stable pathId (PR4, design.md §6)", async () => {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    const importTarget = { ...node, id: "module:importTarget", qualifiedName: "importTarget" };
    const callTarget = { ...node, id: "module:callTarget", qualifiedName: "callTarget" };
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, {
      ...graph,
      nodes: [node, importTarget, callTarget],
      edges: [
        { kind: "import", importedName: "pkg", source: node.id, resolution: { kind: "resolved", target: importTarget.id }, span: edgeSpan },
        { kind: "call", source: node.id, resolution: { kind: "resolved", target: callTarget.id }, span: edgeSpan },
      ],
    }, []);
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="1"]')).not.toBeNull());

    for (const index of [0, 1]) {
      const edgeEl = element(`[data-edge-index="${index}"]`);
      const path = edgeEl.querySelector("path");
      expect(path, `edge ${index} missing its <path>`).not.toBeNull();
      const pathId = path!.getAttribute("id")!;
      expect(pathId).toBe(`acm-edge-path-${index}`);
      const motions = edgeEl.querySelectorAll("animateMotion");
      expect(motions, `edge ${index} should render exactly one <animateMotion>`).toHaveLength(1);
      const mpath = motions[0].querySelector("mpath")!;
      expect(mpath.getAttribute("href")).toBe(`#${pathId}`);
      expect(edgeEl.querySelectorAll(".acm-particle")).toHaveLength(1);
    }
    expect(element('[data-edge-index="0"]').getAttribute("data-edge-kind")).toBe("import");
    expect(element('[data-edge-index="1"]').getAttribute("data-edge-kind")).toBe("call");
  });

  it("renders NO line, path, or particle for an ambiguous/unresolved relationship — indicator-only (D12)", async () => {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    session.loadComparison(undefined, {
      ...graph,
      edges: [
        { kind: "call", source: node.id, resolution: { kind: "unresolved" }, span: edgeSpan },
        { kind: "call", source: node.id, resolution: { kind: "ambiguous", candidates: ["x", "y"] }, span: edgeSpan },
      ],
    }, []);
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-relationship-source="module:m"]')).not.toBeNull());

    // D12 (indicator-only): no AcmEdge, hence no <g data-edge-index>, no <path>, no particle —
    // the relationship is disclosed exclusively through the node's indicator badge/popup.
    expect(dom.window.document.querySelector("[data-edge-index]")).toBeNull();
    expect(dom.window.document.querySelector(".acm-edge")).toBeNull();
    expect(dom.window.document.querySelector(".acm-particle")).toBeNull();
    expect(dom.window.document.querySelector("animateMotion")).toBeNull();
  });
});

describe("hover highlight (PR5, design.md §7)", () => {
  function threeNodeGraph(): { importTarget: typeof node; callTarget: typeof node } {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    const importTarget = { ...node, id: "module:importTarget", qualifiedName: "importTarget" };
    const callTarget = { ...node, id: "module:callTarget", qualifiedName: "callTarget" };
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, {
      ...graph,
      nodes: [node, importTarget, callTarget],
      edges: [
        { kind: "import", importedName: "pkg", source: node.id, resolution: { kind: "resolved", target: importTarget.id }, span: edgeSpan },
        { kind: "call", source: callTarget.id, resolution: { kind: "resolved", target: node.id }, span: edgeSpan },
      ],
    }, []);
    return { importTarget, callTarget };
  }

  const reactFlowNode = (nodeId: string) => element<HTMLElement>(`[data-node-id="${nodeId}"]`).closest(".react-flow__node")!;
  const reactFlowEdge = (edgeIndex: number) => element<HTMLElement>(`[data-edge-index="${edgeIndex}"]`).closest(".react-flow__edge")!;

  it("hovering a node hot-highlights it, its connected edges, and their endpoint nodes, dimming everything else", async () => {
    const { callTarget } = threeNodeGraph();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="1"]')).not.toBeNull());

    hoverEnter('[data-node-id="module:m"]');

    // Hovered node itself: hot.
    expect(reactFlowNode("module:m").classList.contains("acm-hot")).toBe(true);
    expect(reactFlowNode("module:m").classList.contains("acm-dim")).toBe(false);
    // Both connected edges (import out to importTarget, call in from callTarget): hot.
    expect(reactFlowEdge(0).classList.contains("acm-hot")).toBe(true);
    expect(reactFlowEdge(1).classList.contains("acm-hot")).toBe(true);
    // Both endpoint nodes reachable via those edges: hot, not dim.
    expect(reactFlowNode("module:importTarget").classList.contains("acm-hot")).toBe(true);
    expect(reactFlowNode("module:importTarget").classList.contains("acm-dim")).toBe(false);
    expect(reactFlowNode(callTarget.id).classList.contains("acm-hot")).toBe(true);
    expect(reactFlowNode(callTarget.id).classList.contains("acm-dim")).toBe(false);
  });

  it("hovering an edge hot-highlights only that edge and its two endpoint nodes, dimming everything else (including unrelated edges/nodes)", async () => {
    threeNodeGraph();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="1"]')).not.toBeNull());

    hoverEnter('[data-edge-index="0"]');

    expect(reactFlowEdge(0).classList.contains("acm-hot")).toBe(true);
    expect(reactFlowEdge(0).classList.contains("acm-dim")).toBe(false);
    expect(reactFlowNode("module:m").classList.contains("acm-hot")).toBe(true);
    expect(reactFlowNode("module:importTarget").classList.contains("acm-hot")).toBe(true);
    // Unrelated edge/node: dimmed.
    expect(reactFlowEdge(1).classList.contains("acm-dim")).toBe(true);
    expect(reactFlowEdge(1).classList.contains("acm-hot")).toBe(false);
    expect(reactFlowNode("module:callTarget").classList.contains("acm-dim")).toBe(true);
  });

  it("mouse-leave (hover end) restores every node/edge to neither acm-dim nor acm-hot", async () => {
    threeNodeGraph();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="1"]')).not.toBeNull());

    hoverEnter('[data-node-id="module:m"]');
    expect(reactFlowNode("module:m").classList.contains("acm-hot")).toBe(true);

    hoverLeave('[data-node-id="module:m"]');

    for (const id of ["module:m", "module:importTarget", "module:callTarget"]) {
      expect(reactFlowNode(id).classList.contains("acm-hot")).toBe(false);
      expect(reactFlowNode(id).classList.contains("acm-dim")).toBe(false);
    }
    for (const index of [0, 1]) {
      expect(reactFlowEdge(index).classList.contains("acm-hot")).toBe(false);
      expect(reactFlowEdge(index).classList.contains("acm-dim")).toBe(false);
    }
  });

  it("D9 regression guard: hovering an edge never restarts/remounts its particle's <animateMotion> (dur and DOM node identity stay stable)", async () => {
    threeNodeGraph();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="1"]')).not.toBeNull());

    const before = element('[data-edge-index="0"]').querySelector("animateMotion")!;
    const durBefore = before.getAttribute("dur");

    hoverEnter('[data-edge-index="0"]');
    const duringHover = element('[data-edge-index="0"]').querySelector("animateMotion")!;
    expect(duringHover.isSameNode(before)).toBe(true); // same DOM node — never remounted
    expect(duringHover.getAttribute("dur")).toBe(durBefore);

    hoverLeave('[data-edge-index="0"]');
    const afterHover = element('[data-edge-index="0"]').querySelector("animateMotion")!;
    expect(afterHover.isSameNode(before)).toBe(true);
    expect(afterHover.getAttribute("dur")).toBe(durBefore);
  });
});

describe("click-to-navigate", () => {
  it("posts inspectSources when a node is clicked", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    expect(intents.some(m => m.type === "inspectSources" && (m as { nodeId: string }).nodeId === "module:m")).toBe(true);
  });

  it("navigates a relationship at its exact edge span when the edge is clicked", async () => {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    const otherNode = { ...node, id: "module:other", qualifiedName: "other" };
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, { ...graph, nodes: [node, otherNode], edges: [{ kind: "call", source: node.id, resolution: { kind: "resolved", target: otherNode.id }, span: edgeSpan }] }, []);
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-edge-index="0"]')).not.toBeNull());
    click('[data-edge-index="0"]');
    await vi.waitFor(() => expect(intents).toContainEqual(expect.objectContaining({
      type: "navigate",
      side: "right",
      sourceId: expect.objectContaining({ startByte: edgeSpan.startByte, endByte: edgeSpan.endByte }),
    })));
  });

  it("discloses unresolved relationships without selecting the node, navigating only the recorded edge span", async () => {
    const edgeSpan = { ...node.span, startByte: 6, endByte: 13, startColumn: 6, endColumn: 13 };
    const input: AnalysisGraph = { ...graph, edges: [{ kind: "call", source: node.id, resolution: { kind: "unresolved" }, span: edgeSpan }] };
    session.loadComparison(undefined, input, []);
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-relationship-source="module:m"]')).not.toBeNull());
    intents.length = 0;
    click('[data-relationship-source="module:m"]');
    expect(intents.some(intent => intent.type === "inspectSources")).toBe(false);
    const popup = element('[role="dialog"]');
    const view = [...popup.querySelectorAll("button")].find(button => button.textContent === "View in code")!;
    expect(view).toBeDefined();
    act(() => { view.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await vi.waitFor(() => expect(intents).toContainEqual(expect.objectContaining({
      type: "navigate", side: "right", sourceId: expect.objectContaining({ startByte: 6, endByte: 13 }),
    })));
  });
});

describe("ported panels: ids and behavior parity", () => {
  it("drives explicit sides, snippet draft/save, guarded write preview and run/result through DOM", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
    expect(element('#source-left').textContent).toContain("Left");
    typeInto('#draft-content', "print('edited')\n");
    click('#save-draft');
    await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Draft saved"));
    click('#write-snippet');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("/repo/m.py"));
    expect(intents.some(m => m.type === "confirmDirectWrite")).toBe(false);
    click('#confirm-action');
    await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Written"));
    click('#request-run');
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("network"));
    click('#confirm-action');
    await vi.waitFor(() => expect(element('#run-output').textContent).toContain("success"));
    expect(run.mock.calls.some(([source]) => source.variant === "draft" && source.content.includes("edited"))).toBe(true);
  });

  it("declines effects and cancels using their request IDs", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
    click('#request-run');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("network"));
    click('#decline-action');
    expect(run).not.toHaveBeenCalled();
    click('#request-run');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("network"));
    click('#confirm-action'); click('#cancel-run');
    expect(intents.some(m => m.type === "cancelRun")).toBe(true);
  });

  it("selects a section before oversized rendering and keeps filters actionable", async () => {
    session.loadComparison(undefined, { ...graph, nodes: Array.from({ length: 301 }, (_, i) => ({ ...node, id: `m:${i}`, qualifiedName: `m${i}` })) }, []);
    await vi.waitFor(() => expect(element<HTMLElement>('#oversized-consent').hidden).toBe(false));
    expect(dom.window.document.querySelectorAll('[data-node-id]')).toHaveLength(0);
    const scope = element<HTMLSelectElement>('#filter-scope');
    scope.value = "m:0";
    act(() => { scope.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", scopeIds: ["m:0"] });
  });

  it("renders classified diff rows with ghost cells for the missing side", async () => {
    session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, []);
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    expect(element("#diff-panel").textContent).not.toContain("Affected lines");
    const removedRow = element(".diff-row.op-removed");
    expect(removedRow.querySelector(".side.left")?.textContent).toContain("initial");
    expect(removedRow.querySelector(".side.right.ghost")?.textContent).toBe("");
    const addedRow = element(".diff-row.op-added");
    expect(addedRow.querySelector(".side.right")?.textContent).toContain("current");
    expect(addedRow.querySelector(".side.left.ghost")?.textContent).toBe("");
  });

  it("collapses long unchanged runs and toggles them open", async () => {
    const bigSnapshotRight = { ...snapshot, contentDigest: "sha256:big-right" };
    const bigSnapshotLeft = { ...leftSnapshot, contentDigest: "sha256:big-left" };
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const leftLines = [...lines]; leftLines[9] = "left-line10";
    const rightLines = [...lines]; rightLines[9] = "rght-line10";
    const bigLeftContent = `${leftLines.join("\n")}\n`;
    const bigRightContent = `${rightLines.join("\n")}\n`;
    const bigStore = new SnapshotStore();
    bigStore.store({ snapshot: bigSnapshotRight, files: [{ path: "big.py", content: bigRightContent, provenance: "tracked" }] });
    bigStore.store({ snapshot: bigSnapshotLeft, files: [{ path: "big.py", content: bigLeftContent, provenance: "tracked" }] });
    const bigNode = { id: "module:big", kind: "module" as const, qualifiedName: "big", span: { path: "big.py", startByte: 0, endByte: bigRightContent.length, startLine: 1, startColumn: 0, endLine: 21, endColumn: 0 } };
    const bigGraph: AnalysisGraph = { snapshot: bigSnapshotRight, nodes: [bigNode], edges: [], diagnostics: [] };
    session = new ChangeMapSession({ repoRoot: "/repo", store: bigStore, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
    session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, []);

    await vi.waitFor(() => expect(element('[data-node-id="module:big"]')).not.toBeNull());
    click('[data-node-id="module:big"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    const collapsedButtons = () => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".diff-collapsed"));
    expect(collapsedButtons().length).toBeGreaterThan(0);
    const runKey = collapsedButtons()[0]!.getAttribute("data-run-key")!;
    expect(runKey).toMatch(/^L\d+-\d+\/R\d+-\d+$/);

    click(`[data-run-key="${runKey}"]`);
    expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
    expect(dom.window.document.querySelectorAll("#diff-panel .diff-row.op-unchanged").length).toBeGreaterThan(6);
  });

  it("exposes a vintage toolbar fieldset defaulting to current-only and posts requestGraphView accordingly", async () => {
    await vi.waitFor(() => expect(element('#filter-vintage')).not.toBeNull());
    const current = element<HTMLInputElement>('#vintage-current');
    const removed = element<HTMLInputElement>('#vintage-removed');
    expect(current.checked).toBe(true);
    expect(removed.checked).toBe(false);
    // A real (and jsdom-simulated) click toggles a checkbox's `.checked` via the browser's
    // default action before React's `onChange` fires — dispatching "change" directly, or
    // presetting `.checked` first, does not reproduce that and never triggers React's handler.
    click('#vintage-removed');
    expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", vintages: ["current", "removed"] });
  });

  it("posts requestGraphView with an empty vintages array when both vintage checkboxes are unchecked", async () => {
    await vi.waitFor(() => expect(element('#filter-vintage')).not.toBeNull());
    click('#vintage-current');
    expect(intents.at(-1)).toMatchObject({ type: "requestGraphView", vintages: [] });
  });

  it("reserves the confirmation slot before a delayed write preview and rejects overlapping effects", async () => {
    let releasePreview: (() => void) | undefined;
    writePreviewGate = new Promise<void>(resolve => { releasePreview = resolve; });
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));

    click('#write-snippet');
    click('#write-snippet');
    click('#request-run');

    expect(intents.filter(intent => intent.type === "requestSnippetWrite")).toHaveLength(1);
    expect(intents.some(intent => intent.type === "requestRun")).toBe(false);
    expect(element('#action-status').textContent).toContain("Preparing confirmation");

    releasePreview?.();
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("/repo/m.py"));
    click('#confirm-action');
    await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Written"));
  });

  it("keeps both ghost columns present for a wholly one-sided (added-only) pair", async () => {
    session.loadComparison(undefined, graph, []);
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    const rows = Array.from(dom.window.document.querySelectorAll(".diff-row.op-added"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector(".side.left.ghost")).not.toBeNull();
      expect(row.querySelector(".side.right")).not.toBeNull();
    }
  });

  it("preserves unsaved draft text across a refresh landing while clearing selection/editing", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]');
    click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
    typeInto('#draft-content', "print('unsaved edit')\n");
    expect(element<HTMLButtonElement>('#save-draft').disabled).toBe(false);

    session.loadComparison({ ...graph, snapshot: leftSnapshot }, graph, [], { loadReason: "refresh" });
    await vi.waitFor(() => expect(element<HTMLButtonElement>('#save-draft').disabled).toBe(true));
    expect(element<HTMLTextAreaElement>('#draft-content').value).toBe("print('unsaved edit')\n");
    expect(element<HTMLButtonElement>('#write-snippet').disabled).toBe(true);

    click('#save-draft');
    expect(intents.some(m => m.type === "saveDraft")).toBe(false);
  });

  it("shows terminal run kinds with exit codes and timeout durations", async () => {
    run.mockImplementation(async source => {
      if (source.variant === "original") return { variant: source.variant, kind: "success", exitCode: 0, stdout: "", stderr: "" };
      if (source.variant === "current") return { variant: source.variant, kind: "failure", exitCode: 17, stdout: "", stderr: "" };
      return { variant: source.variant, kind: "timeout", timeoutMs: 1_500, stdout: "", stderr: "" };
    });
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
    typeInto('#draft-content', "print('draft')\n");
    click('#save-draft');
    await vi.waitFor(() => expect(element('#action-status').textContent).toContain("Draft saved"));
    click('#request-run'); click('#confirm-action');
    await vi.waitFor(() => {
      const output = element('#run-output').textContent;
      expect(output).toContain("original: success (exit code 0)");
      expect(output).toContain("current: failure (exit code 17)");
      expect(output).toContain("draft: timeout (after 1500ms)");
    });
  });

  it("renders terminal runner failures rather than leaving an indefinitely running UI", async () => {
    run.mockRejectedValue(new Error("Docker is unavailable"));
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(content));
    click('#request-run'); click('#confirm-action');
    await vi.waitFor(() => expect(element('#run-output').textContent).toContain("Docker is unavailable"));
    click('#request-run');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain("network"));
    expect(element('#confirm-action')).not.toBeNull();
  });

  it("resets collapsed diff-panel runs on a new sourcePair message (re-selecting the same node)", async () => {
    const bigSnapshotRight = { ...snapshot, contentDigest: "sha256:reset-right" };
    const bigSnapshotLeft = { ...leftSnapshot, contentDigest: "sha256:reset-left" };
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const leftLines = [...lines]; leftLines[9] = "left-line10";
    const rightLines = [...lines]; rightLines[9] = "rght-line10";
    const bigLeftContent = `${leftLines.join("\n")}\n`;
    const bigRightContent = `${rightLines.join("\n")}\n`;
    const bigStore = new SnapshotStore();
    bigStore.store({ snapshot: bigSnapshotRight, files: [{ path: "big.py", content: bigRightContent, provenance: "tracked" }] });
    bigStore.store({ snapshot: bigSnapshotLeft, files: [{ path: "big.py", content: bigLeftContent, provenance: "tracked" }] });
    const bigNode = { id: "module:big", kind: "module" as const, qualifiedName: "big", span: { path: "big.py", startByte: 0, endByte: bigRightContent.length, startLine: 1, startColumn: 0, endLine: 21, endColumn: 0 } };
    const bigGraph: AnalysisGraph = { snapshot: bigSnapshotRight, nodes: [bigNode], edges: [], diagnostics: [] };
    session = new ChangeMapSession({ repoRoot: "/repo", store: bigStore, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
    session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, []);

    await vi.waitFor(() => expect(element('[data-node-id="module:big"]')).not.toBeNull());
    click('[data-node-id="module:big"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    const collapsedButtons = () => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".diff-collapsed"));
    expect(collapsedButtons().length).toBeGreaterThan(0);
    const runKey = collapsedButtons()[0]!.getAttribute("data-run-key")!;

    click(`[data-run-key="${runKey}"]`);
    expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();

    // A fresh selection of the SAME node (a new sourcePair reply, not a refresh landing) must
    // reset collapse state back to the default — expanding a run is scoped to the diff panel's
    // current content, not persisted indefinitely across ordinary re-selection.
    click('[data-node-id="module:big"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    expect(collapsedButtons().some(button => button.getAttribute("data-run-key") === runKey)).toBe(true);
  });

  it("re-issues inspectSources for the previously selected node after a refresh landing, and preserves its expanded runs", async () => {
    const bigSnapshotRight = { ...snapshot, contentDigest: "sha256:refresh-right" };
    const bigSnapshotLeft = { ...leftSnapshot, contentDigest: "sha256:refresh-left" };
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const leftLines = [...lines]; leftLines[9] = "left-line10";
    const rightLines = [...lines]; rightLines[9] = "rght-line10";
    const bigLeftContent = `${leftLines.join("\n")}\n`;
    const bigRightContent = `${rightLines.join("\n")}\n`;
    const bigStore = new SnapshotStore();
    bigStore.store({ snapshot: bigSnapshotRight, files: [{ path: "big.py", content: bigRightContent, provenance: "tracked" }] });
    bigStore.store({ snapshot: bigSnapshotLeft, files: [{ path: "big.py", content: bigLeftContent, provenance: "tracked" }] });
    const bigNode = { id: "module:big", kind: "module" as const, qualifiedName: "big", span: { path: "big.py", startByte: 0, endByte: bigRightContent.length, startLine: 1, startColumn: 0, endLine: 21, endColumn: 0 } };
    const bigGraph: AnalysisGraph = { snapshot: bigSnapshotRight, nodes: [bigNode], edges: [], diagnostics: [] };
    session = new ChangeMapSession({ repoRoot: "/repo", store: bigStore, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
    session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, []);

    await vi.waitFor(() => expect(element('[data-node-id="module:big"]')).not.toBeNull());
    click('[data-node-id="module:big"]');
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    const collapsedButtons = () => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".diff-collapsed"));
    expect(collapsedButtons().length).toBeGreaterThan(0);
    const runKey = collapsedButtons()[0]!.getAttribute("data-run-key")!;
    click(`[data-run-key="${runKey}"]`);
    expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
    const inspectCountBeforeRefresh = intents.filter(m => m.type === "inspectSources").length;
    expect(inspectCountBeforeRefresh).toBe(1);

    // A landing refresh for the same selection/content: a fresh graphSummary+graph arrives
    // with loadReason "refresh", without any node click in between. The webview must
    // automatically re-issue "inspectSources" for the previously selected node so the diff
    // panel re-renders, and the run that was expanded before the refresh must stay expanded.
    act(() => { session.loadComparison({ ...bigGraph, snapshot: bigSnapshotLeft }, bigGraph, [], { loadReason: "refresh" }); });
    await vi.waitFor(() => expect(intents.filter(m => m.type === "inspectSources").length).toBe(inspectCountBeforeRefresh + 1));
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#diff-panel .diff-row").length).toBeGreaterThan(0));
    expect(dom.window.document.querySelector(`[data-run-key="${runKey}"]`)).toBeNull();
    expect(dom.window.document.querySelectorAll("#diff-panel .diff-row.op-unchanged").length).toBeGreaterThan(6);
  });
});

describe("signature introspection parameter form", () => {
  function targetGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{ id: "function:f", kind: "function", qualifiedName: "f", span: node.span, target: { module: "m", dottedName: "f", callableKind: "function" } }],
      edges: [],
      diagnostics: [],
    };
  }

  function withIntrospection(parameters: { name: string; kind?: string; annotation?: string | null; defaultRepr?: string | null; required?: boolean }[]) {
    const introspection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters });
    session = new ChangeMapSession({
      repoRoot: "/repo",
      store: new SnapshotStore(),
      draftStore: new DraftStore(),
      openSource: vi.fn(),
      performWrite: vi.fn(),
      runSnippet: vi.fn(),
      runIntrospection: introspection,
      post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }),
    });
    (session as unknown as { deps: { store: SnapshotStore } }).deps.store.store({ snapshot, files: [{ path: "m.py", content: "def f():\n    return 1\n", provenance: "tracked" }] });
    session.loadComparison(undefined, targetGraph(), []);
    return introspection;
  }

  it("maps each annotation kind to its expected widget: number/checkbox/text/optional/raw-json", async () => {
    withIntrospection([
      { name: "count", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true },
      { name: "ratio", kind: "POSITIONAL_OR_KEYWORD", annotation: "float", required: true },
      { name: "flag", kind: "POSITIONAL_OR_KEYWORD", annotation: "bool", required: true },
      { name: "label", kind: "POSITIONAL_OR_KEYWORD", annotation: "str", required: true },
      { name: "maybe", kind: "POSITIONAL_OR_KEYWORD", annotation: "Optional[int]", required: false },
      { name: "items", kind: "POSITIONAL_OR_KEYWORD", annotation: "list[int]", required: true },
      { name: "mapping", kind: "POSITIONAL_OR_KEYWORD", annotation: "dict[str, int]", required: true },
      { name: "unknown", kind: "POSITIONAL_OR_KEYWORD", annotation: null, required: true },
      { name: "args", kind: "VAR_POSITIONAL", annotation: null, required: false },
      { name: "kwargs", kind: "VAR_KEYWORD", annotation: null, required: false },
    ]);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="count"]')).not.toBeNull());

    expect(element<HTMLInputElement>('[data-param="count"]').type).toBe("number");
    expect(element<HTMLInputElement>('[data-param="ratio"]').type).toBe("number");
    expect(element<HTMLInputElement>('[data-param="flag"]').type).toBe("checkbox");
    expect(element<HTMLInputElement>('[data-param="label"]').type).toBe("text");
    expect(dom.window.document.querySelector('[data-param-toggle="maybe"]')).not.toBeNull();
    expect(element<HTMLTextAreaElement>('[data-param="items"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="mapping"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="unknown"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="args"]').tagName).toBe("TEXTAREA");
    expect(element<HTMLTextAreaElement>('[data-param="kwargs"]').tagName).toBe("TEXTAREA");
  });

  it("blocks on invalid raw JSON and clears the error once the value parses", async () => {
    withIntrospection([{ name: "items", kind: "POSITIONAL_OR_KEYWORD", annotation: "list[int]", required: true }]);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="items"]')).not.toBeNull());

    const textarea = element<HTMLTextAreaElement>('[data-param="items"]');
    textarea.value = "not json";
    act(() => { textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await vi.waitFor(() => expect(element('#signature-form-validity').textContent).toContain("Fix invalid JSON"));

    textarea.value = "[1, 2, 3]";
    act(() => { textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await vi.waitFor(() => expect(element('#signature-form-validity').textContent).toBe(""));
  });

  it("shows a disabled unavailable state with no static-AST fallback when Docker is unavailable", async () => {
    session.loadComparison(undefined, targetGraph(), []);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(element('#signature-status').textContent).toContain("unavailable"));
    expect(dom.window.document.querySelectorAll('#signature-form input, #signature-form textarea')).toHaveLength(0);
  });
});

describe("call function box", () => {
  function targetGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{ id: "function:f", kind: "function", qualifiedName: "f", span: node.span, target: { module: "m", dottedName: "f", callableKind: "function" } }],
      edges: [],
      diagnostics: [],
    };
  }

  function withIntrospectionAndCall(
    parameters: { name: string; kind?: string; annotation?: string | null; defaultRepr?: string | null; required?: boolean }[],
    callImpl?: ReturnType<typeof vi.fn>,
  ) {
    const introspection = vi.fn().mockResolvedValue({ kind: "signatureResult", parameters });
    const call = callImpl ?? vi.fn();
    session = new ChangeMapSession({
      repoRoot: "/repo",
      store: new SnapshotStore(),
      draftStore: new DraftStore(),
      openSource: vi.fn(),
      performWrite: vi.fn(),
      runSnippet: vi.fn(),
      runIntrospection: introspection,
      runCall: call,
      post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }),
    });
    (session as unknown as { deps: { store: SnapshotStore } }).deps.store.store({ snapshot, files: [{ path: "m.py", content: "def f(x):\n    return x\n", provenance: "tracked" }] });
    session.loadComparison(undefined, targetGraph(), []);
    return { introspection, call };
  }

  it("shows a confirm step with the exact args JSON preview before any requestCall triggers a spawn", async () => {
    const { call } = withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }]);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');

    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    expect(element('#confirmation').textContent).toContain("5");
    expect(call).not.toHaveBeenCalled();
    expect(intents.some(m => m.type === "confirmCall")).toBe(false);
  });

  it("renders a successful callResult with the return repr", async () => {
    const call = vi.fn().mockResolvedValue({ result: { variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" }, returnRepr: "5" });
    withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }], call);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#confirm-action');

    await vi.waitFor(() => expect(element('#call-result').textContent).toContain("5"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("performs no invocation when the call confirmation is declined", async () => {
    const { call } = withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }]);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#decline-action');

    expect(call).not.toHaveBeenCalled();
    expect(intents.some(m => m.type === "confirmCall" && (m as { confirmed: boolean }).confirmed === true)).toBe(false);
  });

  it("renders a failing callResult with the captured error output", async () => {
    const call = vi.fn().mockResolvedValue({ result: { variant: "current", kind: "failure", exitCode: 1, stdout: "", stderr: "boom" } });
    withIntrospectionAndCall([{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", required: true }], call);
    await vi.waitFor(() => expect(element('[data-node-id="function:f"]')).not.toBeNull());
    click('[data-node-id="function:f"]');
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-param="x"]')).not.toBeNull());

    element<HTMLInputElement>('[data-param="x"]').value = "5";
    click('#call-function');
    await vi.waitFor(() => expect(element('#confirmation').textContent).toContain('"x"'));
    click('#confirm-action');

    await vi.waitFor(() => expect(element('#call-result').textContent).toContain("boom"));
  });
});

describe("semantic highlighting overlay (D6/D7/D8)", () => {
  const highlightedContent = "def go(self):\n    return self.value\n";
  const secondSelfOffset = highlightedContent.indexOf("self", highlightedContent.indexOf("self") + 1);

  function highlightedGraph(): AnalysisGraph {
    return {
      snapshot,
      nodes: [{
        id: "function:go",
        kind: "function",
        qualifiedName: "go",
        span: { path: "m.py", startByte: 0, endByte: highlightedContent.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
        identifierRoles: [{ start: secondSelfOffset, end: secondSelfOffset + 4, role: "self" }],
      }],
      edges: [],
      diagnostics: [],
    };
  }

  beforeEach(() => {
    const store = new SnapshotStore();
    store.store({ snapshot, files: [{ path: "m.py", content: highlightedContent, provenance: "tracked" }] });
    session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
    session.loadComparison(undefined, highlightedGraph(), []);
  });

  it("never renders the draft as a bare unstyled textarea/pre: the overlay pre's textContent equals the textarea's value", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="function:go"]')).not.toBeNull());
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    const overlay = element('#draft-overlay');
    expect(overlay.textContent).toBe(highlightedContent);
    expect(overlay.innerHTML).toContain("<span");
  });

  it("re-renders the overlay on edit, keeping the text-equality invariant", async () => {
    await vi.waitFor(() => expect(element('[data-node-id="function:go"]')).not.toBeNull());
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    typeInto('#draft-content', "def go(self):\n    return 1 + 2\n");
    expect(element('#draft-overlay').textContent).toBe(element<HTMLTextAreaElement>('#draft-content').value);
  });

  it("updates token colors on a themeTokens message without requiring reselection", async () => {
    // The CSP forbids inline `style="..."` (see webview/highlight.ts's module doc), so the
    // overlay's HTML always carries the same `class="tok-self"` regardless of the actual color —
    // only the `--tok-self` CSS custom property on the document root changes.
    await vi.waitFor(() => expect(element('[data-node-id="function:go"]')).not.toBeNull());
    click('[data-node-id="function:go"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(highlightedContent));
    expect(element('#draft-overlay').innerHTML).toContain('class="tok-self"');
    act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "themeTokens", kind: "dark", colors: { self: "#123456" } } })); });
    await vi.waitFor(() => expect(dom.window.document.documentElement.style.getPropertyValue("--tok-self")).toBe("#123456"));
    expect(element('#draft-overlay').innerHTML).not.toContain("style=");
  });

  it("renders an identifier with no determinable role as plain unstyled text without breaking overlay/textarea alignment", async () => {
    const plainContent = "plain_local_variable = 1\n";
    const store = new SnapshotStore();
    store.store({ snapshot, files: [{ path: "m.py", content: plainContent, provenance: "tracked" }] });
    session = new ChangeMapSession({ repoRoot: "/repo", store, draftStore: new DraftStore(), openSource: vi.fn(), performWrite: vi.fn(), runSnippet: vi.fn(), post: message => act(() => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message })); }) });
    session.loadComparison(undefined, { snapshot, nodes: [{ id: "module:m", kind: "module", qualifiedName: "m", span: { path: "m.py", startByte: 0, endByte: plainContent.length, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 } }], edges: [], diagnostics: [] }, []);
    await vi.waitFor(() => expect(element('[data-node-id="module:m"]')).not.toBeNull());
    click('[data-node-id="module:m"]'); click('#source-right');
    await vi.waitFor(() => expect(element<HTMLTextAreaElement>('#draft-content').value).toBe(plainContent));
    const overlay = element('#draft-overlay');
    expect(overlay.textContent).toBe(plainContent);
  });
});
