import { describe, expect, it } from "vitest";
import {
  analysisGraphSchema,
  analyzeRequestSchema,
  entitySchema,
  DTO_LIMITS,
  type AnalysisGraph,
} from "../../src/protocol.js";

const span = {
  path: "pkg/sample.py",
  startByte: 0,
  endByte: 12,
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 12,
};

describe("analyzer protocol", () => {
  it("accepts a graph with explicit edge resolutions and evidence", () => {
    const graph: AnalysisGraph = {
      snapshot: { repoId: "repo", kind: "worktree", contentDigest: "sha256:abc" },
      nodes: [
        { id: "module:pkg.sample", kind: "module", qualifiedName: "pkg.sample", span },
      ],
      edges: [
        {
          kind: "call",
          source: "module:pkg.sample",
          resolution: { kind: "ambiguous", candidates: ["function:a", "function:b"] },
          span,
        },
      ],
      diagnostics: [],
    };

    expect(analysisGraphSchema.parse(graph)).toEqual(graph);
  });

  it("rejects malformed requests and edges that omit resolution", () => {
    expect(() => analyzeRequestSchema.parse({ type: "analyze", files: [] })).toThrow();
    expect(() =>
      analysisGraphSchema.parse({
        snapshot: { repoId: "repo", kind: "commit", resolvedOid: "abc", contentDigest: "sha256:abc" },
        nodes: [],
        edges: [{ kind: "call", source: "missing", span }],
        diagnostics: [],
      }),
    ).toThrow();
  });

  it("requires ordered source spans while allowing exact empty-file evidence", () => {
    expect(() =>
      analysisGraphSchema.parse({
        snapshot: { repoId: "repo", kind: "worktree", contentDigest: "sha256:abc" },
        nodes: [{ id: "x", kind: "function", qualifiedName: "x", span: { ...span, endByte: 0 } }],
        edges: [],
        diagnostics: [],
      }),
    ).not.toThrow();
  });

  it("enforces request collection and string bounds", () => {
    const request = { type: "analyze", snapshot: { repoId: "repo", kind: "worktree", contentDigest: "x" }, files: [{ path: "a.py", content: "" }] };
    expect(() => analyzeRequestSchema.parse({ ...request, files: Array.from({ length: DTO_LIMITS.maxFiles + 1 }, () => request.files[0]) })).toThrow();
    expect(() => analyzeRequestSchema.parse({ ...request, files: [{ path: "p".repeat(DTO_LIMITS.maxPathLength + 1), content: "" }] })).toThrow();
    expect(() => analyzeRequestSchema.parse({ ...request, files: [{ path: "a.py", content: "x".repeat(DTO_LIMITS.maxFileContentBytes + 1) }] })).toThrow();
  });

  it("accepts an entity with an optional target for introspection/invocation addressing", () => {
    const functionEntity = {
      id: "function:pkg.sample.run",
      kind: "function",
      qualifiedName: "pkg.sample.run",
      span,
      target: { module: "pkg.sample", dottedName: "run", callableKind: "function" },
    };
    expect(entitySchema.parse(functionEntity)).toEqual(functionEntity);

    const classEntity = {
      id: "class:pkg.sample.Widget",
      kind: "class",
      qualifiedName: "pkg.sample.Widget",
      span,
      target: { module: "pkg.sample", dottedName: "Widget", callableKind: "class" },
    };
    expect(entitySchema.parse(classEntity)).toEqual(classEntity);
  });

  it("rejects a malformed target shape", () => {
    const base = { id: "function:pkg.sample.run", kind: "function", qualifiedName: "pkg.sample.run", span };
    expect(() => entitySchema.parse({ ...base, target: { module: "pkg.sample" } })).toThrow();
    expect(() => entitySchema.parse({ ...base, target: { module: "pkg.sample", dottedName: "run", callableKind: "lambda" } })).toThrow();
    expect(() => entitySchema.parse({ ...base, target: { dottedName: "run", callableKind: "function" } })).toThrow();
  });

  it("still validates an entity with target entirely absent (back-compat)", () => {
    const entity = { id: "module:pkg.sample", kind: "module", qualifiedName: "pkg.sample", span };
    expect(entitySchema.parse(entity)).toEqual(entity);
  });

  it("enforces response collection and relevant string bounds", () => {
    const base = { snapshot: { repoId: "repo", kind: "worktree", contentDigest: "x" }, nodes: [], edges: [], diagnostics: [] };
    expect(() => analysisGraphSchema.parse({ ...base, nodes: Array.from({ length: DTO_LIMITS.maxNodes + 1 }, () => ({ id: "x", kind: "module", qualifiedName: "x", span })) })).toThrow();
    expect(() => analysisGraphSchema.parse({ ...base, edges: Array.from({ length: DTO_LIMITS.maxEdges + 1 }, () => ({ kind: "call", source: "x", resolution: { kind: "unresolved" }, span })) })).toThrow();
    expect(() => analysisGraphSchema.parse({ ...base, diagnostics: Array.from({ length: DTO_LIMITS.maxDiagnostics + 1 }, () => ({ path: "a.py", severity: "error", message: "x" })) })).toThrow();
    expect(() => analysisGraphSchema.parse({ ...base, diagnostics: [{ path: "a.py", severity: "error", message: "x".repeat(DTO_LIMITS.maxDiagnosticMessageLength + 1) }] })).toThrow();
    expect(() => analysisGraphSchema.parse({ ...base, nodes: [{ id: "x".repeat(DTO_LIMITS.maxIdentifierLength + 1), kind: "module", qualifiedName: "x", span }] })).toThrow();
  });
});
