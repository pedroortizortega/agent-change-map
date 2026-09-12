import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["out/**", "node_modules/**", "test/integration/docker/**"],
    // Only React-rendering specs (`.test.tsx`) need a DOM environment; every other suite keeps
    // running under the faster default "node" environment.
    environmentMatchGlobs: [["test/**/*.test.tsx", "jsdom"]],
  },
});
