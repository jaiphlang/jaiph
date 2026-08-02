import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Guards docs/agent-analyzability.md's CI-enforced import-graph invariant:
// `npm run arch:check` (dependency-cruiser) must keep src/ an acyclic layered
// DAG. These tests fail if the script/config/baseline are removed and if the
// committed rules stop catching new cycles or upward layer imports.

// Compiled test lives at dist/src/, so repo root is two levels up.
const repoRoot = resolve(__dirname, "../..");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");
const baselinePath = join(repoRoot, ".dependency-cruiser-known-violations.json");
// The package `exports` map blocks Node resolution of the bin subpath, so use
// its committed node_modules path (npm ci installs it here on the test jobs).
const depcruiseBin = join(
  repoRoot,
  "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
);

// Run dependency-cruiser directly (same binary `arch:check` shells out to) so
// the test does not depend on npm being on PATH. Returns {status, output}.
function depcruise(
  cwd: string,
  args: string[],
): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [depcruiseBin, ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

// Build a throwaway repo whose file paths match the config's `^src/...` layer
// regexes, so the committed rules apply exactly as they do on the real tree.
function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jaiph-arch-check-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
      include: ["src/**/*.ts"],
    }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("arch:check dependency-cruiser guard", () => {
  it("AC1: config, baseline, and arch:check script exist and pass on the committed tree", () => {
    assert.ok(existsSync(configPath), ".dependency-cruiser.cjs must exist");
    assert.ok(
      existsSync(baselinePath),
      ".dependency-cruiser-known-violations.json baseline must exist",
    );

    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    assert.equal(
      pkg.scripts["arch:check"],
      "depcruise src --config .dependency-cruiser.cjs --ignore-known",
      "package.json must wire arch:check to depcruise with the committed baseline",
    );

    const { status } = depcruise(repoRoot, [
      "src",
      "--config",
      configPath,
      "--ignore-known",
    ]);
    assert.equal(status, 0, "arch:check must exit 0 on the committed tree");
  });

  it("AC2: a synthetic circular import fails the committed config", () => {
    const root = makeFixture({
      "src/parse/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
      "src/parse/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
    });
    try {
      const { status, output } = depcruise(root, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "a cycle must fail arch:check");
      assert.match(output, /no-circular/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Cycle lived only in the temp fixture, never in src/.
    assert.ok(!existsSync(root));
  });

  it("AC3: an upward layer import (src/parse -> src/cli) is an error", () => {
    const root = makeFixture({
      "src/parse/a.ts": 'import { b } from "../cli/b";\nexport const a = b;\n',
      "src/cli/b.ts": "export const b = 1;\n",
    });
    try {
      const { status, output } = depcruise(root, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "an upward parse->cli import must fail");
      assert.match(output, /layer1-parse-format-no-upward/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC4: ci.yml runs npm run arch:check on the unit-test job", () => {
    const ci = readFileSync(
      join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    assert.match(ci, /npm run arch:check/);
  });
});
