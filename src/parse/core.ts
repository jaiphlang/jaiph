import { jaiphError } from "../errors";
import type { Arg } from "../types";

export function fail(filePath: string, message: string, lineNo: number, col = 1): never {
  throw jaiphError(filePath, lineNo, col, "E_PARSE", message);
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === `"` && last === `"`) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function isRef(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(value);
}

export function hasUnescapedClosingQuote(text: string, startIndex: number): boolean {
  for (let i = startIndex; i < text.length; i += 1) {
    if (text[i] === `"` && text[i - 1] !== `\\`) {
      return true;
    }
  }
  return false;
}

/** Index of the first unescaped double-quote at or after startIndex, or -1. */
export function indexOfClosingDoubleQuote(text: string, startIndex: number): number {
  for (let i = startIndex; i < text.length; i += 1) {
    if (text[i] === `"` && text[i - 1] !== `\\`) {
      return i;
    }
  }
  return -1;
}

export function colFromRaw(raw: string): number {
  return (raw.match(/\S/)?.index ?? 0) + 1;
}

/**
 * Parse a single-backtick body `…` from the start of `text`.
 * Errors if missing closing backtick or if the body spans multiple lines.
 * Returns the body and the text remaining after the closing backtick.
 */
export function parseSingleBacktickBody(
  text: string,
  filePath: string,
  lineNo: number,
  col: number,
): { body: string; restAfterClose: string } {
  const closeIdx = text.indexOf("`", 1);
  if (closeIdx === -1) {
    fail(filePath, "unterminated inline script backtick — missing closing `", lineNo, col);
  }
  const body = text.slice(1, closeIdx);
  if (body.includes("\n")) {
    fail(filePath, "single backtick script body must be one line — use triple backtick for multiline", lineNo, col);
  }
  return { body, restAfterClose: text.slice(closeIdx + 1) };
}

/** Reject non-empty trailing content after a call expression (e.g. shell redirection). */
export function rejectTrailingContent(
  filePath: string,
  lineNo: number,
  keyword: string,
  rest: string,
): void {
  const trimmed = rest.trim();
  if (!trimmed) return;
  fail(filePath, `unexpected content after ${keyword} call: '${trimmed}'; shell redirection (>, |, &) is not supported — use a script block`, lineNo);
}

/** Count brace depth change for a line (ignores quotes; used for inline { ... } in rule/workflow bodies). */
export function braceDepthDelta(line: string): number {
  let delta = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "{") delta += 1;
    else if (line[i] === "}") delta -= 1;
  }
  return delta;
}

/** Jaiph keywords that cannot be used as bare identifier arguments. */
const JAIPH_KEYWORDS = new Set([
  "run", "ensure", "prompt", "return", "fail", "log", "logerr", "logwarn",
  "if", "else", "not", "const", "match", "import", "export",
  "workflow", "rule", "script", "channel", "config", "catch", "async",
  "returns", "send", "true", "false", "for", "in",
]);

/** Check if a token is a bare identifier (valid identifier, not a keyword). */
export function isBareIdentifier(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !JAIPH_KEYWORDS.has(token);
}

/**
 * Bare `IDENT.IDENT` (typed-prompt field access sugar).
 * Same shape as return / if / match subjects — not a module-qualified call ref.
 */
export function isBareDottedIdentifier(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

/** True when a token is a bare Jaiph interpolation ref: `${name}` or `${name.field}`. */
export function isJaiphInterpolationRef(token: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}$/.test(token);
}

/**
 * Parse `log` / `logerr` / `logwarn` RHS: either a double-quoted string, a single bare identifier,
 * or a bare `${name}` / `${name.field}` interpolation ref (stored as-is).
 */
export function parseLogMessageRhs(
  filePath: string,
  lineNo: number,
  keywordCol: number,
  logArg: string,
  keyword: "log" | "logerr" | "logwarn",
): string {
  const trimmed = logArg.trim();
  if (trimmed.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(logArg, 1);
    if (closeIdx === -1) {
      fail(filePath, `unterminated ${keyword} string`, lineNo, keywordCol);
    }
    const trailing = logArg.slice(closeIdx + 1).trim();
    if (trailing) {
      fail(filePath, `unexpected content after ${keyword} string: '${trailing}'`, lineNo, keywordCol);
    }
    return logArg.slice(1, closeIdx);
  }
  if (isBareIdentifier(trimmed) && trimmed === logArg.trim()) {
    return `\${${trimmed}}`;
  }
  if (isJaiphInterpolationRef(trimmed)) {
    return trimmed;
  }
  fail(
    filePath,
    `${keyword} must match: ${keyword} "<message>" or ${keyword} <identifier>`,
    lineNo,
    keywordCol,
  );
}

/**
 * Parse a parenthesised parameter list from a definition header.
 * Input: the content between '(' and ')' (exclusive).
 * Returns validated, deduplicated parameter names.
 */
