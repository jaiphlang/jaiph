import { dedentCommonLeadingWhitespace } from "./dedent";
import { decodeQuotedInner, fail } from "./core";
import type { BodyCursor } from "./body-cursor";
import type { Token } from "./lexer";
import { checkFenceOpener, dedentFencedScriptBody, UNTERMINATED_FENCE_MESSAGE } from "./fence";

/** Per language.md: trim blank lines adjacent to opening/closing `"""` only — do not dedent inner margin. */
function trimAdjacentBlankLines(text: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

/** The text between a block token's opening and closing lines. */
function blockLines(tok: Token): string {
  return tok.text.split("\n").slice(1, -1).join("\n");
}

/** A `"""` token's body: the lines between its quotes, blank lines next to either trimmed. */
export function blockBody(tok: Token): string {
  return trimAdjacentBlankLines(blockLines(tok));
}

/**
 * Where a block token ends: the position (`closeAt`) and 1-based number
 * (`closeLine`) of its closing line, and the position after that line.
 */
export type BlockEnd = { closeAt: number; closeLine: number; next: number };

function blockEnd(cursor: BodyCursor, tok: Token): BlockEnd {
  const closeAt = cursor.closeOf(tok);
  return { closeAt, closeLine: cursor.lineNo(closeAt), next: cursor.next(closeAt) };
}

/** The block token that opens at the end of the line at `at` (its last three characters), if it lexes. */
function blockOpeningAt(cursor: BodyCursor, at: number): Token | undefined {
  try {
    return cursor.tokenAt(at, cursor.text(at).trimEnd().length - 2);
  } catch {
    return undefined;
  }
}

/**
 * Read the `"""` block that opens at the end of the line at `at`. `openText`
 * is the line's text from the opening quotes on (a step argument such as the
 * text after `log `). The block is one `triple_string` token: its body is the
 * lines between the quotes, blank lines next to either trimmed; `afterClose`
 * is the rest of the closing line (trimmed).
 */
export function readTripleQuoteBlock(
  cursor: BodyCursor,
  at: number,
  openText: string,
): BlockEnd & { body: string; afterClose: string } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const openLine = openText.trim();

  if (!openLine.startsWith('"""')) {
    fail(filePath, 'expected opening triple-quote """', lineNo);
  }
  if (openLine.slice(3).trim().length > 0) {
    fail(filePath, 'opening """ must not have content on the same line', lineNo);
  }

  const tok = blockOpeningAt(cursor, at);
  if (tok?.kind !== "triple_string") {
    fail(filePath, 'unterminated triple-quoted block: no closing """ before end of file', lineNo);
  }
  return { body: blockBody(tok), afterClose: cursor.textAfter(tok).trim(), ...blockEnd(cursor, tok) };
}

/**
 * Read the `'''` block that opens at the end of the line at `at`; `openText`
 * is the line's text from the opening quotes on (interpreter tag split off).
 * The block is one `script_fenced` token: its body is the lines between the
 * quotes, dedented; `afterClose` is the rest of the closing line.
 */
export function readFencedScript(
  cursor: BodyCursor,
  at: number,
  openText: string,
): BlockEnd & { body: string; afterClose: string } {
  const lineNo = cursor.lineNo(at);
  checkFenceOpener(cursor.filePath, openText.trim(), lineNo);
  const tok = blockOpeningAt(cursor, at);
  if (tok?.kind !== "script_fenced") fail(cursor.filePath, UNTERMINATED_FENCE_MESSAGE, lineNo);
  return {
    body: dedentFencedScriptBody(blockLines(tok)),
    afterClose: cursor.textAfter(tok).trimEnd(),
    ...blockEnd(cursor, tok),
  };
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
 * Helper for step parsers: a step argument `arg` that starts with `"""` on the
 * line at `at`. Errors if any content trails the closing `"""`. Returns the
 * message body and the position after the block.
 */
export function consumeTripleQuotedArg(cursor: BodyCursor, at: number, arg: string): { body: string; next: number } {
  const { body, next, closeLine, afterClose } = readTripleQuoteBlock(cursor, at, arg);
  if (afterClose) fail(cursor.filePath, 'unexpected content after closing """', closeLine);
  return { body, next };
}
