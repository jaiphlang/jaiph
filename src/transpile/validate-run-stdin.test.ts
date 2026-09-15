import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

/** Write `body` to a temp module and compile it, cleaning up afterward. */
function compile(body: string): void {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-stdin-"));
  try {
    writeFileSync(join(root, "m.jh"), body);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("validate: run script(args) stdin body is accepted for a script target", () => {
  compile(
    [
      "script save = `cat > \"$1\"`",
      "export def main(path, content) {",
      "  run save(path) stdin content",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: run `cat`() stdin body is accepted for an inline script", () => {
  compile(
    [
      "export def main(content) {",
      "  run `cat`() stdin content",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: run someDef() stdin x is E_VALIDATE (def target)", () => {
  assert.throws(
    () =>
      compile(
        [
          "def helper() {",
          '  log "hi"',
          "}",
          "export def main(x) {",
          "  run helper() stdin x",
          "}",
          "",
        ].join("\n"),
      ),
    /stdin requires a run of a script; "helper" is a def/,
  );
});

test("validate: stdin value must reference an in-scope binding", () => {
  assert.throws(
    () =>
      compile(
        [
          "script save = `cat > \"$1\"`",
          "export def main(path) {",
          "  run save(path) stdin missing",
          "}",
          "",
        ].join("\n"),
      ),
    /missing/,
  );
});
