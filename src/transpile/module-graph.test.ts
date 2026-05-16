import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScriptsFromGraph } from "../transpiler";
import { buildRuntimeGraph, resolveScriptRef, resolveWorkflowRef } from "../runtime/kernel/graph";
import {
  loadModuleGraph,
  serializeModuleGraph,
  deserializeModuleGraph,
} from "./module-graph";

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
}

/**
 * Acceptance criterion 4 from the parser-simplification design: each `.jh`
 * source file in a compile is parsed exactly once. After `loadModuleGraph`
 * walks the entry plus its transitive imports, neither `buildScripts` nor
 * `buildRuntimeGraph` may re-read a `.jh` source — verified by corrupting
 * every file post-load and asserting the pipeline still succeeds.
 */
test("module-graph: buildScripts + buildRuntimeGraph reuse pre-parsed ASTs and never re-read .jh after load", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-noreparse-"));
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

    const graph = loadModuleGraph(main);
    assert.equal(graph.modules.size, 2);
    assert.ok(graph.modules.has(main));
    assert.ok(graph.modules.has(lib));

    // Corrupt source contents. Files still exist (so existsSync passes), but
    // any new parse call would throw a parse error.
    write(main, "!!! invalid jaiph syntax !!!\n");
    write(lib, "!!! invalid jaiph syntax !!!\n");

    const outDir = mkdtempSync(join(tmpdir(), "jaiph-graph-out-"));
    try {
      const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
      const emitted = readdirSync(scriptsDir).sort();
      assert.deepEqual(emitted, ["helper", "local_script"]);

      const runtime = buildRuntimeGraph(graph);
      assert.equal(runtime.modules.size, 2);
      const inner = resolveWorkflowRef(runtime, main, {
        value: "lib.inner",
        loc: { line: 1, col: 1 },
      });
      assert.equal(inner?.workflow.name, "inner");
      const helper = resolveScriptRef(runtime, main, "lib.helper");
      assert.equal(helper?.script.name, "helper");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Cross-module workflow, rule, and script resolution survives the graph
 * pipeline.
 */
test("module-graph: cross-module workflow, rule, and script resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-crossmod-"));
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

    const graph = loadModuleGraph(main);
    const outDir = mkdtempSync(join(tmpdir(), "jaiph-graph-out2-"));
    try {
      const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
      const emitted = readdirSync(scriptsDir).sort();
      assert.deepEqual(emitted, ["helper", "local_script"]);

      const runtime = buildRuntimeGraph(graph);
      const localWf = resolveWorkflowRef(runtime, main, {
        value: "default",
        loc: { line: 1, col: 1 },
      });
      assert.equal(localWf?.workflow.name, "default");
      const importedWf = resolveWorkflowRef(runtime, main, {
        value: "lib.inner",
        loc: { line: 1, col: 1 },
      });
      assert.equal(importedWf?.workflow.name, "inner");
      const localScript = resolveScriptRef(runtime, main, "local_script");
      assert.equal(localScript?.script.name, "local_script");
      const importedScript = resolveScriptRef(runtime, main, "lib.helper");
      assert.equal(importedScript?.script.name, "helper");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Cross-process boundary: the parent serializes the graph, the child
 * deserializes it and reuses every AST. Asserts the JSON format is
 * round-trippable so the runner can rebuild the graph without re-parsing.
 */
test("module-graph: serialize round-trip preserves the import closure for the child runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-roundtrip-"));
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

    const graph = loadModuleGraph(main);
    const serialized = serializeModuleGraph(graph);
    // Corrupt source contents so any deserialized-path consumer that tries to
    // re-parse would fail loudly. Files still exist so existsSync passes.
    write(main, "!!! invalid !!!\n");
    write(lib, "!!! invalid !!!\n");
    const round = deserializeModuleGraph(serialized);
    assert.equal(round.modules.size, 2);
    const runtime = buildRuntimeGraph(round);
    const importedWf = resolveWorkflowRef(runtime, main, {
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
test("module-graph: handles a 3-module closure with one shared parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-three-"));
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

    const graph = loadModuleGraph(main);
    assert.equal(graph.modules.size, 3);

    // Corrupt every source: any downstream re-parse would now fail.
    write(main, "!!! invalid !!!\n");
    write(libA, "!!! invalid !!!\n");
    write(libB, "!!! invalid !!!\n");

    const outDir = mkdtempSync(join(tmpdir(), "jaiph-graph-three-out-"));
    try {
      buildScriptsFromGraph(graph, outDir);
      const runtime = buildRuntimeGraph(graph);
      const bRef = resolveWorkflowRef(runtime, main, { value: "b.b", loc: { line: 1, col: 1 } });
      assert.equal(bRef?.workflow.name, "b");
      const bNode = runtime.modules.get(libB)!;
      assert.equal(bNode.imports.get("a"), libA);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
