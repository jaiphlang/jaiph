import type { MatchArmDef, MatchExprDef, MatchPatternDef } from "../types";
import { fail, SINGLE_QUOTE_MESSAGE, indexOfClosingDoubleQuote, unescapeDoubleQuotedInner } from "./core";
import { splitStatementsOnSemicolons } from "./statement-split";
import { tripleQuoteBodyToRaw, trimAdjacentBlankLines } from "./triple-quote";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOT_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate that a match subject is a bare identifier or `IDENT.IDENT`
 * (typed prompt capture field). Dot-field resolution and schema enforcement
 * happen in the validator, mirroring `${var.field}` interpolation.
 */
export function validateMatchSubject(filePath: string, subject: string, lineNo: number): void {
  if (subject.startsWith("${") || subject.startsWith("$")) {
    fail(filePath, `match subject should be a bare identifier: match varName { ... }`, lineNo);
  }
  if (!IDENT_RE.test(subject) && !DOT_IDENT_RE.test(subject)) {
    fail(filePath, `match subject must be a valid identifier, got: ${subject}`, lineNo);
  }
}

/**
 * Parse a single match arm pattern: "literal", /regex/, or _
 * Returns the pattern and the rest of the string after the pattern.
 */
function parsePattern(filePath: string, text: string, lineNo: number): { pattern: MatchPatternDef; rest: string } {
  const t = text.trimStart();
  if (t.startsWith("_")) {
    const after = t.slice(1).trimStart();
    return { pattern: { kind: "wildcard" }, rest: after };
  }
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in match pattern", lineNo);
    }
    const value = unescapeDoubleQuotedInner(t.slice(1, closeIdx));
    const rest = t.slice(closeIdx + 1).trimStart();
    return { pattern: { kind: "string_literal", value }, rest };
  }
  if (t.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  }
  if (t.startsWith("/")) {
    // Find closing / (not escaped)
    let closeIdx = -1;
    for (let i = 1; i < t.length; i += 1) {
      if (t[i] === "/" && t[i - 1] !== "\\") {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      fail(filePath, "unterminated regex in match pattern", lineNo);
    }
    const source = t.slice(1, closeIdx);
    if (source.length === 0) {
      fail(filePath, "empty regex in match pattern", lineNo);
    }
    // Validate regex syntax
    try {
      new RegExp(source);
    } catch {
      fail(filePath, `invalid regex in match pattern: /${source}/`, lineNo);
    }
    const rest = t.slice(closeIdx + 1).trimStart();
    return { pattern: { kind: "regex", source }, rest };
  }
  fail(filePath, 'match pattern must be a string literal ("..."), regex (/…/), or wildcard (_)', lineNo);
}

/**
 * Parse a match arm pattern, including pipe-separated alternation
 * (`"a" | "b" | /^c/`). A single pattern is returned as-is; two or more
 * yield an `alternation` node. `_` cannot participate in alternation, and a
 * trailing `|` (no pattern before `=>`) is `E_PARSE`. String and regex
 * alternands may be mixed — the matcher dispatches on each alternand's kind.
 */
function parseArmPattern(filePath: string, text: string, lineNo: number): { pattern: MatchPatternDef; rest: string } {
  const first = parsePattern(filePath, text, lineNo);
  if (!first.rest.startsWith("|")) {
    return first;
  }
  if (first.pattern.kind === "wildcard") {
    fail(filePath, "wildcard _ cannot participate in match alternation", lineNo);
  }
  const patterns: MatchPatternDef[] = [first.pattern];
  let rest = first.rest;
  while (rest.startsWith("|")) {
    const afterPipe = rest.slice(1).trimStart();
    if (afterPipe.length === 0 || afterPipe.startsWith("=>")) {
      fail(filePath, "trailing | in match alternation; expected a pattern after |", lineNo);
    }
    const next = parsePattern(filePath, afterPipe, lineNo);
    if (next.pattern.kind === "wildcard") {
      fail(filePath, "wildcard _ cannot participate in match alternation", lineNo);
    }
    patterns.push(next.pattern);
    rest = next.rest;
  }
  return { pattern: { kind: "alternation", patterns }, rest };
}

/**
 * Parse the body (value expression) after `=>` in a match arm.
 * Returns the raw value string and any remaining text after the body.
 */
function parseArmBody(filePath: string, text: string, lineNo: number): { body: string; rest: string } {
  const t = text.trimStart();
  if (!t) {
    fail(filePath, "match arm body cannot be empty", lineNo);
  }
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in match arm body", lineNo);
    }
    return { body: t.slice(0, closeIdx + 1), rest: t.slice(closeIdx + 1).trimStart() };
  }
  if (t.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  }
  // Allow $var, ${var}, ${var.field}, or bare words up to end of line
  return { body: t, rest: "" };
}

/**
 * Parse match arms from lines inside `{ ... }`.
 * Each arm is on its own line: `pattern => body`
 * Returns the parsed arms and the index after the closing `}`.
 */
