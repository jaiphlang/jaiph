// Schema validation for typed prompts (returns '{ field: type }').
//
// The schema grammar and its parser live in the shared leaf `src/prompt-schema.ts`
// (also used by the compiler). This file owns the two runtime-only concerns:
// extracting a JSON object from the agent's raw text, and validating / describing
// that object against the parsed schema.

import type { FieldType, RecordFieldType, SchemaField } from "../../prompt-schema";

/**
 * Index just past the `}` that closes the `{` at `from`, ignoring braces inside
 * JSON string literals (`"…"` with backslash escapes); -1 if it never closes.
 */
function balancedObjectEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Try to extract a JSON object from the raw prompt response using multiple strategies. */
export function extractJson(raw: string): { obj: Record<string, unknown>; source: string } | null {
  const lines = raw.split(/\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  const fence = "```";
  const fencedPattern = new RegExp(fence + "(?:json)?\\s*([\\s\\S]*?)" + fence, "gi");
  const fencedMatches = [...raw.matchAll(fencedPattern)];
  const fencedJson = fencedMatches.length > 0 ? String(fencedMatches[fencedMatches.length - 1][1] || "").trim() : "";
  const objectLine = [...lines].reverse().map((l) => l.trim()).find((l) => l.startsWith("{") && l.endsWith("}")) || "";
  const embeddedJson = (() => {
    for (const line of [...lines].reverse()) {
      const trimmed = line.trim();
      const startIdx = trimmed.indexOf("{");
      if (startIdx > 0) {
        const endIdx = trimmed.lastIndexOf("}");
        if (endIdx > startIdx) return trimmed.slice(startIdx, endIdx + 1);
      }
    }
    return "";
  })();
  // Scan lines from the end; on the first line holding a JSON object, take the
  // LONGEST object that parses. Prose before the answer can contain a small
  // parseable object (`{ }`, `{"a":1}`), and the answer itself can contain braces
  // inside string values, so: count braces outside JSON strings only, and prefer
  // the largest object on the line over the first one found.
  const balancedObject = (() => {
    for (const line of [...lines].reverse()) {
      const trimmed = line.trim();
      let best = "";
      for (let from = trimmed.indexOf("{"); from >= 0; from = trimmed.indexOf("{", from + 1)) {
        const end = balancedObjectEnd(trimmed, from);
        if (end < 0 || end - from <= best.length) continue;
        const slice = trimmed.slice(from, end);
        try {
          const o = JSON.parse(slice);
          if (typeof o === "object" && o !== null && !Array.isArray(o)) best = slice;
        } catch { /* not JSON; try the next "{" */ }
      }
      if (best) return best;
    }
    return "";
  })();

  const candidates = [balancedObject, lastLine, fencedJson, objectLine, embeddedJson]
    .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

  let parseError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return { obj: obj as Record<string, unknown>, source: candidate };
      }
    } catch (e) {
      parseError = e as Error;
    }
  }

  if (parseError) {
    process.stderr.write(`jaiph: prompt returned invalid JSON (parse error): ${parseError.message}\n`);
    process.stderr.write(`Last line: ${lastLine.slice(0, 200)}${lastLine.length > 200 ? "..." : ""}\n`);
  } else {
    process.stderr.write("jaiph: prompt returned invalid JSON: root must be an object\n");
  }
  return null;
}

/** Name a JSON value's type the way the agent sees it (array/null distinguished). */
function typeName(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function checkScalar(path: string, v: unknown, type: "string" | "number" | "boolean"): string | null {
  if (typeof v === type) return null;
  return `prompt response field "${path}" expected ${type}, got ${typeName(v)}`;
}

function checkEnum(path: string, v: unknown, values: string[]): string | null {
  const allowed = values.map((x) => `"${x}"`).join(" | ");
  if (typeof v !== "string") {
    return `prompt response field "${path}" expected one of ${allowed}, got ${typeName(v)}`;
  }
  if (!values.includes(v)) {
    return `prompt response field "${path}" must be one of ${allowed}, got "${v}"`;
  }
  return null;
}

function checkScalarOrEnum(path: string, v: unknown, type: RecordFieldType): string | null {
  return type.kind === "enum" ? checkEnum(path, v, type.values) : checkScalar(path, v, type.type);
}

function checkField(path: string, v: unknown, type: FieldType): string | null {
  if (type.kind !== "array") return checkScalarOrEnum(path, v, type);
  if (!Array.isArray(v)) {
    return `prompt response field "${path}" expected an array, got ${typeName(v)}`;
  }
  for (let i = 0; i < v.length; i += 1) {
    const el = v[i];
    if (el === null || typeof el !== "object" || Array.isArray(el)) {
      return `prompt response field "${path}[${i}]" expected an object, got ${typeName(el)}`;
    }
    const rec = el as Record<string, unknown>;
    for (const rf of type.fields) {
      const rp = `${path}[${i}].${rf.name}`;
      if (!(rf.name in rec)) return `prompt response field "${rp}" is missing`;
      const err = checkScalarOrEnum(rp, rec[rf.name], rf.type);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Validate a parsed JSON object against the schema. Returns `null` on success
 * or a message naming the offending field / path, the value, and (for enums)
 * the allowed literals. A non-null result is a deterministic post-processing
 * failure and is not retried.
 */
export function validateSchema(obj: Record<string, unknown>, fields: SchemaField[]): string | null {
  for (const f of fields) {
    if (!(f.name in obj)) return `prompt response missing required field: ${f.name}`;
    const err = checkField(f.name, obj[f.name], f.type);
    if (err) return err;
  }
  return null;
}

function describeType(type: FieldType): string {
  if (type.kind === "scalar") return type.type;
  if (type.kind === "enum") return `one of ${type.values.map((v) => `"${v}"`).join(", ")}`;
  const inner = type.fields
    .map((rf) => `${rf.name}: ${rf.type.kind === "enum" ? `one of ${rf.type.values.map((v) => `"${v}"`).join(", ")}` : rf.type.type}`)
    .join(", ");
  return `an array of objects, each with { ${inner} }`;
}

/**
 * The instruction appended to the prompt body telling the agent what JSON to
 * return. Enums and arrays are described in plain words so agents produce them
 * reliably.
 */
export function describeSchema(fields: SchemaField[]): string {
  const head = "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation)";
  if (fields.length === 0) return `${head}: {}`;
  const lines = fields.map((f) => `- ${f.name}: ${describeType(f.type)}`);
  return `${head} with these fields:\n${lines.join("\n")}`;
}
