/**
 * Grammar and parser for a `prompt … returns "{ … }"` schema.
 *
 * Shared, layer-0 leaf (no imports, no I/O): the compile-time validator
 * (`src/transpile/validate-prompt-schema.ts`) parses the schema to turn a
 * malformed schema into a diagnostic, and the runtime
 * (`src/runtime/kernel/schema.ts` + `node-workflow-runtime.ts`) parses the
 * same string to describe the shape in the prompt and to validate the agent's
 * JSON. One parser, so the grammar lives in exactly one place.
 *
 * Grammar (after the `returns` string's `\"` escapes are decoded):
 *   schema    = "{" [ field ("," field)* ] "}"
 *   field     = NAME ":" type
 *   type      = scalar | enum | array
 *   scalar    = "string" | "number" | "boolean"        (case-insensitive)
 *   enum      = STRING ("|" STRING)*                    (quoted string literals)
 *   array     = "[" "{" [ rec_field ("," rec_field)* ] "}" "]"
 *   rec_field = NAME ":" (scalar | enum)               (one level of nesting)
 */

export type ScalarType = "string" | "number" | "boolean";

/** A field type usable inside an array record: a scalar or a string enum. */
export type RecordFieldType =
  | { kind: "scalar"; type: ScalarType }
  | { kind: "enum"; values: string[] };

export type RecordField = { name: string; type: RecordFieldType };

/** A top-level field type: scalar, string enum, or an array of records. */
export type FieldType = RecordFieldType | { kind: "array"; fields: RecordField[] };

export type SchemaField = { name: string; type: FieldType };

export type ParseResult =
  | { ok: true; fields: SchemaField[] }
  // `code` is the Jaiph error code the compiler should surface: legacy flat-schema
  // failures keep `E_SCHEMA`; the enum / array grammar failures are `E_PARSE`.
  | { ok: false; code: "E_PARSE" | "E_SCHEMA"; message: string };

const SCALARS = new Set<string>(["string", "number", "boolean"]);

/** Strip the outer `{ … }`, mirroring the historical lenient trimming. */
function stripBraces(raw: string): string {
  return raw.trim().replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
}

/**
 * Split `s` on `sep` only at bracket depth 0 and outside `"…"` string literals,
 * so a comma inside an array record (`[{ a: string, b: number }]`) or a `|`
 * inside a quoted enum value never splits the wrong level.
 */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === "[" || c === "{") {
      depth += 1;
      cur += c;
    } else if (c === "]" || c === "}") {
      depth -= 1;
      cur += c;
    } else if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

type TypeResult =
  | { ok: true; type: FieldType }
  | { ok: false; code: "E_PARSE" | "E_SCHEMA"; message: string };

function parseEnum(rest: string): TypeResult {
  const values: string[] = [];
  for (const raw of splitTop(rest, "|")) {
    const part = raw.trim();
    if (part.length === 0) {
      return {
        ok: false,
        code: "E_PARSE",
        message: 'enum has an empty option; list one or more quoted values like "a" | "b"',
      };
    }
    const m = part.match(/^"([^"]*)"$/);
    if (!m) {
      return {
        ok: false,
        code: "E_PARSE",
        message: `enum values must be quoted string literals (e.g. "a" | "b"); got ${part.slice(0, 40)}`,
      };
    }
    values.push(m[1]!);
  }
  return { ok: true, type: { kind: "enum", values } };
}

