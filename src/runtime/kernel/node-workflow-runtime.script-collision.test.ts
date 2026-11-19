// Per-module script emission (see moduleScriptFileName in inline-script-name.ts
// and emit-script.ts). Two modules that both declare `script <name>` emit to
// distinct files, so a call always runs the body of the module it resolves to
// and that definition's own `use` env — a same-named entry script can never be
// silently replaced by an imported one, and neither can borrow the other's
// env grants. These drive the REAL emit → runtime pipeline (buildScriptsFromGraph
// writes the files, the runtime resolves them) so the two sides must agree.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScriptsFromGraph, loadModuleGraph } from "../../transpiler";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

function writeFile(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("same-named module scripts: each call runs its own body; the failing one fails the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-collision-"));
  try {
    // The imported module's `check` succeeds and records that it ran; the entry
    // module's own `check` is a failing gate that also records that it ran.
    writeFile(root, "zlib.jh", [
      "export script check = 'printf LIB > \"$JAIPH_WORKSPACE/lib_ran.txt\"'",
      "export def lib_check() {",
      "  check()",
      "}",
    ]);
    const entry = writeFile(root, "entry.jh", [
      'import "zlib.jh" as zlib',
      "script check = '''",
      'printf ENTRY > "$JAIPH_WORKSPACE/entry_ran.txt"',
      "exit 1",
      "'''",
      "export def main() {",
      "  zlib.lib_check()",
      "  check()",
      "}",
    ]);

    const graph = loadModuleGraph(entry);
    const { scriptsDir } = buildScriptsFromGraph(graph, root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(graph), { env, cwd: root, suppressLiveEvents: true });

    const status = await runtime.runMain([]);
    assert.notEqual(status, 0, "the entry module's failing `check` must fail the run");
    // Each call ran its own module's body, not whichever sorted last at emit.
    assert.equal(readFileSync(join(root, "lib_ran.txt"), "utf8"), "LIB", "lib.check() ran the imported body");
    assert.equal(readFileSync(join(root, "entry_ran.txt"), "utf8"), "ENTRY", "entry check() ran the entry body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-named module scripts with different `use`: each body sees only its own granted variable", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-collision-use-"));
  try {
    // Both modules declare `script show`, each with a different `use` key, each
    // echoing BOTH keys so a cross-leak would show up.
    writeFile(root, "zlib.jh", [
      "export script show use LIB_TOKEN = 'printf \"L=[${LIB_TOKEN:-unset}|${ENTRY_TOKEN:-unset}]\" > \"$JAIPH_WORKSPACE/lib_show.txt\"'",
      "export def lib_show() {",
      "  show()",
      "}",
    ]);
    const entry = writeFile(root, "entry.jh", [
      'import "zlib.jh" as zlib',
      "script show use ENTRY_TOKEN = 'printf \"E=[${ENTRY_TOKEN:-unset}|${LIB_TOKEN:-unset}]\" > \"$JAIPH_WORKSPACE/entry_show.txt\"'",
      "export def main() {",
      "  zlib.lib_show()",
      "  show()",
      "}",
    ]);

    const graph = loadModuleGraph(entry);
    const { scriptsDir } = buildScriptsFromGraph(graph, root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
      JAIPH_ENV_GRANT: "ENTRY_TOKEN,LIB_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(graph), {
      env,
      cwd: root,
      suppressLiveEvents: true,
      grantValues: { ENTRY_TOKEN: "entryval", LIB_TOKEN: "libval" },
    });

    const status = await runtime.runMain([]);
    assert.equal(status, 0, "both scripts succeed");
    // The `use` env comes from the definition that actually runs: lib's `show`
    // sees LIB_TOKEN only, entry's `show` sees ENTRY_TOKEN only.
    assert.equal(readFileSync(join(root, "lib_show.txt"), "utf8"), "L=[libval|unset]", "lib body sees only LIB_TOKEN");
    assert.equal(
      readFileSync(join(root, "entry_show.txt"), "utf8"),
      "E=[entryval|unset]",
      "entry body sees only ENTRY_TOKEN",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
