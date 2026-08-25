import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeGraph, lookupScript, lookupDef } from "./graph";

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
      `export def check() {
  echo ok
}
export script helper = \`echo hi\`
export def inner() {
  echo ok
}`,
    );
    write(
      main,
      `import "./lib.jh" as lib
export def main() {
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
      `export def check() {
  echo ok
}
export script helper = \`echo hi\`
export def inner() {
  echo ok
}`,
    );
    write(
      main,
      `import "./lib.jh" as lib
def local_check() {
  echo local
}
script local_script = \`echo local\`
export def main() {
  run lib.inner()
}`,
    );
    const g = buildRuntimeGraph(main);
    const localWf = lookupDef(g, main, { value: "main", loc: { line: 1, col: 1 } });
    assert.equal(localWf?.name, "main");
    const importedWf = lookupDef(g, main, { value: "lib.inner", loc: { line: 1, col: 1 } });
    assert.equal(importedWf?.name, "inner");
    const localHelper = lookupDef(g, main, { value: "local_check", loc: { line: 1, col: 1 } });
    assert.equal(localHelper?.name, "local_check");
    const importedHelper = lookupDef(g, main, { value: "lib.check", loc: { line: 1, col: 1 } });
    assert.equal(importedHelper?.name, "check");
    assert.equal(lookupScript(g, main, "local_script")?.name, "local_script");
    assert.equal(lookupScript(g, main, "lib.helper")?.name, "helper");
    assert.equal(lookupDef(g, main, { value: "lib.missing", loc: { line: 1, col: 1 } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
