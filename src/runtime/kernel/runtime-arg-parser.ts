/**
 * Stateless parsing/formatting helpers for the Node workflow runtime.
 *
 * Pure functions only — no I/O, no class state. The runtime composes these to
 * resolve interpolated strings, sanitize names, and validate prompt return
 * schemas. (Call arguments are evaluated from typed `Arg[]` directly in the
 * runtime; there is no argument-string tokenizer here.)
 */
import { interpolate } from "../../config";
import { formatUtcTimestamp } from "./emit";

// `interpolate` lives in the config layer (config resolution reuses it); the
// runtime imports it downward and re-exports it so kernel callers keep a single
// import site here.
export { interpolate };

export const MAX_EMBED = 1024 * 1024;
export const MAX_RECURSION_DEPTH = 256;

export type PromptSchemaField = { name: string; type: "string" | "number" | "boolean" };

export function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function nowIso(): string {
  return formatUtcTimestamp();
}

/**
 * Decode one call-argument literal to the bytes passed to the child: quote
 * delimiters (`"` or `'`) are removed wherever they open/close, `\"` inside a
 * double-quoted span is a literal quote (Jaiph's one escape), and every other
 * character — including whitespace and an unquoted `${…}` to interpolate later —
 * is kept verbatim. This is the per-`Arg` form of the old argument tokenizer
 * (same quote handling), minus the whitespace split: one `Arg` yields one argv
 * element, so `foo("a", bar="b c")` passes `a` and `bar=b c` byte-exact.
 */
export function decodeCallArgLiteral(raw: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (quote === '"' && ch === "\\" && raw[i + 1] === '"') {
        out += '"';
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

export function stripOuterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parsePromptSchema(rawSchema: string): PromptSchemaField[] {
  const trimmed = rawSchema.trim();
  if (trimmed.length === 0) return [];
  if (/[[\]|]/.test(trimmed)) {
    throw new Error("returns schema must be flat (no arrays or union types)");
  }
  const inner = trimmed.replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (inner.length === 0) return [];
  const fields: PromptSchemaField[] = [];
  for (const part of inner.split(",")) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)\s*$/);
    if (!m) {
      throw new Error(`invalid returns schema entry: ${part.trim().slice(0, 40)}`);
    }
    const [, name, typeStr] = m;
    const type = typeStr.toLowerCase();
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new Error(`unsupported returns schema type: ${typeStr}`);
    }
    fields.push({ name, type: type as "string" | "number" | "boolean" });
  }
  return fields;
}
