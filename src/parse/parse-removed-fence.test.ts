import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("named script: triple-backtick fence is E_PARSE", () => {
  assert.throws(
    () => parsejaiph("script foo = ```\necho hi\n```\n", "test.jh"),
    /script bodies use triple single quotes/,
  );
});

test("inline script: triple-backtick fence is E_PARSE", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  ```\n  echo hi\n  ```()\n}\n", "test.jh"),
    /script bodies use triple single quotes/,
  );
});

test("inline script: quote in a block body is data", () => {
  const ast = parsejaiph(
    ["export def main() {", "  '''", "echo 'hi'", "'''()", "}", ""].join("\n"),
    "test.jh",
  );
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.equal(step.body.body, "echo 'hi'");
  }
});

test("named script: triple single quotes parse", () => {
  const mod = parsejaiph("script foo = '''\necho hi\n'''\n", "test.jh");
  assert.equal(mod.scripts[0]?.body, "echo hi");
});
