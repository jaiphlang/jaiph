import { jaiphError } from "../errors";

export function fail(filePath: string, message: string, lineNo: number, col = 1): never {
  throw jaiphError(filePath, lineNo, col, "E_PARSE", message);
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
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

/** Count brace depth change for a line (ignores quotes; used for inline { ... } in rule/workflow bodies). */
export function braceDepthDelta(line: string): number {
  let delta = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "{") delta += 1;
    else if (line[i] === "}") delta -= 1;
  }
  return delta;
}

/**
 * Convert comma-separated call arguments to space-separated form for runtime.
 * Respects quoted strings so commas inside quotes are preserved.
 */
function commaArgsToSpaced(content: string): string {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let j = 0; j < content.length; j++) {
    const ch = content[j];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && content[j - 1] !== "\\") inQuote = null;
    } else if (ch === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((p) => p).join(" ");
}

/**
 * Parse a call expression `ref(args)` or `ref()` from a string.
 * Returns the ref, optional args (space-separated), and the rest of the string after `)`.
 * Returns null if the string doesn't start with a valid call expression.
 */
export function parseCallRef(s: string): { ref: string; args?: string; rest: string } | null {
  const t = s.trimStart();
  const refMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(/);
  if (!refMatch || !isRef(refMatch[1])) return null;
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
  const args = commaArgsToSpaced(argsContent);
  return { ref, args: args || undefined, rest };
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
