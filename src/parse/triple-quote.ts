import { fail } from "./core";

/**
 * Parse a triple-quoted string block (`"""..."""`).
 * Opening `"""` must be at the start of `lines[tripleQuoteLineIdx]` (trimmed).
 * Returns the body string, next line index, and any text after the closing `"""`.
 */
export function parseTripleQuoteBlock(
  filePath: string,
  lines: string[],
  tripleQuoteLineIdx: number,
): { body: string; nextIdx: number; afterClose: string } {
  const lineNo = tripleQuoteLineIdx + 1;
  const openLine = lines[tripleQuoteLineIdx].trim();

  if (!openLine.startsWith('"""')) {
    fail(filePath, 'expected opening triple-quote """', lineNo);
  }
  const afterOpen = openLine.slice(3);
  if (afterOpen.trim().length > 0) {
    fail(filePath, 'opening """ must not have content on the same line', lineNo);
  }

  const bodyLines: string[] = [];
  let i = tripleQuoteLineIdx + 1;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('"""')) {
      const afterClose = trimmed.slice(3).trim();
      return { body: bodyLines.join("\n"), nextIdx: i + 1, afterClose };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, 'unterminated triple-quoted block: no closing """ before end of file', lineNo);
}

/**
 * Wrap a triple-quoted body into the internal escaped-quoted format used by the runtime.
 * Returns `"escaped body"` with `\` and `"` properly escaped.
 */
export function tripleQuoteBodyToRaw(body: string): string {
  return `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
