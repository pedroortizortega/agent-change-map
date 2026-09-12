import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const vendor = readFileSync(require.resolve("@xyflow/react/dist/style.css"), "utf8");
const own = readFileSync(resolve("webview/styles.css"), "utf8");
const out = resolve("out/webview/webview/styles.css");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${vendor}\n/* --- agent-change-map --- */\n${own}`);
console.log("Copied webview static assets.");
