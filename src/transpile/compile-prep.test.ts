import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScripts } from "../transpiler";
import { buildRuntimeGraph, resolveScriptRef, resolveWorkflowRef } from "../runtime/kernel/graph";
import {
  prepareCompile,
  serializeCompilePrep,
  deserializeCompilePrep,
} from "./compile-prep";

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
}

/**
 * Acceptance criterion 1: the default local run path must not parse the entry
 * module in the parent and then re-parse the same module in the child to build
 * the runtime graph.
 *
 * Strategy: after `prepareCompile` parses every reachable `.jh`, we corrupt
 * each file's contents to junk that the parser would reject. If `buildScripts`
 * (parent) or `buildRuntimeGraph` (child) re-reads/re-parses any module, the
 * call throws and the test fails. The old `run.ts` + `buildScripts()` +
 * `node-workflow-runner.ts` duplicate-parse pattern is exactly what would
 * fail here.
 */
test("compile-prep: buildScripts + buildRuntimeGraph reuse pre-parsed ASTs and never re-read .jh after prepare", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-prep-noreparse-"));
  try {
    const main = join(dir, "main.jh");
    const lib = join(dir, "lib.jh");
    write(
      lib,
      [
        "rule check() {",
        '  log "ok"',
        "}",
        "script helper = `echo hi`",
        "workflow inner() {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );
    write(
      main,
      [
        'import "./lib.jh" as lib',
        "script local_script = `echo local`",
        "workflow default() {",
        "  run lib.inner()",
        "}",
        "",
      ].join("\n"),
    );

    const prep = prepareCompile(main);
    assert.equal(prep.astByFile.size, 2);
    assert.ok(prep.astByFile.has(main));
    assert.ok(prep.astByFile.has(lib));

    // Corrupt source contents. Files still exist (so existsSync passes), but
    // any new parse call would throw a parse error.
    write(main, "!!! invalid jaiph syntax !!!\n");
    write(lib, "!!! invalid jaiph syntax !!!\n");

    const outDir = mkdtempSync(join(tmpdir(), "jaiph-prep-out-"));
    try {
      const { scriptsDir } = buildScripts(main, outDir, undefined, prep);
      const emitted = readdirSync(scriptsDir).sort();
      assert.deepEqual(emitted, ["helper", "local_script"]);

      const graph = buildRuntimeGraph(main, undefined, prep);
      assert.equal(graph.modules.size, 2);
      const inner = resolveWorkflowRef(graph, main, {
        value: "lib.inner",
        loc: { line: 1, col: 1 },
      });
      assert.equal(inner?.workflow.name, "inner");
      const helper = resolveScriptRef(graph, main, "lib.helper");
      assert.equal(helper?.script.name, "helper");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Acceptance criterion 2: the optimized graph/compile-prep path preserves
 * cross-module workflow, rule, and script resolution.
 */
test("compile-prep: cross-module workflow, rule, and script resolution survives the optimized path", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-prep-crossmod-"));
  try {
    const main = join(dir, "main.jh");
    const lib = join(dir, "lib.jh");
    write(
      lib,
      [
        "rule check() {",
        '  log "ok"',
        "}",
        "script helper = `echo hi`",
        "workflow inner() {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );
    write(
      main,
      [
        'import "./lib.jh" as lib',
        "rule local_check() {",
        '  log "local"',
        "}",
        "script local_script = `echo local`",
        "workflow default() {",
        "  run lib.inner()",
        "}",
        "",
      ].join("\n"),
    );

    const prep = prepareCompile(main);
    const outDir = mkdtempSync(join(tmpdir(), "jaiph-prep-out2-"));
    try {
      const { scriptsDir } = buildScripts(main, outDir, undefined, prep);
      const emitted = readdirSync(scriptsDir).sort();
      assert.deepEqual(emitted, ["helper", "local_script"]);

      const graph = buildRuntimeGraph(main, undefined, prep);
      const localWf = resolveWorkflowRef(graph, main, {
        value: "default",
        loc: { line: 1, col: 1 },
      });
      assert.equal(localWf?.workflow.name, "default");
      const importedWf = resolveWorkflowRef(graph, main, {
        value: "lib.inner",
        loc: { line: 1, col: 1 },
      });
      assert.equal(importedWf?.workflow.name, "inner");
      const localScript = resolveScriptRef(graph, main, "local_script");
      assert.equal(localScript?.script.name, "local_script");
      const importedScript = resolveScriptRef(graph, main, "lib.helper");
      assert.equal(importedScript?.script.name, "helper");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Cross-process boundary: the parent serializes the prep, the child
 * deserializes it and reuses every AST. Asserts the JSON format is
 * round-trippable so the worker can rebuild the graph without re-parsing.
 */
test("compile-prep: serialize round-trip preserves the import closure for the child runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-prep-roundtrip-"));
  try {
    const main = join(dir, "main.jh");
    const lib = join(dir, "lib.jh");
    write(
      lib,
      [
        "workflow inner() {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );
    write(
      main,
      [
        'import "./lib.jh" as lib',
        "workflow default() {",
        "  run lib.inner()",
        "}",
        "",
      ].join("\n"),
    );

    const prep = prepareCompile(main);
    const serialized = serializeCompilePrep(prep);
    // Corrupt source contents so any deserialized-path consumer that tries to
    // re-parse would fail loudly. Files still exist so existsSync passes.
    write(main, "!!! invalid !!!\n");
    write(lib, "!!! invalid !!!\n");
    const round = deserializeCompilePrep(serialized);
    assert.equal(round.astByFile.size, 2);
    const graph = buildRuntimeGraph(main, undefined, round);
    const importedWf = resolveWorkflowRef(graph, main, {
      value: "lib.inner",
      loc: { line: 1, col: 1 },
    });
    assert.equal(importedWf?.workflow.name, "inner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Three-module closure: prove the optimization scales beyond the direct
 * import case in the acceptance criteria.
 */
test("compile-prep: handles a 3-module closure with one shared parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-prep-three-"));
  try {
    const main = join(dir, "main.jh");
    const libA = join(dir, "a.jh");
    const libB = join(dir, "b.jh");
    write(libA, "workflow a() {\n  echo ok\n}\n");
    write(
      libB,
      [
        'import "./a.jh" as a',
        "workflow b() {",
        "  run a.a()",
        "}",
        "",
      ].join("\n"),
    );
    write(
      main,
      [
        'import "./b.jh" as b',
        "workflow default() {",
        "  run b.b()",
        "}",
        "",
      ].join("\n"),
    );

    const prep = prepareCompile(main);
    assert.equal(prep.astByFile.size, 3);

    // Corrupt every source: any downstream re-parse would now fail.
    write(main, "!!! invalid !!!\n");
    write(libA, "!!! invalid !!!\n");
    write(libB, "!!! invalid !!!\n");

    const outDir = mkdtempSync(join(tmpdir(), "jaiph-prep-three-out-"));
    try {
      buildScripts(main, outDir, undefined, prep);
      const graph = buildRuntimeGraph(main, undefined, prep);
      const bRef = resolveWorkflowRef(graph, main, { value: "b.b", loc: { line: 1, col: 1 } });
      assert.equal(bRef?.workflow.name, "b");
      // Resolve transitively into a.jh via b's imports.
      const bNode = graph.modules.get(libB)!;
      assert.equal(bNode.imports.get("a"), libA);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
