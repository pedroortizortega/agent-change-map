import { z } from "zod";
import { DTO_LIMITS, sourceIdSchema, type AnalysisGraph, type SourceId } from "./protocol.js";
import type { CorrelatedDiffEntry } from "./navigation/sourceProvider.js";
import type { RunResult, SnippetVariant } from "./execution/dockerRunner.js";
import type { WriteEffectPreview } from "./editing/writeGuard.js";
import type { DiffOp } from "./diff/lineDiff.js";

/**
 * Usability thresholds for rendering a map without an explicit opt-in. These are
 * deliberately far below the hard DTO safety caps in `protocol.ts` (`DTO_LIMITS.maxNodes`
 * / `maxEdges`, sized to bound worst-case payloads): those caps exist to reject
 * pathological input, while these thresholds exist to keep an *ordinary* whole-project
 * map usable. A map may be well within DTO limits and still be oversized for display.
 */
export const OVERSIZED_THRESHOLDS = {
  nodes: 300,
  edges: 600,
} as const;

if (OVERSIZED_THRESHOLDS.nodes >= DTO_LIMITS.maxNodes || OVERSIZED_THRESHOLDS.edges >= DTO_LIMITS.maxEdges) {
  throw new Error("Oversized display thresholds must stay below the hard DTO limits");
}

export function isOversized(graph: Pick<AnalysisGraph, "nodes" | "edges">): boolean {
  return graph.nodes.length > OVERSIZED_THRESHOLDS.nodes || graph.edges.length > OVERSIZED_THRESHOLDS.edges;
}

const requestId = z.string().min(1).max(DTO_LIMITS.maxIdentifierLength);
const variant = z.enum(["original", "current", "draft"]);

export const webviewToHostMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("confirmOversized"), confirmed: z.boolean() }),
  z.object({ type: z.literal("requestGraphView"), scopeIds: z.array(requestId).max(100), relationshipKinds: z.array(z.enum(["contains", "import", "call"])).max(3), changeStatuses: z.array(z.enum(["added", "removed", "modified", "unchanged"])).max(4), vintages: z.array(z.enum(["current", "removed"])).max(2) }),
  z.object({ type: z.literal("requestSnippetWrite"), requestId, sourceId: sourceIdSchema, content: z.string().max(DTO_LIMITS.maxFileContentBytes) }),
  z.object({ type: z.literal("inspectSources"), nodeId: requestId }),
  z.object({ type: z.literal("navigate"), sourceId: sourceIdSchema, side: z.enum(["left", "right"]) }),
  z.object({ type: z.literal("saveDraft"), sourceId: sourceIdSchema, content: z.string().max(DTO_LIMITS.maxFileContentBytes) }),
  z.object({
    type: z.literal("requestDirectWrite"),
    requestId,
    repoRoot: z.string().min(1),
    targetPath: z.string().min(1),
    baseHash: z.string().min(1),
    replacement: z.string().max(DTO_LIMITS.maxFileContentBytes),
  }),
  z.object({ type: z.literal("confirmDirectWrite"), requestId, confirmed: z.boolean() }),
  z.object({ type: z.literal("requestRun"), requestId, variants: z.array(variant).min(1).max(3) }),
  z.object({ type: z.literal("confirmRun"), requestId, confirmed: z.boolean() }),
  z.object({ type: z.literal("cancelRun"), requestId }),
  z.object({ type: z.literal("requestRefresh"), requestId }),
]);

export type WebviewToHostMessage = z.infer<typeof webviewToHostMessageSchema>;

export type HostToWebviewMessage =
  | { type: "graphSummary"; nodeCount: number; edgeCount: number; diagnosticCount: number; oversized: boolean; sections?: { id: string; label: string }[]; loadReason: "initial" | "refresh" }
  /** `edgeSources` and `edgeOrigins` are index-aligned with `graph.edges`; an absent `edgeSources` entry means no exact captured edge location is available. */
  | { type: "graph"; graph: AnalysisGraph; diff: CorrelatedDiffEntry[]; sourceIndex: Record<string, { left?: SourceId; right?: SourceId }>; edgeSources: ({ sourceId: SourceId; side: "left" | "right" } | undefined)[]; edgeOrigins: ("current" | "removed")[]; untrackedPaths: string[] }
  | { type: "navigateResult"; ok: true; sourceId: SourceId; content: string; draftContent?: string }
  | { type: "navigateResult"; ok: false; sourceId: SourceId; reason: string }
  | { type: "sourcePair"; sources: { side: "left" | "right"; sourceId: SourceId; content: string; startLine: number; endLine: number }[]; ops: DiffOp[] }
  | { type: "draftSaved"; sourceId: SourceId; content: string }
  | { type: "directWritePreview"; requestId: string; preview: WriteEffectPreview }
  | { type: "directWriteResult"; requestId: string; ok: true; path: string }
  | { type: "directWriteResult"; requestId: string; ok: false; reason: string }
  | { type: "runConfirmationRequired"; requestId: string; variants: SnippetVariant[]; sources?: { variant: SnippetVariant; path?: string; content?: string }[] }
  | { type: "runEvent"; requestId: string; variant: SnippetVariant; seq: number; channel: "stdout" | "stderr" | "status"; data: string }
  | { type: "runFailed"; requestId: string; reason: string }
  | { type: "runResult"; requestId: string; results: RunResult[] }
  | { type: "error"; message: string }
  | { type: "refreshResult"; requestId: string; ok: true }
  | { type: "refreshResult"; requestId: string; ok: false; reason: string }
  | { type: "refreshDeferred"; reason: string };
