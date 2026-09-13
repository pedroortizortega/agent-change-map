/**
 * Fresh timing harness for `edge-router-performance` (sdd-design step 1).
 *
 * Methodology mirrors the react-flow-diagram-migration PR5 precedent
 * (`openspec/changes/archive/2026-09-12-react-flow-diagram-migration/apply-progress.md:1351-1391`):
 * a standalone `tsx` script importing `webview/graphLayout.ts` directly, measuring `layoutGraph`'s
 * synchronous compute cost on a synthetic FLAT graph (flat because every size probed here is above
 * `NESTED_LAYOUT_LIMITS` {60,120}, so a real session takes the flat-fallback path), which is the
 * dominant CPU-bound step before any pixel is painted. Not part of the committed test suite.
 *
 * Run from the repo root:
 *   npx tsx openspec/changes/edge-router-performance/perf/measure-layout.ts
 *   npx tsx openspec/changes/edge-router-performance/perf/measure-layout.ts 60,120 80,160 90,180
 *
 * Each row prints wall-clock ms for a cold `layoutGraph` call. Budgets to check against
 * (binding, from proposal.md "Proposal question round — RESOLVED"):
 *   - {60,120} (NESTED_LAYOUT_LIMITS boundary): < 2000 ms
 *   - new OVERSIZED_THRESHOLDS boundary:        <= 10000 ms (pick with margin, target <= ~6000 ms)
 */
import { layoutGraph } from "../../../../webview/graphLayout.js";
import type { AnalysisGraph, Edge, Entity } from "../../../../src/protocol.js";

const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" };
const span = { path: "pkg/a.py", startByte: 0, endByte: 3, startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };

/** Identical fixture shape to `test/unit/graphLayout.test.ts`'s committed perf probe, so the
 * numbers produced here are directly comparable to the probe's own assertion. */
function flatGraph(nodeCount: number, edgeCount: number): AnalysisGraph {
  const nodes: Entity[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `function:f${i}`,
    kind: "function" as const,
    qualifiedName: `f${i}`,
    span,
  }));
  const edges: Edge[] = Array.from({ length: edgeCount }, (_, i) => {
    const source = nodes[i % nodeCount]!.id;
    const target = nodes[(i * 7 + 3) % nodeCount]!.id; // spread targets to avoid a trivial ring
    return { kind: "call" as const, source, resolution: { kind: "resolved" as const, target }, span };
  });
  return { snapshot, nodes, edges, diagnostics: [] };
}

const DEFAULT_SIZES: [number, number][] = [
  [60, 120],   // NESTED_LAYOUT_LIMITS boundary — must be < 2000 ms
  [80, 160],
  [90, 180],
  [100, 200],
  [120, 240],
  [150, 300],  // expected well past 10 s per the stale PR5 numbers; confirms the curve's far end
];

const sizes: [number, number][] = process.argv.length > 2
  ? process.argv.slice(2).map((arg) => {
      const [n, e] = arg.split(",").map(Number);
      if (!Number.isFinite(n) || !Number.isFinite(e)) throw new Error(`bad size arg: ${arg}`);
      return [n, e] as [number, number];
    })
  : DEFAULT_SIZES;

console.log("| nodes | edges | layoutGraph ms |");
console.log("|---|---|---|");
for (const [nodeCount, edgeCount] of sizes) {
  const graph = flatGraph(nodeCount, edgeCount);
  const start = performance.now();
  const result = layoutGraph({ graph, diff: [], untrackedPaths: [], overrides: new Map() });
  const elapsedMs = performance.now() - start;
  if (result.nodes.length !== nodeCount) throw new Error("unexpected node count");
  console.log(`| ${nodeCount} | ${edgeCount} | ${elapsedMs.toFixed(0)} |`);
}
