import { describe, expect, it } from "vitest";
import { createSourceId, resolveModuleSource, resolveSource, StaleSourceError } from "../../src/navigation/sourceProvider.js";
import { SnapshotStore } from "../../src/snapshots/snapshotStore.js";

const snapshot = { repoId: "repo", kind: "worktree" as const, contentDigest: "sha256:x" };
const nestedContent = "class Outer:\n    def method(self):\n        return 1\n";
const methodStart = nestedContent.indexOf("    def method");
const methodEnd = nestedContent.length;

function makeStore(content: string): SnapshotStore {
  const store = new SnapshotStore();
  store.store({ snapshot, files: [{ path: "m.py", content, provenance: "tracked" }] });
  return store;
}

describe("resolveModuleSource", () => {
  it("returns the whole file, not just the entity's own slice (regression: introspection/call on a nested method)", () => {
    // Before this fix, introspection/invocation used resolveSource's entity-only slice as the
    // driver's module source. For a method nested inside a class, that slice never includes
    // the `class Outer:` line, so the sandboxed driver's `getattr(module, "Outer")` failed
    // with AttributeError before ever reaching inspect.signature() or the call - exactly the
    // failure a live user hit on every method/nested-class selection.
    const store = makeStore(nestedContent);
    const sourceId = createSourceId(snapshot, "m.py", nestedContent, methodStart, methodEnd);

    // Sanity check: the entity's own slice genuinely omits the class line (confirms this test
    // exercises the real bug scenario, not a vacuous one).
    expect(resolveSource(store, sourceId)).not.toContain("class Outer");

    const resolved = resolveModuleSource(store, sourceId);
    expect(resolved).toBe(nestedContent);
    expect(resolved).toContain("class Outer");
  });

  it("splices draft content into the entity's own span, preserving the surrounding file", () => {
    const store = makeStore(nestedContent);
    const sourceId = createSourceId(snapshot, "m.py", nestedContent, methodStart, methodEnd);

    const resolved = resolveModuleSource(store, sourceId, "    def method(self):\n        return 2\n");
    expect(resolved).toBe("class Outer:\n    def method(self):\n        return 2\n");
    expect(resolved).toContain("class Outer");
  });

  it("refuses a stale source (content changed since the span was captured) exactly like resolveSource", () => {
    const store = makeStore(nestedContent);
    const sourceId = createSourceId(snapshot, "m.py", nestedContent, methodStart, methodEnd);
    store.store({ snapshot, files: [{ path: "m.py", content: nestedContent.replace("return 1", "return 999"), provenance: "tracked" }] });

    expect(() => resolveModuleSource(store, sourceId)).toThrow(StaleSourceError);
  });
});
