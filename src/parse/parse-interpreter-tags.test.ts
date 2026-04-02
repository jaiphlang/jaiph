import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === Accepted: fenced block with lang tag ===

test("fenced block with python3 lang tag parses correctly", () => {
  const mod = parsejaiph('script transform = ```python3\nprint("hi")\n```', "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "transform");
  assert.equal(mod.scripts[0].lang, "python3");
  assert.equal(mod.scripts[0].body, 'print("hi")');
  assert.equal(mod.scripts[0].bodyKind, "fenced");
});

test("fenced block with node lang tag parses correctly", () => {
  const mod = parsejaiph("script transform = ```node\nconsole.log('hi');\n```", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "transform");
  assert.equal(mod.scripts[0].lang, "node");
  assert.equal(mod.scripts[0].body, "console.log('hi');");
  assert.equal(mod.scripts[0].bodyKind, "fenced");
});

test("any arbitrary lang tag is valid (no allowlist)", () => {
  const mod = parsejaiph("script run_deno = ```deno\nconsole.log('hi');\n```", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].lang, "deno");
  assert.equal(mod.scripts[0].bodyKind, "fenced");
});

// === Accepted: plain script without lang tag ===

test("plain script without lang tag has no lang", () => {
  const mod = parsejaiph('script setup = `echo hello`', "test.jh");
  assert.equal(mod.scripts[0].lang, undefined);
  assert.equal(mod.scripts[0].body, "echo hello");
  assert.equal(mod.scripts[0].bodyKind, "backtick");
});

// === Accepted: manual shebang in fenced body (no lang tag) ===

test("manual shebang in fenced body without lang tag works", () => {
  const mod = parsejaiph('script analyze = ```\n#!/usr/bin/env ruby\nputs "hi"\n```', "test.jh");
  assert.equal(mod.scripts[0].lang, undefined);
  assert.equal(mod.scripts[0].body, '#!/usr/bin/env ruby\nputs "hi"');
  assert.equal(mod.scripts[0].bodyKind, "fenced");
});

// === Rejected: both fence tag and manual shebang ===

test("fence tag with manual shebang is rejected", () => {
  assert.throws(
    () => parsejaiph("script transform = ```node\n#!/usr/bin/env node\nconsole.log('hi');\n```", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("already sets the shebang"),
  );
});

// === Rejected: old script:lang syntax ===

test("old script:lang syntax is rejected with actionable error", () => {
  assert.throws(
    () => parsejaiph("script:node transform = ```\nconsole.log('hi');\n```", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script:lang syntax is no longer supported"),
  );
});

// === Rejected: script:tag with parentheses ===

test("script with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph('script transform() = "body"', "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses"),
  );
});
