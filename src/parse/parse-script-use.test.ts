// `use` clause on script declarations: `script name use KEY [KEY …] = …`,
// `export script … use … = …`, and `import script "…" as alias use KEY [KEY …]`.
// Keys are identifiers only and share the `--env` reserved-key contract
// (E_ENV_INVALID / E_ENV_RESERVED). `use` itself is reserved as a name.

import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { emitModule } from "../format";

test("script use: single key on a backtick script", () => {
  const mod = parsejaiph("script aaa use GITHUB_TOKEN = `gh pr list`", "test.jh");
  assert.equal(mod.scripts[0].name, "aaa");
  assert.deepEqual(mod.scripts[0].use, ["GITHUB_TOKEN"]);
});

test("script use: multiple space-separated keys, exported script", () => {
  const src = [
    "export script aaa use GITHUB_TOKEN NPM_TOKEN = ```",
    "gh pr list",
    "```",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.deepEqual(mod.scripts[0].use, ["GITHUB_TOKEN", "NPM_TOKEN"]);
  assert.ok(mod.exports.includes("aaa"));
});

test("script use: absent clause leaves `use` unset", () => {
  const mod = parsejaiph("script aaa = `echo x`", "test.jh");
  assert.equal(mod.scripts[0].use, undefined);
});

test("script use: body containing = still parses with a use clause", () => {
  const mod = parsejaiph("script aaa use K = `echo a=b`", "test.jh");
  assert.deepEqual(mod.scripts[0].use, ["K"]);
  assert.equal(mod.scripts[0].body, "echo a=b");
});

test("import script use: clause after the alias", () => {
  const src = ['import script "./gh.sh" as gh use GITHUB_TOKEN', "export def main() {", '  log "x"', "}"].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.scriptImports?.[0].alias, "gh");
  assert.deepEqual(mod.scriptImports?.[0].use, ["GITHUB_TOKEN"]);
});

test("use key must be a valid env var name (E_ENV_INVALID)", () => {
  assert.throws(
    () => parsejaiph("script aaa use 1BAD = `echo x`", "test.jh"),
    /E_ENV_INVALID use key "1BAD" is not a valid environment variable name/,
  );
  assert.throws(
    () => parsejaiph('script aaa use "GITHUB_TOKEN" = `echo x`', "test.jh"),
    /E_ENV_INVALID/,
  );
});

test("use key must not be reserved (E_ENV_RESERVED, same rule as --env)", () => {
  assert.throws(
    () => parsejaiph("script aaa use JAIPH_WORKSPACE = `echo x`", "test.jh"),
    /E_ENV_RESERVED use cannot request reserved key "JAIPH_WORKSPACE"/,
  );
  assert.throws(
    () => parsejaiph('import script "./gh.sh" as gh use JAIPH_ENV_GRANT', "test.jh"),
    /E_ENV_RESERVED/,
  );
});

test("`use` is reserved as a script name and import alias", () => {
  assert.throws(
    () => parsejaiph("script use = `echo x`", "test.jh"),
    /"use" is reserved/,
  );
  assert.throws(
    () => parsejaiph('import script "./x.sh" as use', "test.jh"),
    /"use" is reserved/,
  );
});

test("use clauses round-trip through the formatter", () => {
  const src = [
    'import script "./gh.sh" as gh use GITHUB_TOKEN',
    "",
    "script aaa use GITHUB_TOKEN NPM_TOKEN = `gh pr list`",
    "",
    "export script bbb use NPM_TOKEN = ```",
    "npm publish",
    "```",
    "",
    "export def main() {",
    "  run aaa()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const emitted = emitModule(mod);
  const reparsed = parsejaiph(emitted, "test.jh");
  assert.deepEqual(reparsed.scriptImports?.[0].use, ["GITHUB_TOKEN"]);
  assert.deepEqual(reparsed.scripts[0].use, ["GITHUB_TOKEN", "NPM_TOKEN"]);
  assert.deepEqual(reparsed.scripts[1].use, ["NPM_TOKEN"]);
  // One-step convergence: emitting the reparsed module reproduces the text.
  assert.equal(emitModule(reparsed), emitted);
});
