/**
 * Stateless parsing/formatting helpers for the Node workflow runtime.
 *
 * Pure functions only — no I/O, no class state. The runtime composes these to
 * resolve interpolated strings, parse call argument lists (including managed
 * `run`/`ensure` and inline-script forms), and validate prompt return schemas.
 */
import { parseCallRef } from "../../parse/core";
import { formatUtcTimestamp } from "./emit";

export const BARE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_EMBED = 1024 * 1024;
export const MAX_RECURSION_DEPTH = 256;

export type ParsedArgToken =
  | { kind: "literal"; value: string }
  | { kind: "managed"; managedKind: "run" | "ensure"; ref: string; argsRaw: string }
  | { kind: "managed_inline_script"; body: string; lang?: string; argsRaw: string };

export type PromptSchemaField = { name: string; type: "string" | "number" | "boolean" };

export function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function nowIso(): string {
  return formatUtcTimestamp();
}

export function interpolate(input: string, vars: Map<string, string>, env?: NodeJS.ProcessEnv): string {
  const lookup = (key: string): string => vars.get(key) ?? env?.[key] ?? "";
  return input.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\}/g, (_m, base, field) => {
    if (!field) return lookup(String(base));
    // Dot field access: parse JSON stored in the base variable and extract the field.
    const raw = lookup(String(base));
    try {
      const obj = JSON.parse(raw);
      return obj != null && typeof obj === "object" && field in obj ? String(obj[field]) : "";
    } catch {
      return "";
    }
  });
}

/** Body after "run" / "ensure" in ${run ...} / ${ensure ...} (e.g. greet(), greet(x), or greet x). */
export function parseInlineCaptureCall(body: string): { ref: string; argsRaw: string } {
  const trimmed = body.trim();
  const paren = trimmed.match(/^([\w.]+)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    return { ref: paren[1], argsRaw: paren[2].trim() };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { ref: trimmed, argsRaw: "" };
  }
  return { ref: trimmed.slice(0, spaceIdx), argsRaw: trimmed.slice(spaceIdx + 1).trim() };
}

/** Convert comma-separated call args (as written in source) to space-separated form with bare identifiers wrapped in ${…}. */
export function commaArgsToInterpolated(raw: string): string {
  if (!raw.trim()) return "";
  return raw.split(",").map((seg) => {
    const t = seg.trim();
    return BARE_IDENT_RE.test(t) ? `\${${t}}` : t;
  }).join(" ");
}

export function parseArgsRaw(raw: string, vars: Map<string, string>, env?: NodeJS.ProcessEnv): string[] {
  if (!raw.trim()) return [];
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(interpolate(cur, vars, env));
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) {
    out.push(interpolate(cur, vars, env));
  }
  return out;
}

/** Try to parse `\`body\`(args)` from a string at a given position. */
export function parseInlineScriptAt(s: string): { body: string; argsRaw: string; consumed: number } | null {
  const t = s.trimStart();
  const skippedWs = s.length - t.length;
  if (!t.startsWith("`")) return null;
  const closeIdx = t.indexOf("`", 1);
  if (closeIdx === -1) return null;
  const body = t.slice(1, closeIdx);
  const afterClose = t.slice(closeIdx + 1);
  if (!afterClose.startsWith("(")) return null;
  let depth = 1;
  let i = 1;
  let inQuote: string | null = null;
  while (i < afterClose.length && depth > 0) {
    const ch = afterClose[i];
    if (inQuote) {
      if (ch === inQuote && afterClose[i - 1] !== "\\") inQuote = null;
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  const argsContent = afterClose.slice(1, i - 1).trim();
  return { body, argsRaw: argsContent, consumed: skippedWs + closeIdx + 1 + i };
}

export function parseManagedArgAt(raw: string, start: number): { token: ParsedArgToken; next: number } | null {
  const tail = raw.slice(start);
  const keyword = tail.startsWith("run ")
    ? "run"
    : tail.startsWith("ensure ")
      ? "ensure"
      : null;
  if (!keyword) return null;
  const afterKeyword = raw.slice(start + keyword.length).trimStart();
  const skipped = raw.slice(start + keyword.length).length - afterKeyword.length;
  const call = parseCallRef(afterKeyword);
  if (call && (call.rest.length === 0 || /^\s/.test(call.rest))) {
    const consumed = afterKeyword.length - call.rest.length;
    return {
      token: {
        kind: "managed",
        managedKind: keyword,
        ref: call.ref,
        argsRaw: call.args ?? "",
      },
      next: start + keyword.length + skipped + consumed,
    };
  }
  // Try inline script form: run `body`(args)
  if (keyword === "run") {
    const inlineResult = parseInlineScriptAt(afterKeyword);
    if (inlineResult) {
      return {
        token: {
          kind: "managed_inline_script",
          body: inlineResult.body,
          argsRaw: inlineResult.argsRaw,
        },
        next: start + keyword.length + skipped + inlineResult.consumed,
      };
    }
  }
  return null;
}

export function parseArgTokens(raw: string): ParsedArgToken[] {
  if (!raw.trim()) return [];
  const out: ParsedArgToken[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    if (i >= raw.length) break;
    const managed = parseManagedArgAt(raw, i);
    if (managed) {
      out.push(managed.token);
      i = managed.next;
      continue;
    }
    let cur = "";
    let quote: "'" | '"' | null = null;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          cur += ch;
        }
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        i += 1;
        continue;
      }
      if (/\s/.test(ch)) {
        break;
      }
      cur += ch;
      i += 1;
    }
    if (cur.length > 0) {
      out.push({ kind: "literal", value: cur });
    }
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
