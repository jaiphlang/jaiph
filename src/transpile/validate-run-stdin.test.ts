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

test("validate: stdin body -> script(args) is accepted for a script target", () => {
  compile(
    [
      "script save = 'cat > \"$1\"'",
      "export def main(path, content) {",
      "  stdin content -> save(path)",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: stdin body -> 'cat'() is accepted for an inline script", () => {
  compile(
    [
      "export def main(content) {",
      "  stdin content -> 'cat'()",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: stdin body -> someDef() is E_VALIDATE (def target)", () => {
  assert.throws(
    () =>
      compile(
        [
          "def helper() {",
          '  log "hi"',
          "}",
          "export def main(x) {",
          "  stdin x -> helper()",
          "}",
          "",
        ].join("\n"),
      ),
    /stdin requires a script target; "helper" is a def/,
  );
});

test("validate: stdin <script>() -> script() producer call is accepted", () => {
  compile(
    [
      "script big = 'echo hi'",
      "script sink = 'cat'",
      "export def main() {",
      "  stdin big() -> sink()",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: stdin foo() -> bar() -> baz() three-stage pipeline of scripts is accepted", () => {
  compile(
    [
      "script foo = 'echo hi'",
      "script bar = 'cat'",
      "script baz = 'cat'",
      "export def main() {",
      "  stdin foo() -> bar() -> baz()",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: a def in an intermediate consumer slot is E_VALIDATE", () => {
  assert.throws(
    () =>
      compile(
        [
          "script foo = 'echo hi'",
          "script baz = 'cat'",
          "def mid() {",
          '  log "hi"',
          "}",
          "export def main() {",
          "  stdin foo() -> mid() -> baz()",
          "}",
          "",
        ].join("\n"),
      ),
    /stdin pipeline stage requires a script; "mid" is a def/,
  );
});

test("validate: a prompt producer is E_VALIDATE", () => {
  assert.throws(
    () =>
      compile(
        [
          "script sink = 'cat'",
          'prompt greet() = "say hi"',
          "export def main() {",
          "  stdin greet() -> sink()",
          "}",
          "",
        ].join("\n"),
      ),
    /prompt "greet" cannot be called as a script or def/,
  );
});

test("validate: stdin <def>() -> script() producer call is accepted (producer may be a def)", () => {
  compile(
    [
      "script big = 'echo hi'",
      "script sink = 'cat'",
      "def wrap() {",
      "  return big()",
      "}",
      "export def main() {",
      "  stdin wrap() -> sink()",
      "}",
      "",
    ].join("\n"),
  );
});

test("validate: stdin producer call resolves its ref (unknown producer is E_VALIDATE)", () => {
  assert.throws(
    () =>
      compile(
        [
          "script sink = 'cat'",
          "export def main() {",
          "  stdin nope() -> sink()",
          "}",
          "",
        ].join("\n"),
      ),
    /nope/,
  );
});

test("validate: stdin value must reference an in-scope binding", () => {
  assert.throws(
    () =>
      compile(
        [
          "script save = 'cat > \"$1\"'",
          "export def main(path) {",
          "  stdin missing -> save(path)",
          "}",
          "",
        ].join("\n"),
      ),
    /missing/,
  );
});
