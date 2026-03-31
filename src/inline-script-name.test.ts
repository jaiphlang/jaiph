import test from "node:test";
import assert from "node:assert/strict";
import { inlineScriptName } from "./inline-script-name";

test("inlineScriptName: deterministic for same body", () => {
  const a = inlineScriptName("echo hello");
  const b = inlineScriptName("echo hello");
  assert.equal(a, b);
});

test("inlineScriptName: different bodies produce different names", () => {
  const a = inlineScriptName("echo hello");
  const b = inlineScriptName("echo world");
  assert.notEqual(a, b);
});

test("inlineScriptName: shebang affects name", () => {
  const a = inlineScriptName("print('hi')");
  const b = inlineScriptName("print('hi')", "#!/usr/bin/env python3");
  assert.notEqual(a, b);
});

test("inlineScriptName: starts with __inline_ prefix", () => {
  const name = inlineScriptName("echo test");
  assert.ok(name.startsWith("__inline_"));
  assert.equal(name.length, "__inline_".length + 12);
});
