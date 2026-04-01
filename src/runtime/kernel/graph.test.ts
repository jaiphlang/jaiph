import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeGraph, lookupRule, lookupScript, lookupWorkflow } from "./graph";

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
}

test("buildRuntimeGraph loads entry module and imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-"));
  try {
    const main = join(dir, "main.jh");
    const lib = join(dir, "lib.jh");
    write(
      lib,
      `rule check {
  echo ok
}
script helper = "echo hi"
workflow inner {
  echo ok
}`,
    );
    write(
      main,
      `import "./lib.jh" as lib
workflow default {
  run lib.inner()
}`,
    );
    const g = buildRuntimeGraph(main);
    assert.equal(g.modules.size, 2);
    assert.ok(g.modules.has(main));
    assert.ok(g.modules.has(lib));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lookup helpers resolve local and imported symbols", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-lookup-"));
  try {
    const main = join(dir, "main.jh");
    const lib = join(dir, "lib.jh");
    write(
      lib,
      `rule check {
  echo ok
}
script helper = "echo hi"
workflow inner {
  echo ok
}`,
    );
    write(
      main,
      `import "./lib.jh" as lib
rule local_check {
  echo local
}
script local_script = "echo local"
workflow default {
  run lib.inner()
}`,
    );
    const g = buildRuntimeGraph(main);
    const localWf = lookupWorkflow(g, main, { value: "default", loc: { line: 1, col: 1 } });
    assert.equal(localWf?.name, "default");
    const importedWf = lookupWorkflow(g, main, { value: "lib.inner", loc: { line: 1, col: 1 } });
    assert.equal(importedWf?.name, "inner");
    const localRule = lookupRule(g, main, { value: "local_check", loc: { line: 1, col: 1 } });
    assert.equal(localRule?.name, "local_check");
    const importedRule = lookupRule(g, main, { value: "lib.check", loc: { line: 1, col: 1 } });
    assert.equal(importedRule?.name, "check");
    assert.equal(lookupScript(g, main, "local_script")?.name, "local_script");
    assert.equal(lookupScript(g, main, "lib.helper")?.name, "helper");
    assert.equal(lookupWorkflow(g, main, { value: "lib.missing", loc: { line: 1, col: 1 } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
