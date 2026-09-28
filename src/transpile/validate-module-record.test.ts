// Compiler treatment of the builtin `module` record: its five fields
// (`file` / `dir` / `name` / `version` / `description`) validate like a typed
// prompt capture — a good field passes everywhere a value can appear, a bad
// field is `E_VALIDATE` and names the legal fields. Applies in every module.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModuleGraph } from "./module-graph";
import { collectDiagnostics } from "./validate";

function diagnose(files: Record<string, string>, entry: string): { code: string; message: string }[] {
  const root = mkdtempSync(join(tmpdir(), "jaiph-module-record-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(root, name), body);
    }
    const graph = loadModuleGraph(join(root, entry));
    return collectDiagnostics(graph).errors.map((e) => ({ code: e.code, message: e.message }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("module: the five fields compile in every value position", () => {
  const errors = diagnose(
    {
      "flow.jh": [
        "script use_it = 'echo x'",
        "export def main() {",
        '  const manifest = "${module.dir}/sources.json"',
        "  use_it(module.dir)",
        '  log "${module.name} ${module.version} ${module.description}"',
        "  if module.dir == \"/x\" {",
        '    log "${module.file}"',
        "  }",
        "  return module.file",
        "}",
        "",
      ].join("\n"),
    },
    "flow.jh",
  );
  assert.deepEqual(errors, []);
});

test("module: an unknown field is E_VALIDATE and names the five fields", () => {
  const errors = diagnose(
    {
      "flow.jh": [
        "export def main() {",
        '  return "${module.bogus}"',
        "}",
        "",
      ].join("\n"),
    },
    "flow.jh",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "E_VALIDATE");
  assert.match(errors[0]!.message, /module has no field "bogus"/);
  assert.match(errors[0]!.message, /file, dir, name, version, description/);
});

test("module: bad field as a bare call argument is E_VALIDATE", () => {
  const errors = diagnose(
    {
      "flow.jh": [
        "script use_it = 'echo x'",
        "export def main() {",
        "  use_it(module.bogus)",
        "}",
        "",
      ].join("\n"),
    },
    "flow.jh",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "E_VALIDATE");
  assert.match(errors[0]!.message, /module has no field "bogus"/);
});

test("module: the check applies inside an imported module too", () => {
  const errors = diagnose(
    {
      "lib.jh": [
        "export def helper() {",
        '  return "${module.bogus}"',
        "}",
        "",
      ].join("\n"),
      "flow.jh": [
        'import "./lib.jh" as lib',
        "export def main() {",
        "  lib.helper()",
        "}",
        "",
      ].join("\n"),
    },
    "flow.jh",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "E_VALIDATE");
  assert.match(errors[0]!.message, /module has no field "bogus"/);
});
