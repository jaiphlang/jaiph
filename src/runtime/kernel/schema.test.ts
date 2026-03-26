import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractJson, validateFields, buildEvalString } from "./schema";

describe("extractJson", () => {
  it("extracts from a plain JSON line", () => {
    const result = extractJson('{"role":"engineer"}');
    assert.ok(result);
    assert.deepEqual(result.obj, { role: "engineer" });
  });

  it("extracts balanced object from line with trailing text", () => {
    const result = extractJson('{"role":"optimizer"}garbage');
    assert.ok(result);
    assert.deepEqual(result.obj, { role: "optimizer" });
  });

  it("extracts from fenced code block", () => {
    const raw = "Some text\n```json\n{\"role\":\"dev\"}\n```\nMore text";
    const result = extractJson(raw);
    assert.ok(result);
    assert.deepEqual(result.obj, { role: "dev" });
  });

  it("extracts embedded JSON from a line", () => {
    const raw = "Result: {\"name\":\"test\"} here";
    const result = extractJson(raw);
    assert.ok(result);
    assert.deepEqual(result.obj, { name: "test" });
  });

  it("returns null for non-JSON text", () => {
    // Suppress stderr for this test
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = extractJson("not json at all");
    process.stderr.write = origWrite;
    assert.equal(result, null);
  });
});

describe("validateFields", () => {
  it("returns 0 when all fields present and correct type", () => {
    const obj = { name: "test", count: 42 };
    const fields = [{ name: "name", type: "string" }, { name: "count", type: "number" }];
    assert.equal(validateFields(obj, fields), 0);
  });

  it("returns 2 when field is missing", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = validateFields({}, [{ name: "role", type: "string" }]);
    process.stderr.write = origWrite;
    assert.equal(result, 2);
  });

  it("returns 3 on type mismatch", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = validateFields({ role: 42 }, [{ name: "role", type: "string" }]);
    process.stderr.write = origWrite;
    assert.equal(result, 3);
  });
});

describe("buildEvalString", () => {
  it("builds correct eval string", () => {
    const obj = { role: "engineer" };
    const fields = [{ name: "role", type: "string" }];
    const result = buildEvalString(obj, fields, "result", '{"role":"engineer"}');
    assert.ok(result.startsWith("result="));
    assert.ok(result.includes("export result_role='engineer'"));
  });

  it("escapes single quotes in values", () => {
    const obj = { note: "it's fine" };
    const fields = [{ name: "note", type: "string" }];
    const result = buildEvalString(obj, fields, "r", '{"note":"it\'s fine"}');
    assert.ok(result.includes("'\\''"));
  });
});
