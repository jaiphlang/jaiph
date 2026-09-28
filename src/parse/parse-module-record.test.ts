// The builtin `module` record: `module` is a reserved name. It cannot be bound
// by any declaration (param, const, def, script, prompt, channel, import
// alias), at the top level or nested. Its module-level `config` keys
// (`module.name` / `module.version` / `module.description`) still parse.

import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

function parse(src: string): void {
  parsejaiph(src, "/mod.jh");
}

test("module: parameter name `module` is E_PARSE (reserved keyword)", () => {
  assert.throws(
    () => parse('def f(module) {\n  return "x"\n}\n'),
    /E_PARSE .*parameter name "module" is a reserved keyword/,
  );
});

test("module: `const module = ...` is E_PARSE (top-level)", () => {
  assert.throws(
    () => parse('const module = "x"\nexport def main() {\n  log "y"\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a const name/,
  );
});

test("module: `const module = ...` is E_PARSE (nested in a def)", () => {
  assert.throws(
    () => parse('export def main() {\n  const module = "x"\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a const name/,
  );
});

test("module: `def module()` is E_PARSE", () => {
  assert.throws(
    () => parse('export def module() {\n  log "x"\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a def name/,
  );
});

test("module: nested `def module()` is E_PARSE", () => {
  assert.throws(
    () => parse('export def main() {\n  def module() {\n    log "x"\n  }\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a def name/,
  );
});

test("module: `script module` is E_PARSE", () => {
  assert.throws(
    () => parse("script module = 'echo x'\nexport def main() {\n  log \"y\"\n}\n"),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a script name/,
  );
});

test("module: `import ... as module` is E_PARSE", () => {
  assert.throws(
    () => parse('import "./a.jh" as module\nexport def main() {\n  log "y"\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a import alias name/,
  );
});

test("module: `channel module` is E_PARSE", () => {
  assert.throws(
    () => parse('channel module\nexport def main() {\n  log "y"\n}\n'),
    /E_PARSE .*"module" is a reserved builtin record and cannot be used as a channel name/,
  );
});

test("module: module-level `config { module.name = ... }` still parses", () => {
  const ast = parsejaiph(
    'config {\n  module.name = "proj"\n  module.version = "1"\n  module.description = "d"\n}\nexport def main() {\n  log "ok"\n}\n',
    "/mod.jh",
  );
  assert.equal(ast.metadata?.module?.name, "proj");
  assert.equal(ast.metadata?.module?.version, "1");
  assert.equal(ast.metadata?.module?.description, "d");
});

test("module: `module.*` in def-level config is E_PARSE", () => {
  assert.throws(
    () => parse('export def main() {\n  config {\n    module.name = "x"\n  }\n  log "ok"\n}\n'),
    /E_PARSE .*module\.\* keys are not allowed in def-level config/,
  );
});

test("module: `${module.dir}` and bare `module.dir` args parse without a binding error", () => {
  // Purely a parse check — compiler validation is covered separately.
  parse(
    [
      "script use_it = 'echo x'",
      "export def main() {",
      '  const manifest = "${module.dir}/sources.json"',
      "  use_it(module.dir)",
      '  log "${module.file}"',
      "  return module.file",
      "}",
      "",
    ].join("\n"),
  );
});
