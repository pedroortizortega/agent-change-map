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

/**
 * The single React Flow node type (design §2/§3 "Node output shape (exact)"): there is exactly
 * one node component, not one per kind. A container is not a different component, it is the
 * same component with `data.container === true`, which suppresses body fill and uses
 * `KIND_STYLE[kind].dasharray`, matching `graphView.ts`'s `renderNodeRect` semantically (not
 * pixel-for-pixel — this is a new rendering path per the design).
 *
 * Owns the `data-node-id` / `data-node-kind` / `data-change-status` / `data-provenance`
 * attribute contract that `webviewDom.test.ts` and `relationshipDetails.ts` address elements by.
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
