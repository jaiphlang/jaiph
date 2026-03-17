import test from "node:test";
import assert from "node:assert/strict";
import { formatParamsForDisplay } from "../src/cli/commands/format-params.js";

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
