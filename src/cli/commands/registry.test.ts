import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRegistryIndex } from "./registry";

// Compiled to dist/src/cli/commands/registry.test.js — four levels up lands at repo root.
const SHIPPED_REGISTRY = resolve(__dirname, "../../../../docs/registry");

test("shipped docs/registry parses through loadRegistryIndex", async () => {
  const index = await loadRegistryIndex(SHIPPED_REGISTRY);
  assert.ok(Object.keys(index.libs).length > 0, "shipped registry must list at least one lib");
});

test("shipped docs/registry has no Jekyll front matter and parses as JSON", () => {
  const text = readFileSync(SHIPPED_REGISTRY, "utf8");
  assert.ok(!text.trimStart().startsWith("---"), "docs/registry must not carry Jekyll front matter");
  assert.doesNotThrow(() => JSON.parse(text), "docs/registry must be valid JSON");
});
