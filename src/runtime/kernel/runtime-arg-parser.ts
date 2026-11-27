/**
 * Stateless parsing/formatting helpers for the Node workflow runtime.
 *
 * Pure functions only — no I/O, no class state. The runtime composes these to
 * resolve interpolated strings and sanitize names. (Call arguments are
 * evaluated from typed `Arg[]` directly in the runtime; there is no
 * argument-string tokenizer here. The `returns` schema grammar lives in the
 * shared leaf `src/prompt-schema.ts`.)
 */
import { interpolate } from "../../config";
import { formatUtcTimestamp } from "./emit";

// `interpolate` lives in the config layer (config resolution reuses it); the
// runtime imports it downward and re-exports it so kernel callers keep a single
// import site here.
export { interpolate };

export const MAX_EMBED = 1024 * 1024;
export const MAX_RECURSION_DEPTH = 256;

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
