import { dedentCommonLeadingWhitespace } from "../parse/dedent";
import { tripleQuoteBodyToRaw } from "../parse/triple-quote";

/** Unescape inner text of a `tripleQuoteBodyToRaw`-shaped `"…"` token (same as format/emit decoders). */
function unescapeDslDoubleQuotedInner(inner: string): string {
  return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Values stored as `tripleQuoteBodyToRaw(parsedBody)` keep source indentation for the formatter.
 * At runtime, apply common-leading-whitespace removal (same as historical parse-time dedent).
 */
export function tripleQuotedRawForRuntime(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = unescapeDslDoubleQuotedInner(raw.slice(1, -1));
  return tripleQuoteBodyToRaw(dedentCommonLeadingWhitespace(inner));
}

/** Plain multiline text from `log """…"""` / `logerr` / `fail` (no surrounding quotes in AST). */
export function plainMultilineOrchestrationForRuntime(text: string): string {
  return dedentCommonLeadingWhitespace(text);
}
