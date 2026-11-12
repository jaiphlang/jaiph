import { dedentCommonLeadingWhitespace } from "./dedent";
import { decodeQuotedInner, fail } from "./core";
import { BodyCursor } from "./body-cursor";
import type { Token } from "./lexer";

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
  return readTripleQuoteBlock(filePath, lines, tripleQuoteLineIdx, lines[tripleQuoteLineIdx]!);
}

/**
 * Read the `"""` block that opens at the end of line `idx`. `openText` is the
 * line's text from the opening quotes on (a step argument such as the text
 * after `log `). The block is one `triple_string` token: its body is the lines
 * between the quotes, blank lines next to either trimmed; `afterClose` is the
 * rest of the closing line (trimmed) and `nextIdx` the line after it.
 */
export function readTripleQuoteBlock(
  filePath: string,
  lines: string[],
  idx: number,
  openText: string,
): { body: string; nextIdx: number; afterClose: string } {
  const lineNo = idx + 1;
  const openLine = openText.trim();

  if (!openLine.startsWith('"""')) {
    fail(filePath, 'expected opening triple-quote """', lineNo);
  }
  if (openLine.slice(3).trim().length > 0) {
    fail(filePath, 'opening """ must not have content on the same line', lineNo);
  }

  const cursor = BodyCursor.of(filePath, lines);
  let tok: Token;
  try {
    tok = cursor.tokenAt(idx, lines[idx]!.trimEnd().length - 2);
  } catch {
    tok = { kind: "other", text: "", line: lineNo, col: 1, offset: 0 };
  }
  if (tok.kind !== "triple_string") {
    fail(filePath, 'unterminated triple-quoted block: no closing """ before end of file', lineNo);
  }
  const bodyLines = tok.text.split("\n").slice(1, -1);
  return {
    body: joinTripleQuoteBody(bodyLines),
    nextIdx: BodyCursor.endLineIdx(tok) + 1,
    afterClose: cursor.textAfter(tok).trim(),
  };
}

function joinTripleQuoteBody(bodyLines: string[]): string {
  return trimAdjacentBlankLines(bodyLines.join("\n"));
}

/**
 * Wrap a triple-quoted body as a string literal's stored form: the same form a
 * single-line `"…"` string has — outer quotes, `"` written as `\"`, every other
 * character (backslashes included) as is. `literalText` reverses it.
 */
export function tripleQuoteBodyToRaw(body: string): string {
  return `"${body.replace(/"/g, '\\"')}"`;
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
 * Canonicalize a triple-quoted body that was stored in `tripleQuoteBodyToRaw`
 * (`"…escaped…"`) form. Used by match-arm bodies, which still carry their own
 * `tripleQuotedBody` flag instead of being dedented at parse time. The runtime
 * and the validator share this helper so that "what the runtime executes" and
 * "what the validator inspects" are bit-for-bit identical.
 */
export function canonicalizeTripleQuotedString(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = decodeQuotedInner(raw.slice(1, -1));
  return tripleQuoteBodyToRaw(dedentCommonLeadingWhitespace(inner));
}

/**
 * Helper for step parsers: a step argument `arg` that starts with `"""` on line
 * `idx`. Errors if any content trails the closing `"""`. Returns the message
 * body and the next source index.
 */
export function consumeTripleQuotedArg(
  filePath: string,
  lines: string[],
  idx: number,
  arg: string,
): { body: string; nextIdx: number } {
  const { body, nextIdx, afterClose } = readTripleQuoteBlock(filePath, lines, idx, arg);
  if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
  return { body, nextIdx };
}
