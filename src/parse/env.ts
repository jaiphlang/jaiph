import type { EnvDeclDef } from "../types";
import { decodeQuotedInner, fail, SINGLE_QUOTE_MESSAGE } from "./core";
import { BodyCursor } from "./body-cursor";
import { readTripleQuoteBlock } from "./triple-quote";

/** Module-level `const NAME = VALUE` on line `startIndex`. */
export function parseEnvDecl(
  filePath: string,
  lines: string[],
  startIndex: number,
): { envDecl: EnvDeclDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex]!;
  const toks = BodyCursor.of(filePath, lines).lineTokensOf(startIndex);
  const [kw, nameTok, eqTok] = toks;

  // const NAME = "value" | """…""" | barevalue
  if (kw?.text !== "const" || nameTok?.kind !== "ident" || !eqTok?.text.startsWith("=")) {
    fail(filePath, 'invalid declaration — expected: const NAME = VALUE', lineNo);
  }
  const name = nameTok.text;
  const loc = { line: lineNo, col: 1 };
  // The value is everything after the first `=` (a `==` leaves a bare `= …`).
  const valuePart = raw.slice(eqTok.col).trim();
  const value = eqTok.text === "=" ? toks.slice(3) : [];
  const first = value[0];

  // Triple-quoted multiline string
  if (first?.text === '"""') {
    const { body, nextIdx, afterClose } = readTripleQuoteBlock(filePath, lines, startIndex, valuePart);
    if (afterClose.length > 0) {
      fail(filePath, 'unexpected content after closing """ in const declaration', nextIdx);
    }
    return {
      envDecl: { name, value: body, loc, wasQuoted: true, tripleQuoted: true },
      nextIndex: nextIdx,
    };
  }

  // Double-quoted string (single-line only)
  if (first?.kind === "string") {
    if (value.length > 1) {
      fail(filePath, "unexpected content after closing quote in const declaration", lineNo);
    }
    return {
      envDecl: { name, value: decodeQuotedInner(first.text.slice(1, -1)), loc, wasQuoted: true },
      nextIndex: startIndex + 1,
    };
  }
  if (first?.text === '"') {
    fail(filePath, 'multiline strings use triple quotes: const name = """...""""', lineNo);
  }

  if (first?.text.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  }

  // Bare value (rest of line)
  return {
    envDecl: { name, value: valuePart, loc },
    nextIndex: startIndex + 1,
  };
}
