import test from "node:test";
import assert from "node:assert/strict";
import {
  parseParamKeysFromArgs,
  normalizeShellLocalExport,
  resolveShellRefs,
  transpileRuleRef,
  transpileWorkflowRef,
} from "../src/transpile/emit-steps";

// === parseParamKeysFromArgs ===

test("parseParamKeysFromArgs: returns null for empty string", () => {
  assert.equal(parseParamKeysFromArgs(""), null);
});

test("parseParamKeysFromArgs: returns null for whitespace-only string", () => {
  assert.equal(parseParamKeysFromArgs("   "), null);
});

test("parseParamKeysFromArgs: returns null for args without key=value pattern", () => {
  assert.equal(parseParamKeysFromArgs("hello world"), null);
});

test("parseParamKeysFromArgs: extracts single key", () => {
  assert.deepEqual(parseParamKeysFromArgs("name=Alice"), ["name"]);
});

test("parseParamKeysFromArgs: extracts multiple keys in order", () => {
  assert.deepEqual(parseParamKeysFromArgs("role=dev task=fix"), ["role", "task"]);
});

test("parseParamKeysFromArgs: handles underscored keys", () => {
  assert.deepEqual(parseParamKeysFromArgs("my_key=val another_key=val2"), ["my_key", "another_key"]);
});

// === normalizeShellLocalExport ===

test("normalizeShellLocalExport: removes spaces around = in local declaration", () => {
  assert.equal(normalizeShellLocalExport("local FOO = bar"), "local FOO=bar");
});

test("normalizeShellLocalExport: removes spaces around = in export declaration", () => {
  assert.equal(normalizeShellLocalExport("export VAR = value"), "export VAR=value");
});

test("normalizeShellLocalExport: removes spaces around = in readonly declaration", () => {
  assert.equal(normalizeShellLocalExport("readonly X = 1"), "readonly X=1");
});

test("normalizeShellLocalExport: leaves normal assignments untouched", () => {
  assert.equal(normalizeShellLocalExport("FOO=bar"), "FOO=bar");
});

test("normalizeShellLocalExport: handles multiple declarations in one line", () => {
  const input = "local A = 1; export B = 2";
  const result = normalizeShellLocalExport(input);
  assert.equal(result, "local A=1; export B=2");
});

// === resolveShellRefs ===

test("resolveShellRefs: replaces alias.name with symbol::name", () => {
  const symbols = new Map([["mod", "jaiph_mod_abc"]]);
  assert.equal(resolveShellRefs("mod.my_func arg1", symbols), "jaiph_mod_abc::my_func arg1");
});

test("resolveShellRefs: does not replace when alias is part of a longer identifier", () => {
  const symbols = new Map([["mod", "jaiph_mod_abc"]]);
  assert.equal(resolveShellRefs("mymod.func arg1", symbols), "mymod.func arg1");
});

test("resolveShellRefs: returns command unchanged when no symbols match", () => {
  const symbols = new Map([["other", "jaiph_other"]]);
  assert.equal(resolveShellRefs("echo hello", symbols), "echo hello");
});

test("resolveShellRefs: replaces multiple occurrences", () => {
  const symbols = new Map([["m", "sym"]]);
  assert.equal(resolveShellRefs("m.a && m.b", symbols), "sym::a && sym::b");
});

// === transpileRuleRef / transpileWorkflowRef ===

test("transpileRuleRef: resolves local rule reference", () => {
  const result = transpileRuleRef(
    { value: "check", loc: { line: 1, col: 1 } },
    "wf_main",
    new Map(),
  );
  assert.equal(result, "wf_main::check");
});

test("transpileRuleRef: resolves imported rule reference", () => {
  const symbols = new Map([["tools", "jaiph_tools_abc"]]);
  const result = transpileRuleRef(
    { value: "tools.lint", loc: { line: 1, col: 1 } },
    "wf_main",
    symbols,
  );
  assert.equal(result, "jaiph_tools_abc::lint");
});

test("transpileWorkflowRef: resolves local workflow reference", () => {
  const result = transpileWorkflowRef(
    { value: "helper", loc: { line: 1, col: 1 } },
    "wf_main",
    new Map(),
  );
  assert.equal(result, "wf_main::helper");
});

test("transpileWorkflowRef: resolves imported workflow reference", () => {
  const symbols = new Map([["lib", "jaiph_lib_xyz"]]);
  const result = transpileWorkflowRef(
    { value: "lib.deploy", loc: { line: 1, col: 1 } },
    "wf_main",
    symbols,
  );
  assert.equal(result, "jaiph_lib_xyz::deploy");
});
