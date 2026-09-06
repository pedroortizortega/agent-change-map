import { runScenarios } from "./scenarios.js";

/**
 * Entry point loaded by `@vscode/test-electron`'s `runTests({ extensionTestsPath })`
 * inside a real Extension Development Host. No test framework (Mocha, etc.) is used here:
 * `run()` performs real `node:assert` assertions directly and rejects on the first
 * failure, which is all `@vscode/test-electron` requires.
 */
export async function run(): Promise<void> {
  await runScenarios();
}
