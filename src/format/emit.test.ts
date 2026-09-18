import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsejaiphWithTrivia } from "../parser";
import { emitModule } from "./emit";

function roundTrip(source: string, filePath = "test.jh"): string {
  const { ast, trivia } = parsejaiphWithTrivia(source, filePath);
  return emitModule(ast, trivia);
}

describe("emitModule", () => {
  it("formats a minimal workflow", () => {
    const source = [
      "export def main() {",
      "  log \"hello\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats imports and channels", () => {
    const source = [
      'import "lib.jh" as lib',
      "",
      "channel findings",
      "",
      "export def main() {",
      "  log \"ok\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats rules with comments", () => {
    const source = [
      "# Validates prerequisites.",
      "def project_ready(name) {",
      '  check(arg1)',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats scripts with shebang", () => {
    const source = [
      "script my_script = ```",
      "#!/usr/bin/env python3",
      'print("hello")',
      "```",
      "",
    ].join("\n");
    const expected = [
      "script my_script = ```",
      "  #!/usr/bin/env python3",
      '  print("hello")',
      "```",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("dedents indented fenced script bodies and re-indents on format", () => {
    const source = [
      "script heredoc_demo = ```",
      "  cat <<'EOF'",
      "  line one",
      "  EOF",
      "```",
      "",
      "export def main() {",
      "  ```bash",
      "  echo inline",
      "  ```()",
      "}",
      "",
    ].join("\n");
    const expected = [
      "script heredoc_demo = ```",
      "  cat <<'EOF'",
      "  line one",
      "  EOF",
      "```",
      "",
      "export def main() {",
      "  ```bash",
      "    echo inline",
      "  ```()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("formats const with different RHS types", () => {
    const source = [
      "export def main(name) {",
      '  const n = "${arg1}"',
      '  const out = helper(n)',
      "  log out",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats run with catch block", () => {
    const source = [
      "export def main() {",
      "  ci_passes() catch (failure) {",
      '    prompt "fix it"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats async run", () => {
    const source = [
      "export def main() {",
      "  async worker()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips a stdin connect form (quoted literal is canonical)", () => {
    const source = [
      "export def main(content) {",
      '  stdin "${content}" -> save(path)',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("normalizes a bare-identifier stdin operand to a quoted interpolation and then round-trips", () => {
    const bare = [
      "export def main(content) {",
      "  stdin content -> save(path)",
      "}",
      "",
    ].join("\n");
    const canonical = [
      "export def main(content) {",
      '  stdin "${content}" -> save(path)',
      "}",
      "",
    ].join("\n");
    const once = roundTrip(bare);
    assert.equal(once, canonical);
    // Idempotent: formatting the canonical form again is a fixed point.
    assert.equal(roundTrip(once), canonical);
  });

  it("emits a stdin connect form on an inline script", () => {
    const source = [
      "export def main(content) {",
      '  stdin "${content}" -> `cat`()',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips a one-hop stdin producer call (stdin <call>() -> script())", () => {
    const source = [
      "script producer = `echo hi`",
      "",
      "script sink = `cat`",
      "",
      "export def main(text) {",
      "  stdin producer() -> sink()",
      "  stdin analyze(text) -> sink()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats return statement", () => {
    const source = [
      "export def main() {",
      '  return "${result}"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats send with various RHS", () => {
    const source = [
      "channel findings",
      "",
      "export def main() {",
      '  send echo "hello" -> findings',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats config block", () => {
    const source = [
      "config {",
      '  agent.backend = "claude"',
      "}",
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("is a bit-for-bit no-op on a first-agent const = prompt triple-quoted def body", () => {
    // The shebang is CLI-only trivia (see docs/cli.md), so the module body here
    // omits it. A formatter that collapses `prompt """ … """` to a double-quoted
    // string, re-indents the two body lines off the authored 4-space margin,
    // moves the closing `"""` off 2 spaces, drops the blank line before `return`,
    // or substitutes/escapes `${name}` must fail this test.
    const source = [
      "export def hello(name) {",
      '  const response = prompt """',
      "    Say hello to ${name} and provide a fun fact about a person with the same name.",
      "    Respond with a single line. Do not inspect files or run tools.",
      '  """',
      "",
      "  return response",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
    // Idempotent: a second pass is a fixed point.
    assert.equal(roundTrip(roundTrip(source)), source);
  });

  it("round-trips top-level const with quotes in a triple-quoted body", () => {
    const source = [
      "const prompt_text = \"\"\"",
      "Say: \"Greetings! I am [model name].\"",
      '"""',
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("does not insert blank lines between consecutive config-leading # lines", () => {
    const source = [
      "#",
      "# Header line.",
      "#",
      "",
      "config {",
      '  agent.backend = "cursor"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("respects custom indent", () => {
    const input = [
      "export def main() {",
      "  log \"hello\"",
      "}",
      "",
    ].join("\n");
    const expected = [
      "export def main() {",
      "    log \"hello\"",
      "}",
      "",
    ].join("\n");
    const { ast, trivia } = parsejaiphWithTrivia(input, "test.jh");
    assert.equal(emitModule(ast, trivia, { indent: 4 }), expected);
  });

  it("reorders out-of-order definitions to canonical order", () => {
    const input = [
      "config {",
      '  agent.backend = "claude"',
      "}",
      "",
      'import "lib.jh" as lib',
      "",
      "channel findings",
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    const expected = [
      'import "lib.jh" as lib',
      "",
      "config {",
      '  agent.backend = "claude"',
      "}",
      "",
      "channel findings",
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(input), expected);
  });

  it("preserves rule / workflow / script order from source", () => {
    const source = [
      "def w() {",
      '  log "hi"',
      "}",
      "",
      "def r() {",
      "  w()",
      "}",
      "",
      "script s = `echo s`",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves a top-level comment before declarations across blank lines", () => {
    const source = [
      "# About this module",
      "",
      "def r() {",
      "  w()",
      "}",
      "",
      "def w() {",
      '  log "x"',
      "}",
      "",
    ].join("\n");
    // Blank lines only between top-level sections; attached comments sit directly above their decl.
    const expected = [
      "# About this module",
      "def r() {",
      "  w()",
      "}",
      "",
      "def w() {",
      '  log "x"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("is idempotent", () => {
    const source = [
      "# A comment",
      "def check() {",
      "  impl()",
      "}",
      "",
      "export def main() {",
      "  check()",
      '  log "done"',
      "}",
      "",
    ].join("\n");
    const first = roundTrip(source);
    const second = roundTrip(first);
    assert.equal(first, second);
  });

  it("formats fail step", () => {
    const source = [
      "export def main() {",
      '  fail "something went wrong"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves # comments inside config blocks and round-trips", () => {
    const source = [
      "config {",
      "  # note",
      '  agent.backend = "cursor"',
      "}",
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves trailing top-level # comments at end of file", () => {
    const source = [
      "export def main() {",
      '  log "ok"',
      "}",
      "",
      "# trailing",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("emits bare log identifier as log name not quoted interpolation", () => {
    const source = [
      "export def main() {",
      "  log review",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats channel routing", () => {
    const source = [
      "channel findings -> analyst",
      "",
      "export def main() {",
      "  scanner()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats prompt with returns", () => {
    const source = [
      "export def main() {",
      "  const result = prompt \"classify\" returns \"{ role: string }\"",
      "  log result",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats const captures", () => {
    const source = [
      "export def main() {",
      "  const response = check()",
      "  const out = helper()",
      "  log response",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats match with triple-quoted arm body", () => {
    const source = [
      "export def main() {",
      '  const x = "ok"',
      "  return match x {",
      '    "ok" => """',
      "line one",
      "line two",
      '  """',
      '    _ => "default"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves mixed workflow/rule/script interleaved order", () => {
    const source = [
      "def dispatch() {",
      '  log "dispatching"',
      "}",
      "",
      "def is_ready() {",
      "  dispatch()",
      "}",
      "",
      "script helper = `echo ok`",
      "",
      "def finalize() {",
      '  log "done"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves comments before each top-level declaration type", () => {
    const source = [
      "# A workflow",
      "def w() {",
      '  log "w"',
      "}",
      "",
      "# A rule",
      "def r() {",
      "  w()",
      "}",
      "",
      "# A script",
      "script s = `echo s`",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves comments before top-level const declarations", () => {
    const source = [
      "# Project name",
      "const project = my-project",
      "",
      "export def main() {",
      "  log project",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("hoists imports and channels while preserving non-hoisted order", () => {
    const source = [
      "def first() {",
      '  log "1"',
      "}",
      "",
      'import "lib.jh" as lib',
      "",
      "def middle() {",
      "  first()",
      "}",
      "",
      "channel events",
      "",
      "script last = `echo last`",
      "",
    ].join("\n");
    const expected = [
      'import "lib.jh" as lib',
      "",
      "channel events",
      "",
      "def first() {",
      '  log "1"',
      "}",
      "",
      "def middle() {",
      "  first()",
      "}",
      "",
      "script last = `echo last`",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("formats match with single-line arms round-trip", () => {
    const source = [
      "export def main() {",
      '  const x = "ok"',
      "  return match x {",
      '    "ok" => "yes"',
      '    _ => "no"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips run with single recover statement", () => {
    const source = [
      "export def main() {",
      '  deploy() recover (err) log "fixing"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips run with multiline recover block", () => {
    const source = [
      "export def main() {",
      "  deploy() recover (err) {",
      '    log "fixing"',
      "    fix()",
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips config with run.recover_limit", () => {
    const source = [
      "config {",
      "  run.recover_limit = 5",
      "}",
      "",
      "export def main() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips const capture with run async", () => {
    const source = [
      "export def main() {",
      "  const h = async foo()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips async with recover block", () => {
    const source = [
      "export def main() {",
      "  async foo() recover (err) {",
      '    log "repair"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips async with multi-line recover block", () => {
    const source = [
      "export def main() {",
      "  async foo() recover (err) {",
      '    log "repairing"',
      "    fix_it()",
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves bare identifier return (does not rewrite as ${var} interpolation)", () => {
    const source = [
      "export def main() {",
      '  const response = "hi"',
      "  return response",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves bare dotted identifier return (does not rewrite as ${base.field})", () => {
    const source = [
      "export def main() {",
      '  const r = prompt "go" returns "{ ok: bool }"',
      "  return r.ok",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it('preserves explicit "${var}" return form when authored that way', () => {
    const source = [
      "export def main() {",
      '  const response = "hi"',
      '  return "${response}"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats if/else with canonical `} else {` on one line", () => {
    const source = [
      "export def main(status) {",
      '  if status == "ok" {',
      '    log "healthy"',
      "  } else {",
      '    logerr "unhealthy: ${status}"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves an `else if` chain instead of rewriting it as nested if/else", () => {
    const source = [
      "export def main(status) {",
      '  if status == "ok" {',
      '    log "healthy"',
      '  } else if status == "warn" {',
      '    logwarn "degraded"',
      "  } else {",
      '    logerr "unhealthy"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
    // idempotent across a second pass
    assert.equal(roundTrip(roundTrip(source)), source);
  });

  it("if/else is idempotent across two format passes", () => {
    const source = [
      "export def main(status) {",
      '  if status == "ok" {',
      '    log "healthy"',
      "  } else {",
      '    logerr "unhealthy: ${status}"',
      "  }",
      "}",
      "",
    ].join("\n");
    const once = roundTrip(source);
    const twice = roundTrip(once);
    assert.equal(twice, once);
  });

  it("preserves quotes on top-level const string values regardless of spaces", () => {
    const source = [
      'const p = "some/path with space.md"',
      "",
      'const q = ".jaiph/tmp/x.md"',
      "",
      "const MAX = 3",
      "",
      "export def main() {",
      "  log p",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("top-level const quoting is idempotent across two format passes", () => {
    const source = [
      'const p = "some/path with space.md"',
      "",
      'const q = ".jaiph/tmp/x.md"',
      "",
      "const MAX = 3",
      "",
      "export def main() {",
      "  log p",
      "}",
      "",
    ].join("\n");
    const once = roundTrip(source);
    const twice = roundTrip(once);
    assert.equal(twice, once);
    assert.equal(once, source);
  });

  it("preserves top-level const value bit-for-bit across format (so ${q} interpolation is identical)", () => {
    const source = [
      'const q = ".jaiph/tmp/x.md"',
      "",
      'const p = "some/path with space.md"',
      "",
      "const MAX = 3",
      "",
      "export def main() {",
      '  log "${q}"',
      "}",
      "",
    ].join("\n");
    const before = parsejaiphWithTrivia(source, "test.jh").ast;
    const formatted = roundTrip(source);
    const after = parsejaiphWithTrivia(formatted, "test.jh").ast;
    assert.equal(after.envDecls!.length, before.envDecls!.length);
    for (let i = 0; i < before.envDecls!.length; i++) {
      assert.equal(after.envDecls![i].name, before.envDecls![i].name);
      assert.equal(after.envDecls![i].value, before.envDecls![i].value);
    }
    assert.equal(before.envDecls![0].value, ".jaiph/tmp/x.md");
  });
});
