import { Handle, Position, type NodeProps } from "@xyflow/react";
import { KIND_STYLE, type AcmNode } from "../graphLayout.js";

/** Invisible, non-interactive: React Flow needs at least one source and one target `<Handle>`
 * per node to register its connection lookup — without them every edge touching this node
 * fails silently (`error008`, "Couldn't create edge for ... handle") and is dropped from
 * render. `nodesConnectable={false}` on `<ReactFlow>` (index.tsx) already disables the
 * drag-a-new-connection UI these would otherwise expose; `data.path` (D1), not handle
 * position, is what actually draws the edge. */
const HANDLE_STYLE = { opacity: 0, pointerEvents: "none" as const };

/** Baseline used by `graphView.ts`'s `renderNodeRect`-equivalent label placement. */
const LABEL_X = 8;
const LABEL_Y = 20;
const BADGE_R = 3;
const BADGE_MARGIN = 8;
/** Y of the header/body divider line (visual redesign, post-PR4): matches
 * `edgeGeometry.ts`'s `routingPorts` `belowTitle = box.y + 26` for a containing endpoint's
 * inward ports, so the divider drawn here lines up with where the router already treats the
 * title row as ending — one shared "header height" convention rather than two independent
 * numbers that could drift apart. */
const HEADER_DIVIDER_Y = 26;

/**
 * The single React Flow node type (design §2/§3 "Node output shape (exact)"): there is exactly
 * one node component, not one per kind. A container is not a different component, it is the
 * same component with `data.container === true`, which suppresses body fill and uses
 * `KIND_STYLE[kind].dasharray`, matching `graphView.ts`'s `renderNodeRect` semantically (not
 * pixel-for-pixel — this is a new rendering path per the design).
 *
 * Owns the `data-node-id` / `data-node-kind` / `data-change-status` / `data-provenance`
 * attribute contract that `webviewDom.test.ts` and `relationshipDetails.ts` address elements by.
 *
 * Visual redesign (post-PR4, reference-image alignment): every node now reads as a rounded
 * "card" - a raised surface (`acm-node-box` fill switches to `--vscode-editorWidget-background`
 * in styles.css) with a header/body divider line (`acm-node-divider`, see `HEADER_DIVIDER_Y`).
 * DECISION: `KIND_STYLE[kind].dasharray` is KEPT as the container/leaf distinguishing
 * convention rather than replaced - the reference image has no nested containment at all, so it
 * gives no direct guidance either way, and this repo's own containment nesting (module/package
 * boxes wrapping class/function/method boxes) is a real, load-bearing piece of information the
 * card look must not erase. Containers instead get a plain, low-opacity dashed outline with NO
 * card background fill (`acm-node-container .acm-node-box` in styles.css) so they read as a
 * subtle "grouping" frame around their children's own cards, while leaf kinds get the full card
 * treatment (opaque background, stronger divider) - the two remain visually distinguishable, per
 * the constraint, without inventing a second unrelated visual language for containment.
 */
export function AcmEntityNode({ data }: NodeProps<AcmNode>) {
  const style = KIND_STYLE[data.kind];
  const { w, h } = data.box;

  return (
    <div
      data-node-id={data.nodeId}
      data-node-kind={data.kind}
      data-change-status={data.status}
      data-provenance={data.provenance}
      className={[
        "acm-node",
        `acm-node-status-${data.status}`,
        data.container ? "acm-node-container" : "acm-node-leaf",
      ].join(" ")}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <rect
          className="acm-node-box"
          width={w}
          height={h}
          rx={style.rx}
          strokeWidth={style.strokeWidth}
          strokeDasharray={data.container ? style.dasharray : undefined}
          fill={data.container ? "none" : undefined}
        />
        {/* Header/body divider (visual redesign, post-PR4): every node reads as a card with a
         * title row separated from its body. Containers already carry a dashed, low-opacity
         * outline (`KIND_STYLE[kind].dasharray`, kept as-is — see module doc comment below) that
         * reads as "grouping", so their divider is drawn just as subtly; leaf cards get the
         * full-strength divider that makes the card body read as a distinct raised surface. */}
        {HEADER_DIVIDER_Y < h && (
          <line
            className="acm-node-divider"
            x1={4}
            y1={HEADER_DIVIDER_Y}
            x2={w - 4}
            y2={HEADER_DIVIDER_Y}
          />
        )}
        <text className="acm-node-label" x={LABEL_X} y={LABEL_Y}>
          {data.qualifiedName}
        </text>
        {data.provenance === "untracked" && (
          <circle className="acm-node-provenance-untracked" cx={w - BADGE_MARGIN} cy={BADGE_MARGIN} r={BADGE_R} />
        )}
        {data.relationshipCount > 0 && (
          <circle
            className="acm-node-relationship-indicator"
            data-relationship-source={data.nodeId}
            tabIndex={0}
            role="button"
            aria-haspopup="dialog"
            aria-expanded="false"
            aria-label={`${data.relationshipCount} relationship(s) from ${data.qualifiedName}`}
            cx={w - BADGE_MARGIN}
            cy={h - BADGE_MARGIN}
            r={BADGE_R}
          />
        )}
      </svg>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}
