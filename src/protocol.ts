import { z } from "zod";

export const DTO_LIMITS = {
  maxFiles: 256,
  maxPathLength: 1024,
  maxFileContentBytes: 2 * 1024 * 1024,
  maxNodes: 100_000,
  maxEdges: 250_000,
  maxDiagnostics: 10_000,
  maxIdentifierLength: 4096,
  maxDiagnosticMessageLength: 8192,
} as const;

const boundedString = (maximum: number) => z.string().min(1).max(maximum);
const boundedContent = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= DTO_LIMITS.maxFileContentBytes, `File content exceeds ${DTO_LIMITS.maxFileContentBytes} UTF-8 bytes`);

export const snapshotIdSchema = z.object({
  repoId: boundedString(DTO_LIMITS.maxIdentifierLength),
  kind: z.enum(["commit", "worktree"]),
  resolvedOid: boundedString(DTO_LIMITS.maxIdentifierLength).optional(),
  contentDigest: boundedString(DTO_LIMITS.maxIdentifierLength),
});

export const sourceSpanSchema = z.object({
  path: boundedString(DTO_LIMITS.maxPathLength),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().nonnegative(),
}).refine((span) => span.endByte >= span.startByte, "Source byte span must be ordered").refine(
  (span) => span.endLine > span.startLine || (span.endLine === span.startLine && span.endColumn >= span.startColumn),
  "Source span must be ordered",
);

export const entitySchema = z.object({
  id: boundedString(DTO_LIMITS.maxIdentifierLength),
  kind: z.enum(["package", "module", "class", "function", "method"]),
  qualifiedName: boundedString(DTO_LIMITS.maxIdentifierLength),
  containerId: boundedString(DTO_LIMITS.maxIdentifierLength).optional(),
  span: sourceSpanSchema,
});

export const edgeResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), target: boundedString(DTO_LIMITS.maxIdentifierLength) }),
  z.object({ kind: z.literal("ambiguous"), candidates: z.array(boundedString(DTO_LIMITS.maxIdentifierLength)).min(2).max(DTO_LIMITS.maxNodes) }),
  z.object({ kind: z.literal("unresolved") }),
]);

export const edgeSchema = z.object({
  kind: z.enum(["contains", "import", "call"]),
  source: boundedString(DTO_LIMITS.maxIdentifierLength),
  resolution: edgeResolutionSchema,
  span: sourceSpanSchema,
  importedName: boundedString(DTO_LIMITS.maxIdentifierLength).optional(),
});

export const diagnosticSchema = z.object({
  path: boundedString(DTO_LIMITS.maxPathLength),
  message: boundedString(DTO_LIMITS.maxDiagnosticMessageLength),
  severity: z.enum(["error", "warning"]),
  span: sourceSpanSchema.optional(),
});

export const analysisGraphSchema = z.object({
  snapshot: snapshotIdSchema,
  nodes: z.array(entitySchema).max(DTO_LIMITS.maxNodes),
  edges: z.array(edgeSchema).max(DTO_LIMITS.maxEdges),
  diagnostics: z.array(diagnosticSchema).max(DTO_LIMITS.maxDiagnostics),
});

export const analyzeRequestSchema = z.object({
  type: z.literal("analyze"),
  snapshot: snapshotIdSchema,
  files: z.array(z.object({ path: boundedString(DTO_LIMITS.maxPathLength), content: boundedContent })).min(1).max(DTO_LIMITS.maxFiles),
});

export type SnapshotId = z.infer<typeof snapshotIdSchema>;
export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type EdgeResolution = z.infer<typeof edgeResolutionSchema>;
export type Edge = z.infer<typeof edgeSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type AnalysisGraph = z.infer<typeof analysisGraphSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