/** Parse a scalar or enum (the only forms allowed inside an array record). */
function parseScalarOrEnum(rest: string): TypeResult {
  const trimmed = rest.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return {
      ok: false,
      code: "E_PARSE",
      message:
        "a record inside a record is not allowed; array record fields must be string, number, boolean, or an enum",
    };
  }
  if (trimmed.startsWith('"') || splitTop(trimmed, "|").length > 1) {
    return parseEnum(trimmed);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
    if (trimmed.includes("[") || trimmed.includes("]")) {
      return {
        ok: false,
        code: "E_PARSE",
        message: "array fields use the form [{ field: type, … }]; postfix [] is not supported",
      };
    }
    return {
      ok: false,
      code: "E_SCHEMA",
      message: `unsupported type in returns schema: "${trimmed}" (only string, number, boolean allowed)`,
    };
  }
  const lower = trimmed.toLowerCase();
  if (!SCALARS.has(lower)) {
    return {
      ok: false,
      code: "E_SCHEMA",
      message: `unsupported type in returns schema: "${trimmed}" (only string, number, boolean allowed)`,
    };
  }
  return { ok: true, type: { kind: "scalar", type: lower as ScalarType } };
}

function parseArray(rest: string): TypeResult {
  const inner = rest.slice(1, -1).trim(); // between the outer [ ]
  if (inner.startsWith("[")) {
    return {
      ok: false,
      code: "E_PARSE",
      message: "nested arrays are not allowed; use a single record: [{ field: type, … }]",
    };
  }
  if (!inner.startsWith("{") || !inner.endsWith("}")) {
    return {
      ok: false,
      code: "E_PARSE",
      message: "an array field must contain a single record: [{ field: type, … }]",
    };
  }
  const recInner = inner.slice(1, -1).trim();
  const fields: RecordField[] = [];
  if (recInner.length > 0) {
    for (const partRaw of splitTop(recInner, ",")) {
      const part = partRaw.trim();
      const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/s);
      if (!m) {
        return {
          ok: false,
          code: "E_PARSE",
          message: `invalid array record field: expected "fieldName: type" (got ${part.slice(0, 40)}...)`,
        };
      }
      const res = parseScalarOrEnum(m[2]!);
      if (!res.ok) return res;
      fields.push({ name: m[1]!, type: res.type as RecordFieldType });
    }
  }
  return { ok: true, type: { kind: "array", fields } };
}

function parseType(rest: string): TypeResult {
  const trimmed = rest.trim();
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) {
      return {
        ok: false,
        code: "E_PARSE",
        message: "an array field must contain a single record: [{ field: type, … }]",
      };
    }
    return parseArray(trimmed);
  }
  if (trimmed.startsWith("{")) {
    return {
      ok: false,
      code: "E_PARSE",
      message: "a bare record is not a field type; wrap it in an array: [{ field: type, … }]",
    };
  }
  return parseScalarOrEnum(trimmed);
}

/**
 * Parse a `returns` schema string. On failure, `code` tells the compiler which
 * Jaiph error code to raise and `message` says what to change.
 */
export function parseReturnsSchema(raw: string): ParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, code: "E_SCHEMA", message: "returns schema cannot be empty" };
  }
  const inner = stripBraces(raw);
  if (inner.length === 0) return { ok: true, fields: [] };
  const fields: SchemaField[] = [];
  for (const partRaw of splitTop(inner, ",")) {
    const part = partRaw.trim();
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/s);
    if (!m || m[2]!.trim().length === 0) {
      return {
        ok: false,
        code: "E_SCHEMA",
        message: `invalid returns schema entry: expected "fieldName: type" (got ${part.slice(0, 40)}...)`,
      };
    }
    const res = parseType(m[2]!);
    if (!res.ok) return res;
    fields.push({ name: m[1]!, type: res.type });
  }
  return { ok: true, fields };
}

/**
 * Field names of a schema, best-effort and never throwing. Used while building
 * lexical scopes to type `${capture.field}` access; a malformed schema is
 * reported separately by `parseReturnsSchema` through the validator.
 */
export function schemaFieldNames(raw: string): string[] {
  const inner = stripBraces(raw);
  if (inner.length === 0) return [];
  const names: string[] = [];
  for (const partRaw of splitTop(inner, ",")) {
    const m = partRaw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (m) names.push(m[1]!);
  }
  return names;
}
