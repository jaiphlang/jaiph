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

export function colFromRaw(raw: string): number {
  return (raw.match(/\S/)?.index ?? 0) + 1;
}
