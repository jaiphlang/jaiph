import type { MatchArmDef, MatchExprDef, MatchPatternDef } from "../types";
import { fail } from "./core";
import { isPunct, type BodyCursor } from "./body-cursor";
import { compactClose, parseCompactMatchArms, parseMatchArms } from "./match-arms";

export { parseMatchArms } from "./match-arms";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOT_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate that a match subject is a bare identifier or `IDENT.IDENT`
 * (typed prompt capture field). Dot-field resolution and schema enforcement
 * happen in the validator, mirroring `${var.field}` interpolation.
 */
function validateMatchSubject(filePath: string, subject: string, lineNo: number): void {
  if (subject.startsWith("${") || subject.startsWith("$")) {
    fail(filePath, `match subject should be a bare identifier: match varName { ... }`, lineNo);
  }
  if (!IDENT_RE.test(subject) && !DOT_IDENT_RE.test(subject)) {
    fail(filePath, `match subject must be a valid identifier, got: ${subject}`, lineNo);
  }
}

/**
 * Parse a match expression: `match <subject> { ... }`
 * Given the subject string and the position of the `{` line.
 */
function parseMatchExpr(
  cursor: BodyCursor,
  braceAt: number,
  subject: string,
  loc: { line: number; col: number },
): { expr: MatchExprDef; next: number } {
  validateMatchSubject(cursor.filePath, subject, loc.line);
  const { arms, next } = parseMatchArms(cursor, cursor.next(braceAt), loc.line);
  if (arms.length === 0) {
    fail(cursor.filePath, "match must have at least one arm", loc.line);
  }
  return {
    expr: { subject, arms, loc },
    next,
  };
}

const MATCH_HEAD_RE =
  /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{(.*)$/s;

/**
 * Parse `match <subject> { … }` after the `match` keyword has been stripped.
 * Compact one-line form (`match status { "ok" => "pass", _ => "fail" }`) and
 * the multiline `{` at end-of-line form both produce a `match` expr.
 * Callers that already know the token is `match` must not fall through to shell.
 */
export function parseMatchAfterKeyword(
  cursor: BodyCursor,
  at: number,
  afterMatchKw: string,
  loc: { line: number; col: number },
): { expr: MatchExprDef; next: number } {
  const filePath = cursor.filePath;
  const head = afterMatchKw.trim();
  const m = head.match(MATCH_HEAD_RE);
  if (!m) {
    // The head regex only accepts a bare identifier subject. When a subject is
    // present but invalid (`$x`, `123`), surface the specific subject error
    // rather than the generic shape error.
    const braceIdx = head.indexOf("{");
    if (braceIdx !== -1) {
      validateMatchSubject(filePath, head.slice(0, braceIdx).trim(), loc.line);
    }
    fail(filePath, "match must be: match subject { ... }", loc.line, loc.col);
  }
  const subject = m[1];
  const afterBrace = m[2];
  if (afterBrace.trim() === "") {
    return parseMatchExpr(cursor, at, subject, loc);
  }
  const braceTok = cursor.tokens(at).find((t) => isPunct(t, "{"));
  const afterBraceCol = braceTok ? braceTok.col + 1 : loc.col;
  const close = compactClose(filePath, afterBrace, loc.line, afterBraceCol);
  if (close === -1) {
    fail(filePath, "unterminated match block", loc.line, loc.col);
  }
  const trailing = afterBrace.slice(close + 1).trim();
  if (trailing) {
    fail(filePath, "unexpected content after match", loc.line, loc.col);
  }
  validateMatchSubject(filePath, subject, loc.line);
  const arms = parseCompactMatchArms(filePath, afterBrace.slice(0, close), loc.line, afterBraceCol);
  if (arms.length === 0) {
    fail(filePath, "match must have at least one arm", loc.line);
  }
  return { expr: { subject, arms, loc }, next: cursor.next(at) };
}
