import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

  it("AC5: a deep import into parse from outside the package is an error; the public entry passes", () => {
    // Failing case: an outsider (transpile) reaches into a parse internal.
    const bad = makeFixture({
      "src/transpile/x.ts":
        'import { y } from "../parse/internal";\nexport const x = y;\n',
      "src/parse/internal.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(bad, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "a deep import into parse must fail");
      assert.match(output, /no-deep-imports-into-parse/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }

    // Passing case: the same outsider goes through the public entry instead.
    const good = makeFixture({
      "src/transpile/x.ts":
        'import { y } from "../parser";\nexport const x = y;\n',
      "src/parser.ts": 'export { y } from "./parse/internal";\n',
      "src/parse/internal.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(good, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.equal(
        status,
        0,
        "importing only the parse public entry must pass",
      );
      assert.doesNotMatch(output, /no-deep-imports-into-parse/);
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("AC6: no production file outside the parse package deep-imports src/parse/** except the committed baseline", () => {
    // Baseline is authoritative for the deep imports we knowingly tolerate.
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
      rule: { name: string };
      from: string;
    }>;
    const baselined = new Set(
      baseline
        .filter((v) => v.rule.name === "no-deep-imports-into-parse")
        .map((v) => v.from),
    );

    const srcDir = join(repoRoot, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else if (abs.endsWith(".ts")) {
          files.push(abs);
        }
      }
    };
    walk(srcDir);

    const deepImport = /from\s+["'](?:\.\.?\/)+parse\/[^"']+["']/;
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = abs.slice(repoRoot.length + 1);
      // Scope: production files OUTSIDE the parse package (parser.ts is the entry).
      if (rel.startsWith("src/parse/")) continue;
      if (rel === "src/parser.ts") continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".acceptance.test.ts")) {
        continue;
      }
      if (deepImport.test(readFileSync(abs, "utf8")) && !baselined.has(rel)) {
        offenders.push(rel);
      }
    }

    // Report the tolerated count so a growing baseline is visible in test output.
    console.log(
      `parse deep-import baseline: ${baselined.size} tolerated (${[...baselined].join(", ")})`,
    );
    assert.deepEqual(
      offenders,
      [],
      `these production files deep-import parse but are not baselined: ${offenders.join(", ")}`,
    );
  });

  it("AC7: the parse public entry (src/parser.ts) uses no `export *` barrel", () => {
    const entry = readFileSync(join(repoRoot, "src/parser.ts"), "utf8");
    assert.doesNotMatch(
      entry,
      /export\s+\*\s+from/,
      "src/parser.ts must re-export a curated API, never `export * from` a private file",
    );
  });

  it("AC8: docs/agent-analyzability.md parse row names src/parser.ts as the public entry", () => {
    const doc = readFileSync(
      join(repoRoot, "docs/agent-analyzability.md"),
      "utf8",
    );
    const parseRow = doc
      .split("\n")
      .find((l) => /^\|\s*Parse\s*\|/.test(l));
    assert.ok(parseRow, "the deep-modules table must have a Parse row");
    assert.match(
      parseRow as string,
      /`src\/parser\.ts`/,
      "the Parse row must name src/parser.ts as the public entry",
    );
  });

  it("AC9: a deep import into transpile from outside the package is an error; the public entry and the module-graph API pass", () => {
    // Failing case: an outsider (cli) reaches into a transpile validator internal.
    const bad = makeFixture({
      "src/cli/x.ts":
        'import { y } from "../transpile/validate-internal";\nexport const x = y;\n',
      "src/transpile/validate-internal.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(bad, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "a deep import into transpile must fail");
      assert.match(output, /no-deep-imports-into-transpile/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }

    // Passing case: the same outsider goes through the public entry instead.
    const good = makeFixture({
      "src/cli/x.ts":
        'import { y } from "../transpiler";\nexport const x = y;\n',
      "src/transpiler.ts": 'export { y } from "./transpile/validate-internal";\n',
      "src/transpile/validate-internal.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(good, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.equal(
        status,
        0,
        "importing only the transpile public entry must pass",
      );
      assert.doesNotMatch(output, /no-deep-imports-into-transpile/);
    } finally {
      rmSync(good, { recursive: true, force: true });
    }

    // Allowlisted case: the public module-graph API stays importable from outside
    // (runtime reuses it), so the rule must not flag src/transpile/module-graph.ts.
    const graph = makeFixture({
      "src/runtime/x.ts":
        'import { y } from "../transpile/module-graph";\nexport const x = y;\n',
      "src/transpile/module-graph.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(graph, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.equal(
        status,
        0,
        "importing the public module-graph API must pass",
      );
      assert.doesNotMatch(output, /no-deep-imports-into-transpile/);
    } finally {
      rmSync(graph, { recursive: true, force: true });
    }
  });

  it("AC10: no production file outside the transpile package deep-imports src/transpile/** (except module-graph.ts and the committed baseline)", () => {
    // Baseline is authoritative for the deep imports we knowingly tolerate.
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
      rule: { name: string };
      from: string;
    }>;
    const baselined = new Set(
      baseline
        .filter((v) => v.rule.name === "no-deep-imports-into-transpile")
        .map((v) => v.from),
    );

    const srcDir = join(repoRoot, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else if (abs.endsWith(".ts")) {
          files.push(abs);
        }
      }
    };
    walk(srcDir);

    // Deep import into transpile that is NOT the public module-graph entry.
    const deepImport =
      /from\s+["'](?:\.\.?\/)+transpile\/(?!module-graph["'])[^"']+["']/;
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = abs.slice(repoRoot.length + 1);
      // Scope: production files OUTSIDE transpile (transpiler.ts is the entry).
      if (rel.startsWith("src/transpile/")) continue;
      if (rel === "src/transpiler.ts") continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".acceptance.test.ts")) {
        continue;
      }
      if (deepImport.test(readFileSync(abs, "utf8")) && !baselined.has(rel)) {
        offenders.push(rel);
      }
    }

    // Report the tolerated count so a growing baseline is visible in test output.
    console.log(
      `transpile deep-import baseline: ${baselined.size} tolerated (${[...baselined].join(", ")})`,
    );
    assert.deepEqual(
      offenders,
      [],
      `these production files deep-import transpile but are not baselined: ${offenders.join(", ")}`,
    );
  });

  it("AC11: the transpile public entry (src/transpiler.ts) uses no `export *` barrel", () => {
    const entry = readFileSync(join(repoRoot, "src/transpiler.ts"), "utf8");
    assert.doesNotMatch(
      entry,
      /export\s+\*\s+from/,
      "src/transpiler.ts must re-export a curated API, never `export * from` a private file",
    );
  });

  it("AC12: docs/agent-analyzability.md transpile row names src/transpiler.ts as the public entry", () => {
    const doc = readFileSync(
      join(repoRoot, "docs/agent-analyzability.md"),
      "utf8",
    );
    const transpileRow = doc
      .split("\n")
      .find((l) => /^\|\s*Transpile\s*\|/.test(l));
    assert.ok(transpileRow, "the deep-modules table must have a Transpile row");
    assert.match(
      transpileRow as string,
      /`src\/transpiler\.ts`/,
      "the Transpile row must name src/transpiler.ts as the public entry",
    );
  });

  it("AC13: a runtime->cli import is an error; runtime importing a lower layer passes", () => {
    // Failing case: a runtime file reaches up into a CLI module (layer inversion).
    const bad = makeFixture({
      "src/runtime/x.ts":
        'import { y } from "../cli/commands/format-params";\nexport const x = y;\n',
      "src/cli/commands/format-params.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(bad, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "a runtime->cli import must fail");
      assert.match(output, /layer3-runtime-no-cli/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }

    // Passing case: runtime importing a shared leaf (layer 0) is downward, allowed.
    const good = makeFixture({
      "src/runtime/x.ts": 'import { y } from "../types";\nexport const x = y;\n',
      "src/types.ts": "export const y = 1;\n",
    });
    try {
      const { status } = depcruise(good, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.equal(status, 0, "runtime importing layer 0 must pass");
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("AC14: no production file under src/runtime/ imports a path under src/cli/", () => {
    const srcDir = join(repoRoot, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else if (abs.endsWith(".ts")) {
          files.push(abs);
        }
      }
    };
    walk(join(srcDir, "runtime"));

    // Any import that resolves under src/cli/ from a runtime production file is
    // a layer inversion (runtime is layer 3, cli is layer 4). Tests are out of
    // scope: cross-layer integration tests are tracked by the depcruiser baseline.
    const cliImport = /from\s+["'](?:\.\.\/)+cli\/[^"']+["']/;
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = abs.slice(repoRoot.length + 1);
      if (rel.endsWith(".test.ts") || rel.endsWith(".acceptance.test.ts")) {
        continue;
      }
      if (cliImport.test(readFileSync(abs, "utf8"))) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `these runtime production files import src/cli/**: ${offenders.join(", ")}`,
    );
  });

  it("AC15: a deep import into runtime from outside the package is an error; the public entry passes", () => {
    // Failing case: an outsider (cli) reaches into a runtime kernel internal.
    const bad = makeFixture({
      "src/cli/x.ts":
        'import { y } from "../runtime/kernel/emit";\nexport const x = y;\n',
      "src/runtime/kernel/emit.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(bad, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.notEqual(status, 0, "a deep import into runtime must fail");
      assert.match(output, /no-deep-imports-into-runtime/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }

    // Passing case: the same outsider goes through the public entry instead.
    const good = makeFixture({
      "src/cli/x.ts": 'import { y } from "../runtime";\nexport const x = y;\n',
      "src/runtime/index.ts": 'export { y } from "./kernel/emit";\n',
      "src/runtime/kernel/emit.ts": "export const y = 1;\n",
    });
    try {
      const { status, output } = depcruise(good, [
        "src",
        "--config",
        configPath,
        "--output-type",
        "err",
      ]);
      assert.equal(status, 0, "importing only the runtime public entry must pass");
      assert.doesNotMatch(output, /no-deep-imports-into-runtime/);
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("AC16: no production file outside the runtime package deep-imports src/runtime/** except the committed baseline", () => {
    // Baseline is authoritative for the deep imports we knowingly tolerate.
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
      rule: { name: string };
      from: string;
    }>;
    const baselined = new Set(
      baseline
        .filter((v) => v.rule.name === "no-deep-imports-into-runtime")
        .map((v) => v.from),
    );

    const srcDir = join(repoRoot, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else if (abs.endsWith(".ts")) {
          files.push(abs);
        }
      }
    };
    walk(srcDir);

    // Deep import into runtime: a `runtime/<path>` target. The public entry is
    // imported as `../runtime` (no trailing slash), so it never matches here.
    const deepImport = /from\s+["'](?:\.\.?\/)+runtime\/[^"']+["']/;
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = abs.slice(repoRoot.length + 1);
      // Scope: production files OUTSIDE runtime (index.ts is the entry).
      if (rel.startsWith("src/runtime/")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".acceptance.test.ts")) {
        continue;
      }
      if (deepImport.test(readFileSync(abs, "utf8")) && !baselined.has(rel)) {
        offenders.push(rel);
      }
    }

    // Report the tolerated count so a growing baseline is visible in test output.
    console.log(
      `runtime deep-import baseline: ${baselined.size} tolerated (${[...baselined].join(", ")})`,
    );
    assert.deepEqual(
      offenders,
      [],
      `these production files deep-import runtime but are not baselined: ${offenders.join(", ")}`,
    );
  });

  it("AC17: no runtime->cli edge is merely baselined (the inversion is fixed, not tracked)", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
      rule: { name: string };
      from: string;
      to: string;
    }>;
    const runtimeToCli = baseline.filter(
      (v) => v.rule.name === "layer3-runtime-no-cli",
    );
    assert.deepEqual(
      runtimeToCli,
      [],
      `runtime->cli edges must be fixed, not baselined: ${runtimeToCli
        .map((v) => `${v.from} -> ${v.to}`)
        .join(", ")}`,
    );
  });

  it("AC18: the runtime public entry (src/runtime/index.ts) uses no `export *` barrel", () => {
    const entry = readFileSync(join(repoRoot, "src/runtime/index.ts"), "utf8");
    assert.doesNotMatch(
      entry,
      /export\s+\*\s+from/,
      "src/runtime/index.ts must re-export a curated API, never `export * from` a private file",
    );
  });

  it("AC19: docs/agent-analyzability.md runtime row names src/runtime/index.ts as the public entry", () => {
    const doc = readFileSync(
      join(repoRoot, "docs/agent-analyzability.md"),
      "utf8",
    );
    const runtimeRow = doc
      .split("\n")
      .find((l) => /^\|\s*Runtime\s*\|/.test(l));
    assert.ok(runtimeRow, "the deep-modules table must have a Runtime row");
    assert.match(
      runtimeRow as string,
      /`src\/runtime\/index\.ts`/,
      "the Runtime row must name src/runtime/index.ts as the public entry",
    );
  });
});
