import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractJson, validateSchema, describeSchema } from "./schema";
import { parseReturnsSchema, type SchemaField } from "../../prompt-schema";

/** Parse a schema string to fields (fails the test if the schema is malformed). */
function fields(raw: string): SchemaField[] {
  const parsed = parseReturnsSchema(raw);
  assert.ok(parsed.ok, `schema should parse: ${raw}`);
  return parsed.fields;
}

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

  it("prefers the answer over a small object in prose on the same line", () => {
    // A model wrote its explanation and the answer on one line; the prose
    // contained `{ }`, which parses as an empty object and used to win.
    const raw = 'Checked the punct list `( ) { }` and it is fine. {"verdict":"accepted","tags":"dev-ready"}';
    const result = extractJson(raw);
    assert.ok(result);
    assert.deepEqual(result.obj, { verdict: "accepted", tags: "dev-ready" });
  });

  it("ignores braces inside JSON string values", () => {
    const raw = 'Done: {"body":"match … { and a stray } and ${x}","ok":"yes"}';
    const result = extractJson(raw);
    assert.ok(result);
    assert.deepEqual(result.obj, { body: "match … { and a stray } and ${x}", ok: "yes" });
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

describe("validateSchema — scalars", () => {
  it("returns null when all fields present and correct type", () => {
    const obj = { name: "test", count: 42 };
    assert.equal(validateSchema(obj, fields("{ name: string, count: number }")), null);
  });

  it("names a missing required field", () => {
    assert.equal(
      validateSchema({}, fields("{ role: string }")),
      "prompt response missing required field: role",
    );
  });

  it("names field, expected type, and actual type on mismatch", () => {
    assert.equal(
      validateSchema({ role: 42 }, fields("{ role: string }")),
      'prompt response field "role" expected string, got number',
    );
  });
});

describe("validateSchema — enums", () => {
  const schema = '{ status: "approve" | "reject" | "unsure" }';

  it("accepts each listed literal", () => {
    for (const v of ["approve", "reject", "unsure"]) {
      assert.equal(validateSchema({ status: v }, fields(schema)), null);
    }
  });

  it("rejects an unlisted value naming field, value, and literals", () => {
    assert.equal(
      validateSchema({ status: "aprove" }, fields(schema)),
      'prompt response field "status" must be one of "approve" | "reject" | "unsure", got "aprove"',
    );
  });

  it("rejects a non-string value", () => {
    assert.equal(
      validateSchema({ status: 1 }, fields(schema)),
      'prompt response field "status" expected one of "approve" | "reject" | "unsure", got number',
    );
  });
});

describe("validateSchema — arrays of records", () => {
  const schema = "{ key_changes: [{ path: string, start: number, end: number, note: string }] }";

  it("accepts a matching array", () => {
    const obj = { key_changes: [{ path: "a.ts", start: 1, end: 9, note: "x" }] };
    assert.equal(validateSchema(obj, fields(schema)), null);
  });

  it("accepts an empty array", () => {
    assert.equal(validateSchema({ key_changes: [] }, fields(schema)), null);
  });

  it("rejects a non-array", () => {
    assert.equal(
      validateSchema({ key_changes: "oops" }, fields(schema)),
      'prompt response field "key_changes" expected an array, got string',
    );
  });

  it("rejects a record missing a declared field, naming the path", () => {
    const obj = {
      key_changes: [
        { path: "a.ts", start: 1, end: 9, note: "x" },
        { path: "b.ts", start: 2, end: 9, note: "y" },
        { path: "c.ts", end: 9, note: "z" },
      ],
    };
    assert.equal(
      validateSchema(obj, fields(schema)),
      'prompt response field "key_changes[2].start" is missing',
    );
  });

  it("rejects a field of the wrong type, naming the path", () => {
    const obj = { key_changes: [{ path: "a.ts", start: 1, end: 9, note: "x" }, { path: "b.ts", start: "nope", end: 9, note: "y" }] };
    assert.equal(
      validateSchema(obj, fields(schema)),
      'prompt response field "key_changes[1].start" expected number, got string',
    );
  });

  it("validates an enum inside an array record", () => {
    const schemaWithEnum = '{ rows: [{ verdict: "ok" | "bad" }] }';
    assert.equal(
      validateSchema({ rows: [{ verdict: "maybe" }] }, fields(schemaWithEnum)),
      'prompt response field "rows[0].verdict" must be one of "ok" | "bad", got "maybe"',
    );
  });
});

describe("describeSchema", () => {
  it("describes scalars, enums, and arrays in plain words", () => {
    const schema = '{ name: string, status: "approve" | "reject", rows: [{ path: string, kind: "add" | "del" }] }';
    const text = describeSchema(fields(schema));
    assert.match(text, /Respond with exactly one line of valid JSON/);
    assert.match(text, /- name: string/);
    assert.match(text, /- status: one of "approve", "reject"/);
    assert.match(text, /- rows: an array of objects, each with \{ path: string, kind: one of "add", "del" \}/);
  });
});

