import test from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { workflowSymbolForFile, resolveImportPath, toImportSource, JAIPH_EXT_REGEX } from "./resolve";

// --- JAIPH_EXT_REGEX ---

test("JAIPH_EXT_REGEX: matches .jh extension", () => {
  assert.ok(JAIPH_EXT_REGEX.test("file.jh"));
});

test("JAIPH_EXT_REGEX: does not match .jh in middle", () => {
  assert.ok(!JAIPH_EXT_REGEX.test("file.jh.bak"));
});

// --- workflowSymbolForFile ---

test("workflowSymbolForFile: simple file in root", () => {
  const root = "/project";
  const file = "/project/hello.jh";
  assert.equal(workflowSymbolForFile(file, root), "hello");
});

test("workflowSymbolForFile: nested file", () => {
  const root = "/project";
  const file = "/project/lib/utils.jh";
  assert.equal(workflowSymbolForFile(file, root), "lib::utils");
});

test("workflowSymbolForFile: deeply nested file", () => {
  const root = "/project";
  const file = "/project/a/b/c.jh";
  assert.equal(workflowSymbolForFile(file, root), "a::b::c");
});

// --- resolveImportPath ---

test("resolveImportPath: adds .jh extension when missing", () => {
  const result = resolveImportPath("/project/main.jh", "lib");
  assert.equal(result, resolve("/project", "lib.jh"));
});

test("resolveImportPath: does not double-add .jh extension", () => {
  const result = resolveImportPath("/project/main.jh", "lib.jh");
  assert.equal(result, resolve("/project", "lib.jh"));
});

test("resolveImportPath: resolves relative to source file", () => {
  const result = resolveImportPath("/project/sub/main.jh", "../lib");
  assert.equal(result, resolve("/project", "lib.jh"));
});

// --- toImportSource ---

test("toImportSource: produces relative .sh path", () => {
  const result = toImportSource("lib", "/project/main.jh", "/project");
  assert.equal(result, "lib.sh");
});

test("toImportSource: handles cross-directory imports", () => {
  const result = toImportSource("../utils", "/project/sub/main.jh", "/project");
  assert.equal(result, "../utils.sh");
});
