import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parsejaiph } from "./parser";
import { jaiphModule } from "./types";

// --- AST serializer for golden tests ---

/**
 * Produces a deterministic JSON string from a parsed jaiphModule.
 * Strips `loc` and `filePath` so goldens are not sensitive to line churn
 * or absolute paths. Keys are sorted for stable output.
 */
export function serializeAstForTest(mod: jaiphModule): string {
  return JSON.stringify(stripLocations(mod), null, 2) + "\n";
}

function stripLocations(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripLocations);

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    if (key === "loc" || key === "filePath") continue;
    out[key] = stripLocations(obj[key]);
  }
  return out;
}

// --- golden test runner ---

const fixturesDir = resolve(process.cwd(), "golden-ast/fixtures");
const expectedDir = resolve(process.cwd(), "golden-ast/expected");
const updateMode = process.env.UPDATE_GOLDEN === "1";

const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".jh")).sort();

for (const fixture of fixtures) {
  const name = basename(fixture, ".jh");
  const goldenPath = join(expectedDir, `${name}.json`);

  test(`golden-ast: ${name}`, () => {
    const source = readFileSync(join(fixturesDir, fixture), "utf8");
    const mod = parsejaiph(source, fixture);
    const actual = serializeAstForTest(mod);

    if (updateMode) {
      writeFileSync(goldenPath, actual, "utf8");
      return;
    }

    if (!existsSync(goldenPath)) {
      assert.fail(
        `Golden file missing: ${goldenPath}\nRun with UPDATE_GOLDEN=1 to create it.`,
      );
    }

    const expected = readFileSync(goldenPath, "utf8");
    assert.equal(
      actual,
      expected,
      `AST mismatch for ${fixture}. Run UPDATE_GOLDEN=1 npm run test:golden-ast to update.`,
    );
  });
}
