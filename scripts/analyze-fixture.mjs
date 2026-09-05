import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relativePath = "test/fixtures/simple.py";
const fixturePath = resolve(extensionRoot, relativePath);
const analyzerPath = resolve(extensionRoot, "python/analyzer.py");
const request = {
  type: "analyze",
  snapshot: { repoId: "fixture", kind: "worktree", contentDigest: "sha256:fixture" },
  files: [{ path: relativePath, content: readFileSync(fixturePath, "utf8") }],
};
const result = spawnSync("python3", [analyzerPath], {
  input: `${JSON.stringify(request)}\n`,
  encoding: "utf8",
  shell: false,
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}
const lines = result.stdout.trim().split("\n");
if (lines.length !== 1) throw new Error(`Expected one JSON-lines response, received ${lines.length}`);
const graph = JSON.parse(lines[0]);
if (graph.error || !graph.nodes.some((node) => node.qualifiedName === "test.fixtures.simple.fixture_function")) throw new Error(`Fixture analysis failed: ${lines[0]}`);
console.log(`Analyzed ${relativePath}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.diagnostics.length} diagnostics.`);
