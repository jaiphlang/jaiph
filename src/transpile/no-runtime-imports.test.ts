import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// Tests run from dist/src/transpile/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");
const transpileDir = join(repoRoot, "src/transpile");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listTsFiles(abs));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(abs);
  }
  return out;
}

test("AC1: no src/transpile/ production source imports from src/runtime/", () => {
  const files = listTsFiles(transpileDir);
  assert.ok(files.length > 0, "expected to discover transpile source files");
  for (const abs of files) {
    const rel = abs.slice(repoRoot.length + 1);
    const content = readFileSync(abs, "utf8");
    const re = /from\s+["'][^"']*\/runtime\/[^"']*["']/;
    assert.equal(
      re.test(content),
      false,
      `${rel} imports from src/runtime/ — compile-time must not depend on runtime semantics`,
    );
  }
});
