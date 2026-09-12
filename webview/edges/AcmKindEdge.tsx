import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { edgeStyleFor } from "../edgeStyleConfig.js";
import type { AcmEdge } from "../graphLayout.js";

/**
 * The single React Flow edge type (design.md §6): one parameterised component, the kind only
 * selects a config entry from `edgeStyleConfig.ts`. Owns the `data-edge-index`/`data-edge-kind`/
 * `data-resolution` attribute contract `webviewDom.test.ts`/`relationshipDetails.ts` address
 * edges by (ported from PR2b-ii's `PlainEdge` placeholder, now with real per-kind styling and
 * a directional particle).
 *
 * Only `resolution: "resolved"` edges ever reach this component: `graphLayout.ts`'s
 * `buildEdges` never emits an `AcmEdge` for an ambiguous/unresolved relationship (D12,
 * indicator-only) — `edgeStyleFor`'s `resolution` parameter exists to satisfy `EdgeKindStyle`'s
 * general contract, not because this component ever draws an unresolved edge.
 */
export function AcmKindEdge({ data }: EdgeProps<AcmEdge>) {
  if (!data) return null;
  const style = edgeStyleFor(data.kind, data.resolution);
  return (
    <g
      className={`acm-edge acm-edge-${data.kind}`}
      data-edge-index={data.edgeIndex}
      data-edge-kind={data.kind}
      data-resolution={data.resolution}
    >
      <title>{data.title}</title>
      <BaseEdge
        id={data.pathId}
        path={data.path}
        markerEnd={style.arrow === "none" ? undefined : `url(#acm-arrow-${data.kind})`}
        style={{
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          strokeDasharray: style.dashArray,
          fill: "none",
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }}
      />
      <circle className="acm-particle" r={style.particle.radius} fill={style.particle.fill}>
        <animateMotion
          dur={`${style.particle.durationMs}ms`}
          repeatCount="indefinite"
          keyPoints="0;1"
          keyTimes="0;1"
          calcMode="linear"
        >
          <mpath href={`#${data.pathId}`} />
        </animateMotion>
      </circle>
    </g>
  );
}