export function parseMatchArms(
  filePath: string,
  lines: string[],
  startIndex: number,
  openerLineNo: number,
): { arms: MatchArmDef[]; nextIndex: number } {
  const arms: MatchArmDef[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      i += 1;
      continue;
    }
    if (line === "}") {
      return { arms, nextIndex: i + 1 };
    }
    const armSegments = splitStatementsOnSemicolons(line, { allowRegexLiteral: true });
    let tripleQuoteAdvanced = false;
    for (const seg of armSegments) {
      const segLine = seg.trim();
      if (!segLine || segLine.startsWith("#")) {
        continue;
      }
      const { pattern, rest: afterPattern } = parseArmPattern(filePath, segLine, lineNo);
      if (!afterPattern.startsWith("=>")) {
        fail(filePath, 'expected "=>" after match pattern', lineNo);
      }
      const afterArrow = afterPattern.slice(2).trimStart();
      // Triple-quoted arm body: pattern => """
      if (afterArrow === '"""' || afterArrow.startsWith('"""')) {
        const textAfterTriple = afterArrow.slice(3).trim();
        if (textAfterTriple.length > 0) {
          fail(filePath, 'opening """ in match arm must not have content on the same line', lineNo);
        }
        const bodyLines: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const trimmed = lines[j].trim();
          if (trimmed.startsWith('"""')) {
            const afterClose = trimmed.slice(3).trim();
            if (afterClose.length > 0) {
              fail(filePath, 'closing """ in match arm must not have content on the same line', j + 1);
            }
            break;
          }
          bodyLines.push(lines[j]);
        }
        if (j >= lines.length) {
          fail(filePath, 'unterminated triple-quoted block in match arm: no closing """ before end of match', lineNo);
        }
        arms.push({
          pattern,
          body: tripleQuoteBodyToRaw(trimAdjacentBlankLines(bodyLines.join("\n"))),
          tripleQuotedBody: true,
        });
        i = j + 1;
        tripleQuoteAdvanced = true;
        break;
      }
      const { body, rest } = parseArmBody(filePath, afterArrow, lineNo);
      if (body.trimEnd().endsWith(",") || rest.startsWith(",")) {
        fail(filePath, "commas are not allowed in match arms; use one arm per line", lineNo);
      }
      arms.push({ pattern, body });
    }
    if (!tripleQuoteAdvanced) {
      i += 1;
    }
  }
  fail(filePath, "unterminated match block", openerLineNo);
}

/**
 * Parse a match expression: `match <subject> { ... }`
 * Given the subject string and the lines starting from the `{` line.
 */
export function parseMatchExpr(
  filePath: string,
  lines: string[],
  braceLineIndex: number,
  subject: string,
  loc: { line: number; col: number },
): { expr: MatchExprDef; nextIndex: number } {
  validateMatchSubject(filePath, subject, loc.line);
  const { arms, nextIndex } = parseMatchArms(filePath, lines, braceLineIndex + 1, loc.line);
  if (arms.length === 0) {
    fail(filePath, "match must have at least one arm", loc.line);
  }
  return {
    expr: { subject, arms, loc },
    nextIndex,
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
  filePath: string,
  lines: string[],
  lineIdx: number,
  afterMatchKw: string,
  loc: { line: number; col: number },
): { expr: MatchExprDef; nextIndex: number } {
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
    return parseMatchExpr(filePath, lines, lineIdx, subject, loc);
  }
  const close = lastUnquotedChar(afterBrace, "}");
  if (close === -1) {
    fail(filePath, "unterminated match block", loc.line, loc.col);
  }
  const trailing = afterBrace.slice(close + 1).trim();
  if (trailing) {
    fail(filePath, "unexpected content after match", loc.line, loc.col);
  }
  validateMatchSubject(filePath, subject, loc.line);
  const inner = afterBrace.slice(0, close).trim();
  const arms = parseCompactMatchArms(filePath, inner, loc.line);
  if (arms.length === 0) {
    fail(filePath, "match must have at least one arm", loc.line);
  }
  return { expr: { subject, arms, loc }, nextIndex: lineIdx + 1 };
}

/** Last `}` that is not inside a double-quoted string or `/regex/`. */
function lastUnquotedChar(text: string, ch: string): number {
  let last = -1;
  let inDq = false;
  let inRegex = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inDq) {
      if (c === `"` && text[i - 1] !== "\\") inDq = false;
      continue;
    }
    if (inRegex) {
      if (c === "/" && text[i - 1] !== "\\") inRegex = false;
      continue;
    }
    if (c === `"`) {
      inDq = true;
      continue;
    }
    if (c === "/") {
      inRegex = true;
      continue;
    }
    if (c === ch) last = i;
  }
  return last;
}

/**
 * Split a compact `{ arm, arm }` body on commas that sit between arms
 * (outside quotes and regex literals). Language.md's one-line example uses
 * that comma form; multiline match still forbids commas (one arm per line).
 */
function splitCompactArmSegments(inner: string): string[] {
  const segs: string[] = [];
  let start = 0;
  let inDq = false;
  let inRegex = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inDq) {
      if (c === `"` && inner[i - 1] !== "\\") inDq = false;
      continue;
    }
    if (inRegex) {
      if (c === "/" && inner[i - 1] !== "\\") inRegex = false;
      continue;
    }
    if (c === `"`) {
      inDq = true;
      continue;
    }
    if (c === "/") {
      inRegex = true;
      continue;
    }
    if (c === ",") {
      segs.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  segs.push(inner.slice(start));
  return segs.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseCompactMatchArms(filePath: string, inner: string, lineNo: number): MatchArmDef[] {
  const arms: MatchArmDef[] = [];
  for (const seg of splitCompactArmSegments(inner)) {
    const { pattern, rest: afterPattern } = parseArmPattern(filePath, seg, lineNo);
    if (!afterPattern.startsWith("=>")) {
      fail(filePath, 'expected "=>" after match pattern', lineNo);
    }
    const afterArrow = afterPattern.slice(2).trimStart();
    if (afterArrow.startsWith('"""')) {
      fail(filePath, "triple-quoted match arm bodies need a multiline match", lineNo);
    }
    const { body, rest } = parseArmBody(filePath, afterArrow, lineNo);
    if (rest) {
      fail(filePath, "unexpected content after match arm body", lineNo);
    }
    arms.push({ pattern, body });
  }
  return arms;
}
