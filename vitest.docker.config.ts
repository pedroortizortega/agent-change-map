import { defineConfig } from "vitest/config";

/**
 * Separate config for the real-Docker restricted-execution suite (`npm run test:docker`).
 * These tests are slow and require a working Docker Engine, so they are excluded from
 * the default `vitest run` / `npm test` and `test:integration` suites and run only
 * explicitly via this config.
 */
export default defineConfig({
  test: {
    include: ["test/integration/docker/**/*.test.ts"],
    exclude: ["out/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
