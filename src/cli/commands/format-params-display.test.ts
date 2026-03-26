import test from "node:test";
import assert from "node:assert/strict";
import { formatParamsForDisplay, formatNamedParamsForDisplay, normalizeParamValue } from "./format-params.js";

test("formatParamsForDisplay filters empty and whitespace-only params", () => {
  const params: Array<[string, string]> = [
    ["0", "text=Hello world"],
    ["1", "line="],
    ["2", "blank=   "],
    ["3", "body=Some text"],
  ];
  const result = formatParamsForDisplay(params);
  assert.equal(result, ' ("Hello world", "Some text")');
});

test("formatParamsForDisplay returns empty string when all params are empty after stripping", () => {
  const params: Array<[string, string]> = [
    ["0", "a="],
    ["1", "b=  "],
    ["2", "c=\t"],
  ];
  const result = formatParamsForDisplay(params);
  assert.equal(result, "");
});

test("formatParamsForDisplay filters bare empty strings without key prefix", () => {
  const params: Array<[string, string]> = [
    ["0", "Hello"],
    ["1", ""],
    ["2", "   "],
    ["3", "World"],
  ];
  const result = formatParamsForDisplay(params);
  assert.equal(result, " (Hello, World)");
});

test("formatNamedParamsForDisplay shows key=value pairs", () => {
  const params: Array<[string, string]> = [
    ["role", "role=refactorer"],
    ["task", "task=Fix the bug in auth"],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ' (role="refactorer", task="Fix the bug in auth")');
});

test("formatNamedParamsForDisplay shows positional numeric keys without $ prefix", () => {
  const params: Array<[string, string]> = [
    ["1", "1=Alice"],
    ["2", "2=Bob"],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ' (1="Alice", 2="Bob")');
});

test("formatNamedParamsForDisplay filters internal values and empty", () => {
  const params: Array<[string, string]> = [
    ["__prompt_impl", "jaiph::prompt_impl"],
    ["role", "role=engineer"],
    ["empty", "empty="],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ' (role="engineer")');
});

test("formatNamedParamsForDisplay truncates long values", () => {
  const params: Array<[string, string]> = [
    ["task", "task=" + "A".repeat(50)],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ` (task="${"A".repeat(32)}...")`);
});

test("formatNamedParamsForDisplay caps total length", () => {
  const params: Array<[string, string]> = [
    ["role", "role=engineer"],
    ["task", "task=Some very long task description here"],
  ];
  const result = formatNamedParamsForDisplay(params, { capTotalLength: 30 });
  assert.equal(result.length <= 30, true);
  assert.ok(result.endsWith("..."));
});

test("formatNamedParamsForDisplay converts argN keys to N", () => {
  const params: Array<[string, string]> = [
    ["arg1", "Alice"],
    ["arg2", "Bob"],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ' (1="Alice", 2="Bob")');
});

test("formatNamedParamsForDisplay normalizes newlines in values", () => {
  const params: Array<[string, string]> = [
    ["role", "role=<role>\nYou are a pragmatic engineer.\nBe concise."],
  ];
  const result = formatNamedParamsForDisplay(params);
  assert.equal(result, ' (role="<role> You are a pragmatic engin...")');
});

test("formatParamsForDisplay normalizes newlines in values", () => {
  const params: Array<[string, string]> = [
    ["0", "text=Hello\nWorld\nFoo"],
  ];
  const result = formatParamsForDisplay(params);
  assert.equal(result, ' ("Hello World Foo")');
});

test("normalizeParamValue collapses whitespace and trims", () => {
  assert.equal(normalizeParamValue("hello\nworld"), "hello world");
  assert.equal(normalizeParamValue("  a  b  "), "a b");
  assert.equal(normalizeParamValue("\n\n\n"), "");
  assert.equal(normalizeParamValue("simple"), "simple");
});
