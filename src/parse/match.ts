import type { MatchArmDef, MatchExprDef, MatchPatternDef } from "../types";
import { decodeQuotedInner, fail, indexOfClosingDoubleQuote, rejectRemovedEscapes, SINGLE_QUOTE_MESSAGE } from "./core";
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
    const inner = t.slice(1, closeIdx);
    rejectRemovedEscapes(filePath, inner, "match pattern", lineNo);
    const value = decodeQuotedInner(inner);
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

const ARM_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\(/;
const ARM_INTERP_RE = /^\$\{[^{}]+\}$/;
/** `'…'(`, `tag'…'(`, `'''` / `tag'''`, or anything starting with a backtick. */
const ARM_INLINE_SCRIPT_RE = /^(?:[A-Za-z_][A-Za-z0-9_.-]*)?(?:'''|'[^']*'\s*\()|^`/;

const ARM_RETURN_MESSAGE =
  'match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>';
const ARM_INLINE_SCRIPT_MESSAGE =
  'inline scripts are not allowed in match arm bodies; use a named script with "script_name(…)" instead';
const ARM_COMMA_MESSAGE = "commas are not allowed in match arms; use one arm per line";

/**
 * Index just past the `)` that closes the `(` at `open`, skipping double- and
 * single-quoted spans. Returns -1 when the parens never balance.
 */
function indexAfterClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const close = indexOfClosingDoubleQuote(text, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Parse the body after `=>` in a match arm against the arm-body grammar:
 * a `"…"` string, an identifier, a dotted field (`a.b`), a `${…}` reference,
 * a managed call (`ref(…)` / `alias.ref(…)`), or `fail "…"`. (`"""` blocks are
 * handled by the callers, which own the multi-line scan.) Anything else is
 * `E_PARSE` at `col`, the column of the body's first character.
 *
 * `rest` is what follows a quoted body; for the other forms the body runs to
 * the end of `text`.
 */
function parseArmBody(filePath: string, text: string, lineNo: number, col: number): { body: string; rest: string } {
  const t = text.trimStart();
  if (!t) {
    fail(filePath, "match arm body cannot be empty", lineNo, col);
  }
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in match arm body", lineNo, col);
    }
    return { body: t.slice(0, closeIdx + 1), rest: t.slice(closeIdx + 1).trimStart() };
  }
  const body = t.trimEnd();
  if (body.endsWith(",")) {
    fail(filePath, ARM_COMMA_MESSAGE, lineNo, col);
  }
  if (/^return(\s|$)/.test(body)) {
    fail(filePath, ARM_RETURN_MESSAGE, lineNo, col);
  }
  if (ARM_INLINE_SCRIPT_RE.test(body)) {
    fail(filePath, ARM_INLINE_SCRIPT_MESSAGE, lineNo, col);
  }
  if (body.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo, col);
  }
  if (IDENT_RE.test(body) || DOT_IDENT_RE.test(body) || ARM_INTERP_RE.test(body)) {
    return { body, rest: "" };
  }
  const ref = body.match(ARM_REF_RE);
  if (ref && indexAfterClosingParen(body, ref[0].length - 1) === body.length) {
    return { body, rest: "" };
  }
  const verb = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+\S/);
  if (verb) {
    const ident = verb[1]!;
    if (ident === "fail") {
      const msg = body.slice(4).trimStart();
      if (msg.startsWith('"') && indexOfClosingDoubleQuote(msg, 1) === msg.length - 1) {
        return { body, rest: "" };
      }
    } else {
      const hint = ident === "error" ? ' did you mean "fail"?' : "";
      fail(filePath, `unknown match arm verb "${ident}"; allowed: fail "...", ref(...).${hint}`, lineNo, col);
    }
  }
  fail(filePath, invalidArmBodyMessage(body), lineNo, col);
}

function invalidArmBodyMessage(body: string): string {
  return `invalid match arm body: ${body}; expected a string, """ block, identifier, \${…}, ref(...), or fail "..."`;
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
    let segCursor = 0;
    for (const seg of armSegments) {
      const segLine = seg.trim();
      if (!segLine || segLine.startsWith("#")) {
        continue;
      }
      const segOffset = Math.max(raw.indexOf(segLine, segCursor), 0);
      segCursor = segOffset + segLine.length;
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
      const bodyCol = segOffset + segLine.length - afterArrow.length + 1;
      const { body, rest } = parseArmBody(filePath, afterArrow, lineNo, bodyCol);
      if (rest.startsWith(",")) {
        fail(filePath, ARM_COMMA_MESSAGE, lineNo, bodyCol);
      }
      if (rest) {
        fail(filePath, invalidArmBodyMessage(afterArrow.trimEnd()), lineNo, bodyCol);
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
  const rawLine = (lines[lineIdx] ?? "").trimEnd();
  const afterBraceCol = rawLine.endsWith(head) ? rawLine.length - afterBrace.length + 1 : loc.col;
  const arms = parseCompactMatchArms(filePath, afterBrace.slice(0, close), loc.line, afterBraceCol);
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
 * Each segment is trimmed and carries its offset in `inner`.
 */
function splitCompactArmSegments(inner: string): Array<{ text: string; offset: number }> {
  const segs: Array<{ text: string; offset: number }> = [];
  const push = (from: number, to: number): void => {
    const slice = inner.slice(from, to);
    const text = slice.trim();
    if (text) segs.push({ text, offset: from + (slice.length - slice.trimStart().length) });
  };
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
      push(start, i);
      start = i + 1;
    }
  }
  push(start, inner.length);
  return segs;
}

/** `innerCol` is the 1-based column of `inner[0]` on line `lineNo`. */
function parseCompactMatchArms(filePath: string, inner: string, lineNo: number, innerCol: number): MatchArmDef[] {
  const arms: MatchArmDef[] = [];
  for (const seg of splitCompactArmSegments(inner)) {
    const { pattern, rest: afterPattern } = parseArmPattern(filePath, seg.text, lineNo);
    if (!afterPattern.startsWith("=>")) {
      fail(filePath, 'expected "=>" after match pattern', lineNo);
    }
    const afterArrow = afterPattern.slice(2).trimStart();
    const bodyCol = innerCol + seg.offset + seg.text.length - afterArrow.length;
    if (afterArrow.startsWith('"""')) {
      fail(filePath, "triple-quoted match arm bodies need a multiline match", lineNo, bodyCol);
    }
    const { body, rest } = parseArmBody(filePath, afterArrow, lineNo, bodyCol);
    if (rest) {
      fail(filePath, "unexpected content after match arm body", lineNo, bodyCol);
    }
    arms.push({ pattern, body });
  }
  return arms;
}
