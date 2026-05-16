import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadModuleGraph } from "./module-graph";
import { collectDiagnostics } from "./validate";

// Compiled test sits at dist/src/transpile/; the source tree is three levels up.
const repoRoot = resolve(__dirname, "../../..");
const validatePath = resolve(repoRoot, "src/transpile/validate.ts");
const cliJsPath = resolve(repoRoot, "dist/src/cli.js");

/**
 * Acceptance #1: a fixture with N >= 3 independent errors reports the full
 * set in one compile (not just the first), in source order.
 *
 * The three independent errors:
 *  1. duplicate import alias `helper` (line 2 — second import line)
 *  2. send to undefined channel `notify` (line 6 — inside the workflow body)
 *  3. unknown ref `do_thing` in a run call (line 7)
 */
test("Diagnostics: collects 3 independent errors from one compile in source order", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-diag-multi-"));
  try {
    writeFileSync(
      join(root, "helper.jh"),
      ["export rule check(x) {", '  return "ok"', "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "m.jh"),
      [
        'import "./helper.jh" as helper',
        'import "./helper.jh" as helper',
        "",
        "workflow default() {",
        '  log "hi"',
        '  notify <- "payload"',
        "  run do_thing()",
        "}",
        "",
      ].join("\n"),
    );

    const graph = loadModuleGraph(join(root, "m.jh"));
    const diag = collectDiagnostics(graph);
    const sorted = diag.sorted().filter((d) => d.file.endsWith("m.jh"));

    assert.equal(
      sorted.length,
      3,
      `expected 3 diagnostics, got: ${JSON.stringify(diag.sorted(), null, 2)}`,
    );
    assert.equal(sorted[0].line, 2, "duplicate import alias should be on line 2");
    assert.match(sorted[0].message, /duplicate import alias "helper"/);
    assert.equal(sorted[1].line, 6, "undefined channel should be on line 6");
    assert.match(sorted[1].message, /Channel "notify" is not defined/);
    assert.equal(sorted[2].line, 7, "unknown ref should be on line 7");
    assert.match(sorted[2].message, /unknown local workflow or script reference "do_thing"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Acceptance #3: throwing call-sites are reduced to a documented "fatal"
 * subset. The validator entry point (`validate.ts`) no longer throws on
 * user-level errors; it appends to a `Diagnostics` collector instead.
 *
 * Reference baseline (pre-migration): `validate.ts` alone had ~54 raw
 * `throw jaiphError(` call-sites. After migration that file holds zero.
 *
 * The remaining `throw jaiphError(...)` call-sites in `src/` fall into two
 * groups:
 *
 *   - **Fatal aborts** (continuing would produce garbage): the parser's
 *     `fail()` helper (`src/parse/core.ts`), the loader / graph builder
 *     (`src/transpile/module-graph.ts`), the test-file shape check
 *     (`src/cli/commands/test.ts`), plus the legacy bridge inside the
 *     collector itself (`src/diagnostics.ts`).
 *   - **Leaf validation helpers** (validate-string, validate-prompt-schema,
 *     validate-ref-resolution, shell-jaiph-guard): these still throw but
 *     every caller wraps them in `diag.capture(...)`, which converts the
 *     thrown `jaiphError` into a recoverable diagnostic and continues with
 *     the next validation unit.
 *
 * Test files (`*.test.ts`) are excluded from the count — they intentionally
 * exercise the throwing legacy bridge.
 */
test("Diagnostics: throwing call-sites match the documented fatal allowlist", () => {
  const src = readFileSync(validatePath, "utf8");
  const throwCount = (src.match(/throw\s+jaiphError\(/g) ?? []).length;
  assert.equal(
    throwCount,
    0,
    `expected validate.ts to use diag.error exclusively, found ${throwCount} throw jaiphError sites`,
  );

  // Sanity: confirm the migration replaced rather than removed.
  const diagErrorCount = (src.match(/diag\.error\(/g) ?? []).length;
  assert.ok(
    diagErrorCount >= 40,
    `expected many diag.error sites, found ${diagErrorCount}`,
  );

  // The fatal allowlist: files where a `throw jaiphError(...)` is allowed
  // because continuing would produce garbage (parser / loader) or because
  // the throw is wrapped by `diag.capture(...)` at every caller.
  const allowlist = new Set([
    "src/diagnostics.ts",                          // legacy bridge
    "src/parse/core.ts",                           // parser fail()
    "src/cli/commands/test.ts",                    // test-file shape fatal
    "src/transpile/module-graph.ts",               // loader fatal
    "src/transpile/validate-string.ts",            // leaf helper (captured)
    "src/transpile/validate-prompt-schema.ts",     // leaf helper (captured)
    "src/transpile/validate-ref-resolution.ts",    // leaf helper (captured)
    "src/transpile/shell-jaiph-guard.ts",          // leaf helper (captured)
  ]);

  // Walk every .ts file under src/, excluding tests, and confirm any raw
  // `throw jaiphError(` lives in the allowlist. Anything outside the
  // allowlist is a regression — non-fatal validator/transpiler code must
  // route through the collector instead.
  const offenders: string[] = [];
  walkTsFiles(resolve(repoRoot, "src"), (relPath, contents) => {
    if (relPath.endsWith(".test.ts")) return;
    if (!/throw\s+jaiphError\(/.test(contents)) return;
    if (!allowlist.has(relPath)) offenders.push(relPath);
  });
  assert.deepEqual(
    offenders,
    [],
    `unexpected throw jaiphError(...) outside the fatal allowlist: ${offenders.join(", ")}`,
  );
});

function walkTsFiles(
  dir: string,
  cb: (relPath: string, contents: string) => void,
): void {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, cb);
      continue;
    }
    if (!full.endsWith(".ts")) continue;
    const rel = full.slice(repoRoot.length + 1);
    cb(rel, readFileSync(full, "utf8"));
  }
}

interface CompileDiagnosticJson {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/**
 * Acceptance #4: CLI exit code is non-zero whenever the collector is
 * non-empty. `jaiph compile --json` must return the full diagnostic set.
 */
test("CLI: `jaiph compile --json` returns full set + non-zero exit on multiple errors", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-diag-cli-"));
  try {
    writeFileSync(
      join(root, "helper.jh"),
      ["export rule check(x) {", '  return "ok"', "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "m.jh"),
      [
        'import "./helper.jh" as helper',
        'import "./helper.jh" as helper',
        "",
        "workflow default() {",
        '  log "hi"',
        '  notify <- "payload"',
        "  run do_thing()",
        "}",
        "",
      ].join("\n"),
    );

    const out = spawnSync(
      process.execPath,
      [cliJsPath, "compile", "--json", join(root, "m.jh")],
      { encoding: "utf8" },
    );

    assert.notEqual(
      out.status,
      0,
      `expected non-zero exit; stdout=${out.stdout} stderr=${out.stderr}`,
    );
    const parsed = JSON.parse(out.stdout) as CompileDiagnosticJson[];
    const inFile = parsed.filter((d) => d.file.endsWith("m.jh"));
    assert.equal(inFile.length, 3, `expected 3 diagnostics; got ${out.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
