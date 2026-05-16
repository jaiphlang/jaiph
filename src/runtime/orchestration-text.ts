import { dedentCommonLeadingWhitespace } from "../parse/dedent";
import { tripleQuoteBodyToRaw } from "../parse/triple-quote";

/** Unescape inner text of a `tripleQuoteBodyToRaw`-shaped `"…"` token (same as format/emit decoders). */
function unescapeDslDoubleQuotedInner(inner: string): string {
  return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Apply common-leading-whitespace dedent to a `tripleQuoteBodyToRaw`-encoded
 * value. Still used for match-arm bodies (which carry their own
 * `tripleQuotedBody` flag and are not part of the trivia split).
 */
export function tripleQuotedRawForRuntime(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = unescapeDslDoubleQuotedInner(raw.slice(1, -1));
  return tripleQuoteBodyToRaw(dedentCommonLeadingWhitespace(inner));
}
