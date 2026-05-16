import { dedentCommonLeadingWhitespace } from "./dedent";
import { fail } from "./core";

/** Per language.md: trim blank lines adjacent to opening/closing `"""` only — do not dedent inner margin. */
export function trimAdjacentBlankLines(text: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

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
      return { body: joinTripleQuoteBody(bodyLines), nextIdx: i + 1, afterClose };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, 'unterminated triple-quoted block: no closing """ before end of file', lineNo);
}

function joinTripleQuoteBody(bodyLines: string[]): string {
  return trimAdjacentBlankLines(bodyLines.join("\n"));
}

/**
 * Wrap a triple-quoted body into the internal escaped-quoted format used by the runtime.
 * Returns `"escaped body"` with `\` and `"` properly escaped.
 */
export function tripleQuoteBodyToRaw(body: string): string {
  return `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Apply common-leading-whitespace dedent to a triple-quoted body. The parser
 * applies this so the semantic AST string carries the runtime-ready form;
 * runtime & validator stop needing a `tripleQuoted` flag.
 */
export function dedentTripleQuotedBody(body: string): string {
  return dedentCommonLeadingWhitespace(body);
}

/**
 * Helper for step parsers: when a step argument starts with `"""`, splice it back
 * onto the source line and parse the triple-quoted block. Errors if any content
 * trails the closing `"""`. Returns the message body and the next source index.
 */
export function consumeTripleQuotedArg(
  filePath: string,
  lines: string[],
  idx: number,
  arg: string,
): { body: string; nextIdx: number } {
  const tqLines = [...lines];
  tqLines[idx] = arg;
  const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
  if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
  return { body, nextIdx };
}
