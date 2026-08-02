import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

// Guards docs/agent-analyzability.md's CI-enforced fan-out and file-size caps:
// `npm run lint` (ESLint) keeps each production file under src/ at <= 8 runtime
// imports (import/max-dependencies) and <= 400 non-blank/non-comment lines
// (max-lines). These tests fail if the script/config are removed, if the caps
// stop catching new violations, if CI drops the step, or if a grandfathered
// file loses its explicit, justified override.

// Compiled test lives at dist/src/, so repo root is two levels up.
const repoRoot = resolve(__dirname, "../..");
const configPath = join(repoRoot, "eslint.config.mjs");
// The eslint bin, invoked directly (same binary `npm run lint` shells out to)
// so the test does not depend on npm being on PATH.
const eslintBin = join(repoRoot, "node_modules/eslint/bin/eslint.js");

// Run eslint from repoRoot (so the committed flat config and its `src/**` globs
// resolve exactly as `npm run lint` does). Returns {status, output}.
function eslint(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [eslintBin, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

// Fixture files must live under src/ so the committed config's `src/**/*.ts`
// glob applies (ESLint resolves flat-config globs relative to the config file's
// directory; a file outside src/ would match nothing and be linted with no
// rules). We create a throwaway dir under src/, lint one file, then remove it.
function withFixture(fileName: string, content: string): {
  status: number;
  output: string;
} {
  const dir = mkdtempSync(join(repoRoot, "src", "eslint-caps-fixture-"));
  const abs = join(dir, fileName);
  writeFileSync(abs, content);
  try {
    return eslint([relative(repoRoot, abs)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The true violator set: lint the committed tree but re-enable both caps via
// CLI --rule, which overrides the per-file grandfather "off" switches. What
// remains is exactly the set of files the config grandfathers.
function grandfatheredViolators(): string[] {
  const { output } = eslint([
    "src",
    "--rule",
    JSON.stringify({
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
    }),
    "--rule",
    JSON.stringify({
      "import/max-dependencies": ["error", { max: 8, ignoreTypeImports: true }],
    }),
    "--format",
    "json",
  ]);
  const results = JSON.parse(output) as Array<{
    filePath: string;
    messages: Array<{ ruleId: string | null }>;
  }>;
  return results
    .filter((r) => r.messages.some((m) => m.ruleId))
    .map((r) => relative(repoRoot, r.filePath))
    .sort();
}

describe("ESLint agent-analyzability caps guard", () => {
  it("AC1: config + lint script exist and lint passes on the committed tree", () => {
    assert.ok(existsSync(configPath), "eslint.config.mjs must exist");

    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(
      pkg.scripts.lint,
      "eslint src --max-warnings 0",
      "package.json must wire `lint` to eslint with --max-warnings 0",
    );

    const { status } = eslint(["src", "--max-warnings", "0"]);
    assert.equal(status, 0, "npm run lint must exit 0 on the committed tree");
  });

  it("AC2: 9 distinct runtime imports fail import/max-dependencies", () => {
    const imports = Array.from(
      { length: 9 },
      (_v, i) => `import { m${i} } from "./m${i}";`,
    ).join("\n");
    const { status, output } = withFixture(
      "fanout.ts",
      `${imports}\nexport const total = ${9};\n`,
    );
    assert.notEqual(status, 0, "9 runtime imports must fail the cap of 8");
    assert.match(output, /import\/max-dependencies/);
  });

  it("AC2b: type-only imports do not count (ignoreTypeImports)", () => {
    // 8 runtime + 4 type-only imports = 9 lines but only 8 runtime deps: passes.
    const runtime = Array.from(
      { length: 8 },
      (_v, i) => `import { m${i} } from "./m${i}";`,
    ).join("\n");
    const types = Array.from(
      { length: 4 },
      (_v, i) => `import type { T${i} } from "./t${i}";`,
    ).join("\n");
    const { status } = withFixture(
      "typefanout.ts",
      `${runtime}\n${types}\nexport const total = ${8};\n`,
    );
    assert.equal(status, 0, "type-only imports must not count toward the cap");
  });

  it("AC3: >400 non-blank/non-comment lines fail max-lines", () => {
    const body = Array.from(
      { length: 401 },
      (_v, i) => `export const line${i} = ${i};`,
    ).join("\n");
    const { status, output } = withFixture("toolong.ts", `${body}\n`);
    assert.notEqual(status, 0, "401 code lines must fail the cap of 400");
    assert.match(output, /max-lines/);
  });

  it("AC3b: blank and comment lines are skipped by max-lines", () => {
    // 400 code lines padded with blanks and comments stays within the cap.
    const parts: string[] = [];
    for (let i = 0; i < 400; i++) {
      parts.push(`export const line${i} = ${i};`);
      parts.push("");
      parts.push("// filler comment line");
    }
    const { status } = withFixture("padded.ts", `${parts.join("\n")}\n`);
    assert.equal(status, 0, "blank/comment lines must not count toward max-lines");
  });

  it("AC4: ci.yml runs npm run lint on the unit-test job", () => {
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /npm run lint/);
  });

  it("AC5: every grandfathered file has an explicit, justified override", () => {
    const violators = grandfatheredViolators();
    assert.ok(
      violators.length > 0,
      "caps must actually bite: expected pre-existing violators to grandfather",
    );

    const config = readFileSync(configPath, "utf8");
    const configLines = config.split("\n");

    // The set of concrete single-file paths the config grandfathers (exclude the
    // main `files: ["src/**/*.ts", ...]` glob entry, which contains a `*`).
    const declared = Array.from(
      config.matchAll(/"(src\/[^"*]+\.tsx?)"/g),
      (m) => m[1],
    ).sort();

    // The committed grandfather list must match reality exactly: no stale
    // entries (over-grandfathering) and no missing ones (which AC1 already
    // catches, but assert here for a precise message).
    assert.deepEqual(
      declared,
      violators,
      "grandfather overrides must list exactly the files that violate a cap",
    );

    // Each grandfathered file needs a one-line justification: the line directly
    // above its `files:` entry must be a `//` comment.
    for (const path of violators) {
      const idx = configLines.findIndex((l) => l.includes(`files: ["${path}"]`));
      assert.ok(idx > 0, `override for ${path} must be a single-file files array`);
      assert.match(
        configLines[idx - 1].trim(),
        /^\/\//,
        `grandfathered ${path} must have a one-line justification comment`,
      );
    }
  });
});
