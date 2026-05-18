import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsejaiphWithTrivia } from "../parser";
import { emitModule } from "./emit";

// Tests run from dist/src/format/roundtrip.test.js, so repo root is four levels up.
const repoRoot = resolve(__dirname, "../../..");

function findjhFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(p);
      } else if (p.endsWith(".jh") && !p.endsWith(".broken.jh")) {
        // Skip *.test.jh? We include them — they're also DSL.
        out.push(p);
      }
    }
  }
  return out.sort();
}

const fixtureRoots = [
  join(repoRoot, "examples"),
  join(repoRoot, "test-fixtures/golden-ast/fixtures"),
];

const allFixtures: string[] = [];
for (const root of fixtureRoots) {
  allFixtures.push(...findjhFiles(root));
}

if (allFixtures.length === 0) {
  test("AC3: round-trip fixtures present", () => {
    assert.fail("expected at least one .jh fixture under examples/ and test-fixtures/");
  });
}

for (const file of allFixtures) {
  const rel = file.replace(repoRoot + "/", "");
  test(`AC3: parse → format → parse → format is bit-for-bit on ${rel}`, () => {
    const source = readFileSync(file, "utf8");
    // First pass: parse and format.
    const first = parsejaiphWithTrivia(source, file);
    const formatted1 = emitModule(first.ast, first.trivia);
    // Second pass: parse the formatted output and format again.
    const second = parsejaiphWithTrivia(formatted1, file);
    const formatted2 = emitModule(second.ast, second.trivia);
    assert.equal(
      formatted2,
      formatted1,
      `second formatting diverged from first for ${rel}`,
    );
  });
}
