import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseReturnsSchema, schemaFieldNames } from "./prompt-schema";

function ok(raw: string) {
  const r = parseReturnsSchema(raw);
  assert.ok(r.ok, `expected ${raw} to parse: ${r.ok ? "" : r.message}`);
  return r.fields;
}

function err(raw: string): { code: "E_PARSE" | "E_SCHEMA"; message: string } {
  const r = parseReturnsSchema(raw);
  assert.ok(!r.ok, `expected ${raw} to fail`);
  return { code: r.code, message: r.message };
}

describe("parseReturnsSchema — flat schemas (unchanged behavior)", () => {
  it("parses scalar fields", () => {
    assert.deepEqual(ok("{ name: string, count: number, active: boolean }"), [
      { name: "name", type: { kind: "scalar", type: "string" } },
      { name: "count", type: { kind: "scalar", type: "number" } },
      { name: "active", type: { kind: "scalar", type: "boolean" } },
    ]);
  });

  it("parses empty braces as no fields", () => {
    assert.deepEqual(ok("{ }"), []);
    assert.deepEqual(ok("{}"), []);
  });

  it("accepts case-insensitive scalar types", () => {
    assert.deepEqual(ok("{ a: String, b: NUMBER, c: Boolean }"), [
      { name: "a", type: { kind: "scalar", type: "string" } },
      { name: "b", type: { kind: "scalar", type: "number" } },
      { name: "c", type: { kind: "scalar", type: "boolean" } },
    ]);
  });

  it("keeps the legacy E_SCHEMA code/messages for legacy failures", () => {
    assert.deepEqual(err(""), { code: "E_SCHEMA", message: "returns schema cannot be empty" });
    const unsupported = err("{ foo: object }");
    assert.equal(unsupported.code, "E_SCHEMA");
    assert.match(unsupported.message, /unsupported type in returns schema: "object"/);
    const malformed = err("{ badentry }");
    assert.equal(malformed.code, "E_SCHEMA");
    assert.match(malformed.message, /invalid returns schema entry: expected/);
  });
});

describe("parseReturnsSchema — string enums", () => {
  it("parses a union of string literals", () => {
    assert.deepEqual(ok('{ status: "approve" | "reject" | "unsure" }'), [
      { name: "status", type: { kind: "enum", values: ["approve", "reject", "unsure"] } },
    ]);
  });

  it("parses a single-literal enum", () => {
    assert.deepEqual(ok('{ status: "approve" }'), [
      { name: "status", type: { kind: "enum", values: ["approve"] } },
    ]);
  });

  it("rejects a trailing pipe as E_PARSE", () => {
    const r = err('{ status: "a" | }');
    assert.equal(r.code, "E_PARSE");
    assert.match(r.message, /empty option/);
  });

  it("rejects an unquoted union (type-union) as E_PARSE", () => {
    const r = err("{ status: string | number }");
    assert.equal(r.code, "E_PARSE");
    assert.match(r.message, /quoted string literals/);
  });
});

describe("parseReturnsSchema — arrays of records", () => {
  it("parses an array of records with scalar + enum fields", () => {
    assert.deepEqual(
      ok('{ key_changes: [{ path: string, start: number, kind: "add" | "del" }] }'),
      [
        {
          name: "key_changes",
          type: {
            kind: "array",
            fields: [
              { name: "path", type: { kind: "scalar", type: "string" } },
              { name: "start", type: { kind: "scalar", type: "number" } },
              { name: "kind", type: { kind: "enum", values: ["add", "del"] } },
            ],
          },
        },
      ],
    );
  });

  it("keeps a sibling field after an array field (comma inside array not split)", () => {
    const f = ok("{ rows: [{ a: string, b: number }], ok: boolean }");
    assert.equal(f.length, 2);
    assert.equal(f[1]!.name, "ok");
  });

  it("rejects postfix [] as E_PARSE", () => {
    const r = err("{ items: string[] }");
    assert.equal(r.code, "E_PARSE");
  });

  it("rejects a nested array [[…]] as E_PARSE", () => {
    const r = err("{ xs: [[{ a: string }]] }");
    assert.equal(r.code, "E_PARSE");
    assert.match(r.message, /nested arrays/);
  });

  it("rejects a record inside a record as E_PARSE", () => {
    const r = err("{ xs: [{ a: { b: string } }] }");
    assert.equal(r.code, "E_PARSE");
    assert.match(r.message, /record inside a record/);
  });

  it("rejects an array not wrapping a single record as E_PARSE", () => {
    assert.equal(err("{ xs: [string] }").code, "E_PARSE");
  });
});

describe("schemaFieldNames", () => {
  it("lists top-level names including enum and array fields", () => {
    assert.deepEqual(
      schemaFieldNames('{ status: "a" | "b", key_changes: [{ path: string, note: string }], n: number }'),
      ["status", "key_changes", "n"],
    );
  });

  it("returns [] for empty schema and never throws on malformed input", () => {
    assert.deepEqual(schemaFieldNames("{}"), []);
    assert.deepEqual(schemaFieldNames("{ garbage }"), []);
    assert.doesNotThrow(() => schemaFieldNames("{ x: "));
  });
});