export function parseParamList(filePath: string, content: string, lineNo: number): string[] {
  if (!content.trim()) return [];
  const names = content.split(",").map((s) => s.trim());
  const seen = new Set<string>();
  for (const name of names) {
    if (!name) {
      fail(filePath, "empty parameter name in parameter list", lineNo);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(filePath, `invalid parameter name "${name}"; must be an identifier`, lineNo);
    }
    if (JAIPH_KEYWORDS.has(name)) {
      fail(filePath, `parameter name "${name}" is a reserved keyword`, lineNo);
    }
    if (seen.has(name)) {
      fail(filePath, `duplicate parameter name "${name}"`, lineNo);
    }
    seen.add(name);
  }
  return names;
}

/**
 * Split a comma-separated call argument list into typed `Arg[]`.
 *
 * Each top-level comma-separated segment is classified:
 * - bare identifier (and not a Jaiph keyword): `{ kind: "var", name }`
 * - bare `IDENT.IDENT` (typed-prompt field access): `{ kind: "var", name: "base.field" }`
 *   — sugar for `${base.field}`; runtime expands via the same JSON field path
 * - anything else (quoted string, ${…}, nested `run …` / `ensure …` call, inline-script
 *   form, etc.): `{ kind: "literal", raw }`, stored as authored.
 *
 * Commas inside quoted strings are preserved (the scanner tracks quote state).
 */
export function commaArgsToArgList(content: string): Arg[] {
  const out: Arg[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let j = 0; j < content.length; j++) {
    const ch = content[j];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && content[j - 1] !== "\\") inQuote = null;
    } else if (ch === ",") {
      pushArg(out, current);
      current = "";
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      current += ch;
    }
  }
  pushArg(out, current);
  return out;
}

function pushArg(out: Arg[], segment: string): void {
  const trimmed = segment.trim();
  if (!trimmed) return;
  if (isBareIdentifier(trimmed) || isBareDottedIdentifier(trimmed)) {
    out.push({ kind: "var", name: trimmed });
    return;
  }
  out.push({ kind: "literal", raw: trimmed });
}

/**
 * Convert `Arg[]` back to the space-separated string the runtime consumes:
 * - `var` → `${name}` (so runtime interpolation expands it against in-scope vars;
 *   dotted names become `${base.field}` and resolve via JSON field access)
 * - `literal` → raw as authored
 *
 * Empty / undefined → empty string.
 */
export function argsToRuntimeString(args: Arg[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.map((a) => (a.kind === "var" ? `\${${a.name}}` : a.raw)).join(" ");
}

/**
 * Parse a call expression `ref(args)` or `ref()` from a string.
 * Returns the ref, optional typed `Arg[]`, and the rest of the string after `)`.
 * Returns null if the string doesn't start with a valid call expression.
 */
export function parseCallRef(s: string): { ref: string; args?: Arg[]; rest: string } | null {
  const t = s.trimStart();
  // Parenthesized form: ref(args) or ref()
  const refMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(/);
  if (refMatch && isRef(refMatch[1])) {
    const ref = refMatch[1];
    const parenStart = refMatch[0].length;
    let depth = 1;
    let inQuote: string | null = null;
    let i = parenStart;
    while (i < t.length && depth > 0) {
      const ch = t[i];
      if (inQuote) {
        if (ch === inQuote && t[i - 1] !== "\\") inQuote = null;
      } else {
        if (ch === '"' || ch === "'") inQuote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      i++;
    }
    if (depth !== 0) return null;
    const argsContent = t.slice(parenStart, i - 1).trim();
    const rest = t.slice(i);
    if (!argsContent) return { ref, rest };
    const args = commaArgsToArgList(argsContent);
    return { ref, ...(args.length > 0 ? { args } : {}), rest };
  }
  // Bare identifier form (no parens) is no longer allowed — require parentheses.
  return null;
}

/**
 * Parse a parenthesized argument list `(args)` or `()` at the start of a string.
 * Returns typed `Arg[]` and remaining text after `)`. Returns null if the string
 * doesn't start with `(`.
 */
export function parseParenArgs(s: string): { args?: Arg[]; rest: string } | null {
  if (!s.trimStart().startsWith("(")) return null;
  const result = parseCallRef(`__anon${s.trimStart()}`);
  if (!result) return null;
  return { args: result.args, rest: result.rest };
}

/**
 * Match `channel <- command` when `<-` appears outside quoted strings.
 */
export function matchSendOperator(line: string): { rhsText: string; channel: string } | null {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && (inDoubleQuote || inSingleQuote)) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === "<" && line[i + 1] === "-") {
      const before = line.slice(0, i).trimEnd();
      const after = line.slice(i + 2).trimStart();
      const channelMatch = before.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/,
      );
      if (channelMatch) {
        return { rhsText: after, channel: channelMatch[1] };
      }
    }
  }
  return null;
}
