import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const targets = [["webview/styles.css", "out/webview/webview/styles.css"]];

for (const [source, destination] of targets) {
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  copyFileSync(resolve(source), resolve(destination));
}
console.log("Copied webview static assets.");
