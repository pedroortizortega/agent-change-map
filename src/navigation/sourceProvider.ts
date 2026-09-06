import { createHash } from "node:crypto";
import type { SnapshotDiff } from "../snapshots/snapshotStore.js";
import type { SnapshotStore } from "../snapshots/snapshotStore.js";
import { sourceIdSchema, type AnalysisGraph, type Entity, type SnapshotId, type SourceId } from "../protocol.js";

/** Raised when a source span no longer matches the captured snapshot content. */
export class StaleSourceError extends Error {}

export interface EntityDiffEntry {
  kind: "entity";
  qualifiedName: string;
  left?: Entity;
  right?: Entity;
}

export interface FileDiffDiagnosticEntry {
  kind: "file";
  path: string;
  diagnostic: string;
}

export type CorrelatedDiffEntry = EntityDiffEntry | FileDiffDiagnosticEntry;

export function computeContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Builds an immutable SourceId identifying an exact byte span within a captured file. */
export function createSourceId(snapshot: SnapshotId, posixPath: string, content: string, startByte: number, endByte: number): SourceId {
  const buffer = Buffer.from(content, "utf8");
  const slice = buffer.subarray(startByte, endByte).toString("utf8");
  return sourceIdSchema.parse({ snapshot, posixPath, startByte, endByte, contentHash: computeContentHash(slice) });
}

/**
 * Resolves a SourceId to its exact content within the snapshot store, verifying that
 * the byte span and content hash still match the captured state. Refuses stale sources
 * rather than approximating their location.
 */
export function resolveSource(store: SnapshotStore, sourceId: SourceId): string {
  const validated = sourceIdSchema.parse(sourceId);
  const content = store.getFileContent(validated.snapshot, validated.posixPath);
  if (content === undefined) throw new StaleSourceError(`Source file not found in snapshot: ${validated.posixPath}`);
  const buffer = Buffer.from(content, "utf8");
  if (validated.endByte > buffer.length) throw new StaleSourceError(`Source span exceeds captured content for ${validated.posixPath}`);
  const slice = buffer.subarray(validated.startByte, validated.endByte).toString("utf8");
  if (computeContentHash(slice) !== validated.contentHash) throw new StaleSourceError(`Source content changed for ${validated.posixPath}`);
  return slice;
}

/**
 * Correlates a file-level snapshot diff with analyzable entities from both states.
 * Files without corresponding entities in either state keep a file-level diagnostic
 * instead of being discarded.
 */
export function correlateDiff(diff: SnapshotDiff, leftGraph: AnalysisGraph | undefined, rightGraph: AnalysisGraph | undefined): CorrelatedDiffEntry[] {
  const entries: CorrelatedDiffEntry[] = [];
  for (const file of diff.entries) {
    const leftEntities = leftGraph?.nodes.filter((node) => node.span.path === file.path) ?? [];
    const rightEntities = rightGraph?.nodes.filter((node) => node.span.path === file.path) ?? [];
    if (leftEntities.length === 0 && rightEntities.length === 0) {
      entries.push({ kind: "file", path: file.path, diagnostic: "No structural entities available for this file" });
      continue;
    }
    const qualifiedNames = [...new Set([...leftEntities.map((entity) => entity.qualifiedName), ...rightEntities.map((entity) => entity.qualifiedName)])].sort();
    for (const qualifiedName of qualifiedNames) {
      const left = leftEntities.find((entity) => entity.qualifiedName === qualifiedName);
      const right = rightEntities.find((entity) => entity.qualifiedName === qualifiedName);
      entries.push({ kind: "entity", qualifiedName, left, right });
    }
  }
  return entries;
}
