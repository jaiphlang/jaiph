import type { Expr, DefRef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, isRef, rejectTrailingContent } from "./core";
import { SliceLexer } from "./slice-lexer";
import type { BodyCursor } from "./body-cursor";
import { parseCallRef } from "./call-args";
import { dedentTripleQuotedBody, readTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";

const SEND_RHS_HINT =
  'send right-hand side must be a quoted string ("..."), a variable ($name or ${...}), or a call "ref(args)" — not raw shell; use a script or use const';

/**
 * Parse the payload `rhs` of `send <payload> -> channel` on the line at `at`,
 * starting at column `col`. Returns the parsed payload as an `Expr` plus the
 * position after the statement.
 */
export function parseSendRhs(
  cursor: BodyCursor,
  at: number,
  rhs: string,
  col: number,
  trivia: Trivia = createTrivia(),
): { value: Expr; next: number } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const t = rhs.trim();
  const defaultNext = cursor.next(at);
  if (t === "") {
    fail(filePath, "use 'send <payload> -> <channel>'", lineNo, col);
  }
  if (t.startsWith('"""')) {
    const { body, next, closeLine, afterClose } = readTripleQuoteBlock(cursor, at, t);
    if (afterClose) fail(filePath, 'unexpected content after closing """', closeLine);
    const value: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
    trivia.setNode(value, { tripleQuoted: true, rawBody: body });
    return { value, next };
  }
  if (t.startsWith('"')) {
    const L = new SliceLexer(filePath, t, lineNo, col, 0);
    const str = L.at(0, { triple: "pair" })!;
    if (str.kind !== "string") {
      fail(filePath, 'multiline strings use triple quotes: send """...""" -> channel', lineNo, col);
    }
    if (L.at(L.end(str), { triple: "pair" })) {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    return { value: { kind: "literal", raw: str.text }, next: defaultNext };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*\(/.test(t)) {
    const call = parseCallRef(t);
    if (call) {
      rejectTrailingContent(filePath, lineNo, "send", call.rest);
      const callee: DefRef = { value: call.ref, loc: { line: lineNo, col } };
      return {
        value: { kind: "call", callee, ...(call.args ? { args: call.args } : {}) },
        next: defaultNext,
      };
    }
  }
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    return { value: { kind: "literal", raw: t }, next: defaultNext };
  }
  if (t.startsWith("${")) {
    let depth = 1;
    let i = 2;
    while (i < t.length && depth > 0) {
      const c = t[i];
      if (c === "$" && t[i + 1] === "{") {
        depth += 1;
        i += 2;
        continue;
      }
      if (c === "}") {
        depth -= 1;
        i += 1;
        continue;
      }
      i += 1;
    }
    if (depth !== 0) {
      fail(filePath, "unterminated ${...} in send right-hand side", lineNo, col);
    }
    const braced = t.slice(0, i);
    if (t.slice(i).trim() !== "") {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    if (braced.includes("$(")) {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    return { value: { kind: "literal", raw: braced }, next: defaultNext };
  }
  const bareWord = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/);
  if (bareWord && isRef(bareWord[1])) {
    return {
      value: { kind: "bare_ref", ref: { value: bareWord[1], loc: { line: lineNo, col } } },
      next: defaultNext,
    };
  }
  return {
    value: { kind: "shell", command: t, loc: { line: lineNo, col } },
    next: defaultNext,
  };
}
