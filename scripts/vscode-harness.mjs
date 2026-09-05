import { existsSync } from "node:fs";

const required = ["test/unit", "test/integration", "test/e2e", "test/fixtures"];
const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(`VS Code harness is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("VS Code harness foundation ready (extension e2e scenarios are assigned to Phase 5).\n");
