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

  it("formats if/else if/else", () => {
    const source = [
      "workflow default() {",
      "  if ensure ok() {",
      '    log "then"',
      "  }",
      "  else if not ensure ok() {",
      '    log "elif"',
      "  }",
      "  else {",
      '    log "else"',
      "  }",
      "}",
      "",
    ].join("\n");

    const mod = parsejaiph(source, "test.jh");
    const result = emitModule(mod);
    assert.equal(result, source);
  });

  it("formats const with different RHS types", () => {
    const source = [
      "workflow default(name) {",
      '  const n = "${arg1}"',
      '  const out = run helper(n)',
      "  log \"${out}\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats ensure with recover block", () => {
    const source = [
      "workflow default() {",
      "  ensure ci_passes() recover (failure) {",
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
      "  log \"${result}\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });

  it("formats assignment captures", () => {
    const source = [
      "workflow default() {",
      "  response = ensure check()",
      "  out = run helper()",
      "  log \"${response}\"",
      "}",
      "",
    ].join("\n");
    assert.equal(roundTrip(source), source);
  });
});
