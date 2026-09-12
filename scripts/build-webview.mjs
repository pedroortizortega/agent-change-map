import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["webview/index.tsx"],
  outfile: "out/webview/webview/index.js", // exact path src/extension.ts already resolves
  bundle: true,
  format: "esm", // <script type="module"> is unchanged
  splitting: false, // one file → one nonce'd <script>, CSP unchanged
  platform: "browser",
  target: ["es2022", "chrome114"], // VS Code ^1.95 ships Chromium ≫ 114
  jsx: "automatic",
  jsxImportSource: "react",
  define: { "process.env.NODE_ENV": '"production"' }, // D11 — mandatory
  loader: { ".css": "empty" }, // safety net: a stray CSS import never emits a file
  external: [], // nothing is external; `acquireVsCodeApi` is a global
  minify: false, // keep the bundle reviewable/diffable in the .vsix
  legalComments: "none",
  sourcemap: process.env.ACM_WEBVIEW_SOURCEMAP === "1" ? "inline" : false,
  logLevel: "info",
});
