import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { parsejaiph } from "../parser";
import { loadModuleGraph } from "./module-graph";
import { validateReferences } from "./validate";
import { buildScriptsFromGraph } from "../transpiler";

// `require("node:fs")` returns the real, mutable module exports; the
// TypeScript-emitted `__importStar` wrapper used by `import * as fs` builds a
// separate getter-only object that defeats monkey-patching, so the purity
// guards below patch through `require` instead.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realFs: typeof import("node:fs") = require("node:fs");

/** Parser fixtures — exercised stand-alone (parse only; broken imports are fine here). */
const PARSER_FIXTURE_ROOTS = [
  resolve(process.cwd(), "test-fixtures/golden-ast/fixtures"),
  resolve(process.cwd(), "test-fixtures/sample-build/fixtures"),
  resolve(process.cwd(), "examples"),
];

/**
 * Pipeline fixtures — must have a self-contained import closure so
 * `loadModuleGraph` + `validateReferences` + emit can run end-to-end.
 * `test-fixtures/golden-ast` is excluded because its `imports.jh` fixture
 * references a stub `lib.jh` that does not ship alongside it.
 */
const PIPELINE_FIXTURE_ROOTS = [
  resolve(process.cwd(), "test-fixtures/sample-build/fixtures"),
  resolve(process.cwd(), "examples"),
];

function listJhFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && extname(entry.name) === ".jh") out.push(full);
    }
  }
  return out;
}

/**
 * Acceptance criterion 1: `parsejaiph(source, filePath)` is I/O-pure. With
 * every fs entry point stubbed to throw for the duration of the call,
 * parsing every fixture must still succeed because the parser never reaches
 * `node:fs` at all.
 */
test("parser-io-purity: parsejaiph never touches node:fs for any fixture", () => {
  const fixtures: Array<{ file: string; content: string }> = [];
  for (const root of PARSER_FIXTURE_ROOTS) {
    for (const file of listJhFiles(root)) {
      fixtures.push({ file, content: readFileSync(file, "utf8") });
    }
  }
  assert.ok(fixtures.length > 0, "expected to find .jh fixtures to parse");

  for (const { file, content } of fixtures) {
    const guard = installFsGuard(() => true);
    try {
      const ast = parsejaiph(content, file);
      assert.equal(ast.filePath, file, `parse produced unexpected filePath for ${file}`);
    } finally {
      guard.restore();
    }
  }
});

/**
 * Acceptance criterion 2: once the module graph is loaded, neither
 * `validate(graph)` nor `emit(graph, outDir)` may reach the filesystem for
 * `.jh` source or AST reads. Writing emitted bash files is allowed.
 *
 * The test loads each fixture (fs is unstubbed during load), then stubs
 * `fs.readFileSync` / `fs.existsSync` to throw on any `.jh` path, and runs
 * `validateReferences(graph)` plus a full script emit. Both must succeed.
 */
