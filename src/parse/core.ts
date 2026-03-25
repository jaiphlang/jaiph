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
