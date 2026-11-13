import type { EnvDeclDef } from "../types";
import { CONST_DECL_SHAPE_MESSAGE, decodeQuotedInner, fail, SINGLE_QUOTE_MESSAGE } from "./core";
import type { BodyCursor } from "./body-cursor";
import { readTripleQuoteBlock } from "./triple-quote";

/** Module-level `const NAME = VALUE` on the line at `at`. */
export function parseEnvDecl(cursor: BodyCursor, at: number): { envDecl: EnvDeclDef; next: number } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const raw = cursor.text(at);
  const toks = cursor.lineTokensOf(at);
  const [kw, nameTok, eqTok] = toks;

  // const NAME = "value" | """…""" | barevalue
  if (kw?.text !== "const" || nameTok?.kind !== "ident" || !eqTok?.text.startsWith("=")) {
    fail(filePath, CONST_DECL_SHAPE_MESSAGE, lineNo);
  }
  // Exactly one `=` is required after the name; `==` (or any other `=`-operator
  // token) is a const-shape error at the operator's column — same rule as a def
  // body (tryParseConst in stmt-invoke.ts).
  if (eqTok.text !== "=") {
    fail(filePath, CONST_DECL_SHAPE_MESSAGE, lineNo, eqTok.col);
  }
  const name = nameTok.text;
  const loc = { line: lineNo, col: 1 };
  // The value is everything after the `=`.
  const valuePart = raw.slice(eqTok.col).trim();
  const value = toks.slice(3);
  const first = value[0];

  // Triple-quoted multiline string
  if (first?.text === '"""') {
    const { body, next, closeLine, afterClose } = readTripleQuoteBlock(cursor, at, valuePart);
    if (afterClose.length > 0) {
      fail(filePath, 'unexpected content after closing """ in const declaration', closeLine);
    }
    return {
      envDecl: { name, value: body, loc, wasQuoted: true, tripleQuoted: true },
      next,
    };
  }

  // Double-quoted string (single-line only)
  if (first?.kind === "string") {
    if (value.length > 1) {
      fail(filePath, "unexpected content after closing quote in const declaration", lineNo);
    }
    return {
      envDecl: { name, value: decodeQuotedInner(first.text.slice(1, -1)), loc, wasQuoted: true },
      next: cursor.next(at),
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
    next: cursor.next(at),
  };
}