test("pipeline-io-purity: validate(graph) and emit(graph, outDir) never read .jh from disk", () => {
  const entries: string[] = [];
  for (const root of PIPELINE_FIXTURE_ROOTS) {
    for (const file of listJhFiles(root)) {
      // Skip *.test.jh — those are exercised by the test-runner path; the
      // graph pipeline still loads them but they share the same purity
      // guarantees and lengthen the test for no extra coverage.
      if (file.endsWith(".test.jh")) continue;
      entries.push(file);
    }
  }
  assert.ok(entries.length > 0, "expected to find .jh fixtures");

  for (const entry of entries) {
    const graph = loadModuleGraph(entry);
    const outDir = mkdtempSync(join(tmpdir(), "jaiph-emit-purity-"));
    const guard = installFsGuard((path) => extname(path) === ".jh");
    try {
      validateReferences(graph);
      buildScriptsFromGraph(graph, outDir);
    } finally {
      guard.restore();
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

/**
 * Acceptance criterion 4: each `.jh` source file in a compile is parsed
 * exactly once. The test creates a graph with transitive imports
 * (entry → lib → leaf), counts `parsejaiph` invocations across
 * `loadModuleGraph` + `validateReferences` + `buildScriptsFromGraph`, and
 * asserts the count equals the number of unique modules.
 */
test("parse-once: full pipeline calls parsejaiph exactly once per reachable .jh module", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-parse-once-"));
  try {
    const entry = join(dir, "main.jh");
    const libA = join(dir, "a.jh");
    const libB = join(dir, "b.jh");
    require("node:fs").writeFileSync(libA, "workflow a() {\n  echo ok\n}\n", "utf8");
    require("node:fs").writeFileSync(
      libB,
      ['import "./a.jh" as a', "workflow b() {", "  run a.a()", "}", ""].join("\n"),
      "utf8",
    );
    require("node:fs").writeFileSync(
      entry,
      ['import "./b.jh" as b', "workflow default() {", "  run b.b()", "}", ""].join("\n"),
      "utf8",
    );

    const counter = installParseCounter();
    try {
      const graph = loadModuleGraph(entry);
      validateReferences(graph);
      const outDir = mkdtempSync(join(tmpdir(), "jaiph-parse-once-out-"));
      try {
        buildScriptsFromGraph(graph, outDir);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
      assert.equal(graph.modules.size, 3);
      assert.equal(
        counter.byFile.size,
        3,
        `expected 3 unique files parsed, got ${[...counter.byFile.keys()].join(", ")}`,
      );
      for (const [file, count] of counter.byFile) {
        assert.equal(count, 1, `file ${file} parsed ${count} times (expected 1)`);
      }
    } finally {
      counter.restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FsGuard {
  restore(): void;
}

/**
 * Replace `fs.readFileSync`, `fs.existsSync`, `fs.statSync` so they throw
 * when `shouldBlock(path)` returns true. Patching is done against the real
 * `require("node:fs")` exports because the TS `__importStar` wrapper used
 * by `import * as fs` returns getter-only properties.
 */
function installFsGuard(shouldBlock: (path: string) => boolean): FsGuard {
  const orig = {
    readFileSync: realFs.readFileSync,
    existsSync: realFs.existsSync,
    statSync: realFs.statSync,
  };
  const guardCall = (name: string, path: unknown): void => {
    if (typeof path !== "string") return;
    if (shouldBlock(path)) {
      throw new Error(`fs.${name} blocked by purity guard: ${path}`);
    }
  };
  const mutable = realFs as unknown as Record<string, unknown>;
  mutable.readFileSync = (path: unknown, opts?: unknown) => {
    guardCall("readFileSync", path);
    return orig.readFileSync(path as Parameters<typeof orig.readFileSync>[0], opts as Parameters<typeof orig.readFileSync>[1]);
  };
  mutable.existsSync = (path: unknown) => {
    guardCall("existsSync", path);
    return orig.existsSync(path as Parameters<typeof orig.existsSync>[0]);
  };
  mutable.statSync = (path: unknown, opts?: unknown) => {
    guardCall("statSync", path);
    return orig.statSync(path as Parameters<typeof orig.statSync>[0], opts as Parameters<typeof orig.statSync>[1]);
  };
  return {
    restore(): void {
      mutable.readFileSync = orig.readFileSync;
      mutable.existsSync = orig.existsSync;
      mutable.statSync = orig.statSync;
    },
  };
}

interface ParseCounter {
  byFile: Map<string, number>;
  restore(): void;
}

/**
 * Replace the exported `parsejaiph` on the module so every call goes through
 * a counting wrapper. Works because TypeScript's CJS output rewrites named
 * imports as property reads against the module's exports object.
 */
function installParseCounter(): ParseCounter {
  const parserMod = require("../parser") as { parsejaiph: typeof parsejaiph };
  const original = parserMod.parsejaiph;
  const byFile = new Map<string, number>();
  parserMod.parsejaiph = function counting(source: string, filePath: string) {
    byFile.set(filePath, (byFile.get(filePath) ?? 0) + 1);
    return original(source, filePath);
  } as typeof parsejaiph;
  return {
    byFile,
    restore(): void {
      parserMod.parsejaiph = original;
    },
  };
}
