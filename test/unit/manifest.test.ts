import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("contributes a discoverable compare command for normal activation", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: "agentChangeMap.compare", title: expect.any(String) }));
});
