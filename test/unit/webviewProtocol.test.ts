import { describe, expect, it } from "vitest";
import { isOversized, OVERSIZED_THRESHOLDS, webviewToHostMessageSchema } from "../../src/webviewProtocol.js";
import type { HostToWebviewMessage } from "../../src/webviewProtocol.js";
import { DTO_LIMITS } from "../../src/protocol.js";

const sourceId = {
  snapshot: { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" },
  posixPath: "a.py",
  startByte: 0,
  endByte: 1,
  contentHash: "sha256:y",
};

describe("webview protocol", () => {
  it("keeps oversized display thresholds strictly below the hard DTO limits", () => {
    expect(OVERSIZED_THRESHOLDS.nodes).toBeLessThan(DTO_LIMITS.maxNodes);
    expect(OVERSIZED_THRESHOLDS.edges).toBeLessThan(DTO_LIMITS.maxEdges);
  });

  it("classifies a graph exceeding either threshold as oversized", () => {
    expect(isOversized({ nodes: Array(OVERSIZED_THRESHOLDS.nodes + 1).fill(0), edges: [] })).toBe(true);
    expect(isOversized({ nodes: [], edges: Array(OVERSIZED_THRESHOLDS.edges + 1).fill(0) })).toBe(true);
    expect(isOversized({ nodes: [], edges: [] })).toBe(false);
  });

  it("accepts a well-formed navigate intent", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "navigate", sourceId, side: "left" })).not.toThrow();
  });

  it("rejects an intent with a missing discriminant or malformed sourceId", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "navigate", sourceId: { ...sourceId, endByte: -1 }, side: "left" })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ sourceId, side: "left" })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ type: "unknown-intent" })).toThrow();
  });

  it("requires an explicit confirmed boolean for direct-write and run confirmation intents", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "confirmDirectWrite", requestId: "r1" })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ type: "confirmRun", requestId: "r1", confirmed: true })).not.toThrow();
  });

  it("carries a shared ops sequence on sourcePair and drops per-source affectedLines", () => {
    const message: Extract<HostToWebviewMessage, { type: "sourcePair" }> = {
      type: "sourcePair",
      sources: [{ side: "left", sourceId, content: "a\n", startLine: 1, endLine: 1 }],
      ops: [{ op: "unchanged", leftLine: 1, rightLine: 1, text: "a" }],
    };
    expect(message.ops).toEqual([{ op: "unchanged", leftLine: 1, rightLine: 1, text: "a" }]);
    expect(message.sources[0]).not.toHaveProperty("affectedLines");
  });
});
