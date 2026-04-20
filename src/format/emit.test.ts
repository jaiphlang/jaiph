import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { emitModule } from "./emit";

function roundTrip(source: string, filePath = "test.jh"): string {
  const mod = parsejaiph(source, filePath);
  return emitModule(mod);
}

describe("emitModule", () => {
  it("formats a minimal workflow", () => {
    const source = [
      "workflow default() {",
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
      "workflow default() {",
      "  log \"ok\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats rules with comments", () => {
    const source = [
      "# Validates prerequisites.",
      "rule project_ready(name) {",
      '  run check(arg1)',
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
    assert.equal(roundTrip(source), source);
  });

  it("formats const with different RHS types", () => {
    const source = [
      "workflow default(name) {",
      '  const n = "${arg1}"',
      '  const out = run helper(n)',
      "  log out",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats ensure with catch block", () => {
    const source = [
      "workflow default() {",
      "  ensure ci_passes() catch (failure) {",
      '    prompt "fix it"',
      "  }",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats async run", () => {
    const source = [
      "workflow default() {",
      "  run async worker()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats return statement", () => {
    const source = [
      "workflow default() {",
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
      "workflow default() {",
      '  findings <- echo "hello"',
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
      "workflow default() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips top-level const with quotes in a triple-quoted body", () => {
    const source = [
      "const prompt_text = \"\"\"",
      "Say: \"Greetings! I am [model name].\"",
      '"""',
      "",
      "workflow default() {",
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
      "workflow default() {",
      "  log \"hello\"",
      "}",
      "",
    ].join("\n");
    const expected = [
      "workflow default() {",
      "    log \"hello\"",
      "}",
      "",
    ].join("\n");
    const mod = parsejaiph(input, "test.jh");
    assert.equal(emitModule(mod, { indent: 4 }), expected);
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
      "workflow default() {",
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
      "workflow default() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(input), expected);
  });

  it("preserves rule / workflow / script order from source", () => {
    const source = [
      "workflow w() {",
      '  log "hi"',
      "}",
      "",
      "rule r() {",
      "  run w()",
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
      "rule r() {",
      "  run w()",
      "}",
      "",
      "workflow w() {",
      '  log "x"',
      "}",
      "",
    ].join("\n");
    // Blank lines only between top-level sections; attached comments sit directly above their decl.
    const expected = [
      "# About this module",
      "rule r() {",
      "  run w()",
      "}",
      "",
      "workflow w() {",
      '  log "x"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("is idempotent", () => {
    const source = [
      "# A comment",
      "rule check() {",
      "  run impl()",
      "}",
      "",
      "workflow default() {",
      "  ensure check()",
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
      "workflow default() {",
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
      "workflow default() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves trailing top-level # comments at end of file", () => {
    const source = [
      "workflow default() {",
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
      "workflow default() {",
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
      "workflow default() {",
      "  run scanner()",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats prompt with returns", () => {
    const source = [
      "workflow default() {",
      "  const result = prompt \"classify\" returns \"{ role: string }\"",
      "  log result",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats const captures", () => {
    const source = [
      "workflow default() {",
      "  const response = ensure check()",
      "  const out = run helper()",
      "  log response",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats match with triple-quoted arm body", () => {
    const source = [
      "workflow default() {",
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
      "workflow dispatch() {",
      '  log "dispatching"',
      "}",
      "",
      "rule is_ready() {",
      "  run dispatch()",
      "}",
      "",
      "script helper = `echo ok`",
      "",
      "workflow finalize() {",
      '  log "done"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("preserves comments before each top-level declaration type", () => {
    const source = [
      "# A workflow",
      "workflow w() {",
      '  log "w"',
      "}",
      "",
      "# A rule",
      "rule r() {",
      "  run w()",
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
      "workflow default() {",
      "  log project",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("hoists imports and channels while preserving non-hoisted order", () => {
    const source = [
      "workflow first() {",
      '  log "1"',
      "}",
      "",
      'import "lib.jh" as lib',
      "",
      "rule middle() {",
      "  run first()",
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
      "workflow first() {",
      '  log "1"',
      "}",
      "",
      "rule middle() {",
      "  run first()",
      "}",
      "",
      "script last = `echo last`",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), expected);
  });

  it("formats match with single-line arms round-trip", () => {
    const source = [
      "workflow default() {",
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
      "workflow default() {",
      '  run deploy() recover (err) log "fixing"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("round-trips run with multiline recover block", () => {
    const source = [
      "workflow default() {",
      "  run deploy() recover (err) {",
      '    log "fixing"',
      "    run fix()",
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
      "workflow default() {",
      '  log "ok"',
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });
});
