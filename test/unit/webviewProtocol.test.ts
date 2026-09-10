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

  it("requires vintages on requestGraphView, bounded to the known enum and at most two entries", () => {
    const base = { type: "requestGraphView" as const, scopeIds: [], relationshipKinds: [], changeStatuses: [] };
    expect(() => webviewToHostMessageSchema.parse(base)).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ ...base, vintages: ["current"] })).not.toThrow();
    expect(() => webviewToHostMessageSchema.parse({ ...base, vintages: ["stale"] })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ ...base, vintages: ["current", "removed", "current"] })).toThrow();
  });

  it("accepts a well-formed requestSignature intent", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "requestSignature", requestId: "r1", sourceId, targetId: "function:a" })).not.toThrow();
  });

  it("rejects a requestSignature intent missing targetId or carrying a malformed sourceId", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "requestSignature", requestId: "r1", sourceId })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ type: "requestSignature", requestId: "r1", sourceId: { ...sourceId, endByte: -1 }, targetId: "function:a" })).toThrow();
    expect(() => webviewToHostMessageSchema.parse({ type: "requestSignature", requestId: "r1", sourceId, targetId: "" })).toThrow();
  });

  it("round-trips signatureResult and signatureUnavailable as HostToWebviewMessage variants", () => {
    const result: Extract<HostToWebviewMessage, { type: "signatureResult" }> = {
      type: "signatureResult",
      requestId: "r1",
      targetId: "function:a",
      parameters: [{ name: "x", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", defaultRepr: null, required: true }],
      cached: false,
    };
    expect(result.parameters[0]).toMatchObject({ name: "x", annotation: "int" });
    expect(result.cached).toBe(false);

    const unavailable: Extract<HostToWebviewMessage, { type: "signatureUnavailable" }> = {
      type: "signatureUnavailable",
      requestId: "r1",
      targetId: "function:a",
      reason: "Docker is not available.",
    };
    expect(unavailable.reason).toContain("Docker");
  });

  it("accepts a well-formed requestCall intent", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "requestCall", requestId: "r1", sourceId, targetId: "function:a", args: { x: 1 } })).not.toThrow();
  });

  it("rejects a requestCall intent whose args carries an overlong key", () => {
    const overlongKey = "k".repeat(257);
    expect(() =>
      webviewToHostMessageSchema.parse({ type: "requestCall", requestId: "r1", sourceId, targetId: "function:a", args: { [overlongKey]: 1 } }),
    ).toThrow();
  });

  it("accepts a well-formed confirmCall intent", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "confirmCall", requestId: "r1", confirmed: true })).not.toThrow();
  });

  it("requires an explicit confirmed boolean for confirmCall", () => {
    expect(() => webviewToHostMessageSchema.parse({ type: "confirmCall", requestId: "r1" })).toThrow();
  });

  it("round-trips callConfirmationRequired and callResult as HostToWebviewMessage variants", () => {
    const confirmationRequired: Extract<HostToWebviewMessage, { type: "callConfirmationRequired" }> = {
      type: "callConfirmationRequired",
      requestId: "r1",
      dottedName: "Widget",
      argsPreview: '{\n  "name": "a"\n}',
    };
    expect(confirmationRequired.dottedName).toBe("Widget");

    const result: Extract<HostToWebviewMessage, { type: "callResult" }> = {
      type: "callResult",
      requestId: "r1",
      result: { variant: "current", kind: "success", exitCode: 0, stdout: "", stderr: "" },
      returnRepr: "1",
    };
    expect(result.result.kind).toBe("success");
    expect(result.returnRepr).toBe("1");
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
