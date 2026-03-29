import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShellLocalExport, resolveShellRefs } from "./emit-script";

test("normalizeShellLocalExport: removes spaces around = in local declaration", () => {
  assert.equal(normalizeShellLocalExport("local FOO = bar"), "local FOO=bar");
});

test("normalizeShellLocalExport: removes spaces around = in export declaration", () => {
  assert.equal(normalizeShellLocalExport("export VAR = value"), "export VAR=value");
});

test("normalizeShellLocalExport: leaves normal assignments untouched", () => {
  assert.equal(normalizeShellLocalExport("FOO=bar"), "FOO=bar");
});

test("resolveShellRefs: replaces alias.name with symbol::name", () => {
  const symbols = new Map([["mod", "jaiph_mod_abc"]]);
  assert.equal(resolveShellRefs("mod.my_func arg1", symbols), "jaiph_mod_abc::my_func arg1");
});

test("resolveShellRefs: does not replace when alias is part of a longer identifier", () => {
  const symbols = new Map([["mod", "jaiph_mod_abc"]]);
  assert.equal(resolveShellRefs("mymod.func arg1", symbols), "mymod.func arg1");
});
