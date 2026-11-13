// Match arms from tokens: the multiline form (one arm per line, or several
// separated by `;`), shared by `match` and `mock prompt { … }`, and the compact
// one-line `{ arm, arm }` form. Each line is read through a `SliceLexer`;
// patterns are `string` / `regex` / `_` tokens joined by `|`, and the body
// follows the arm-body grammar (a string, `"""` block, identifier, `a.b`,
// `${…}`, `ref(…)`, or `fail "…"`).

import type { MatchArmDef, MatchPatternDef } from "../types";
import type { Token } from "./lexer";
import { decodeQuotedInner, fail, rejectRemovedEscapes, SINGLE_QUOTE_MESSAGE } from "./core";
import { adjacent, isPunct, type BodyCursor } from "./body-cursor";
import { SliceLexer, splitStatements, type SliceMode } from "./slice-lexer";
import { blockBody, tripleQuoteBodyToRaw } from "./triple-quote";

/** Pattern position: a `/` opens a regex; `'` is a stray character. */
const PATTERN: SliceMode = { regex: true, scripts: false, triple: "pair" };
/** Arm body: quotes pair up, `'…'` is a script, `/` is a plain character. */
const BODY: SliceMode = { triple: "pair" };
/** Splitting a compact `{ … }` body on `,`: any `/` opens a regex. Commas inside a call's `(…)` do not split. */
const COMPACT: SliceMode = { regex: true, scripts: false, triple: "pair" };

const ARM_RETURN_MESSAGE =
  'match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>';
const ARM_INLINE_SCRIPT_MESSAGE =
  'inline scripts are not allowed in match arm bodies; use a named script with "script_name(…)" instead';
const ARM_COMMA_MESSAGE = "commas are not allowed in match arms; use one arm per line";

function invalidArmBodyMessage(body: string): string {
  return `invalid match arm body: ${body}; expected a string, """ block, identifier, \${…}, ref(...), or fail "..."`;
}

/** One pattern (`"…"`, `/…/`, or `_`) at `pos`; returns it and the index after it. */
function patternAt(L: SliceLexer, pos: number, lineNo: number): { pattern: MatchPatternDef; next: number } {
  const tok = L.at(pos, PATTERN);
  const text = tok?.text ?? "";
  if (text.startsWith("_")) return { pattern: { kind: "wildcard" }, next: L.rel(tok!) + 1 };
  if (text.startsWith('"')) {
    if (tok!.kind !== "string") fail(L.filePath, "unterminated string in match pattern", lineNo);
    const inner = text.slice(1, -1);
    rejectRemovedEscapes(L.filePath, inner, "match pattern", lineNo);
    return { pattern: { kind: "string_literal", value: decodeQuotedInner(inner) }, next: L.end(tok!) };
  }
  if (text.startsWith("'")) fail(L.filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  if (text.startsWith("/")) {
    if (tok!.kind !== "regex") fail(L.filePath, "unterminated regex in match pattern", lineNo);
    const source = text.slice(1, -1);
    if (source.length === 0) fail(L.filePath, "empty regex in match pattern", lineNo);
    try {
      new RegExp(source);
    } catch {
      fail(L.filePath, `invalid regex in match pattern: /${source}/`, lineNo);
    }
    return { pattern: { kind: "regex", source }, next: L.end(tok!) };
  }
  fail(L.filePath, 'match pattern must be a string literal ("..."), regex (/…/), or wildcard (_)', lineNo);
}

/**
 * A pattern with optional `|` alternation (`"a" | "b" | /^c/`). `_` cannot
 * take part, and a `|` must be followed by a pattern. Returns the pattern and
 * the index after it.
 */
function armPatternAt(L: SliceLexer, pos: number, lineNo: number): { pattern: MatchPatternDef; next: number } {
  const first = patternAt(L, pos, lineNo);
  let bar = L.at(first.next, PATTERN);
  if (!isPunct(bar, "|")) return first;
  if (first.pattern.kind === "wildcard") {
    fail(L.filePath, "wildcard _ cannot participate in match alternation", lineNo);
  }
  const patterns: MatchPatternDef[] = [first.pattern];
  let next = first.next;
  while (isPunct(bar, "|")) {
    const after = L.at(L.end(bar!), PATTERN);
    if (!after || isPunct(after, "=>")) {
      fail(L.filePath, "trailing | in match alternation; expected a pattern after |", lineNo);
    }
    const alt = patternAt(L, L.rel(after), lineNo);
    if (alt.pattern.kind === "wildcard") {
      fail(L.filePath, "wildcard _ cannot participate in match alternation", lineNo);
    }
    patterns.push(alt.pattern);
    next = alt.next;
    bar = L.at(next, PATTERN);
  }
  return { pattern: { kind: "alternation", patterns }, next };
}

/** `pattern =>` at the start of arm slice `L`: the pattern and the index after `=>`. */
function armHead(L: SliceLexer, lineNo: number): { pattern: MatchPatternDef; bodyFrom: number } {
  const { pattern, next } = armPatternAt(L, 0, lineNo);
  const arrow = L.at(next, PATTERN);
  if (!isPunct(arrow, "=>")) fail(L.filePath, 'expected "=>" after match pattern', lineNo);
  return { pattern, bodyFrom: L.end(arrow!) };
}

/** True when `toks[0]` is a `${…}` reference spanning the whole body. */
function isInterpBody(toks: Token[]): boolean {
  const first = toks[0]!;
  const last = toks[toks.length - 1]!;
  if (!isPunct(first, "${") || !isPunct(last, "}") || last.offset <= first.offset + 2) return false;
  return toks.slice(1, -1).every((t) => !/[{}]/.test(t.text));
}

/** True when the body is `ref(…)` / `alias.ref(…)` with the call's `)` last. */
function isCallBody(toks: Token[]): boolean {
  let i = 0;
  if (isPunct(toks[1], ".") && adjacent(toks[0]!, toks[1]!) && toks[2]?.kind === "ident" && adjacent(toks[1]!, toks[2])) {
    i = 2;
  }
  if (!isPunct(toks[i + 1], "(") || !adjacent(toks[i]!, toks[i + 1]!)) return false;
  let depth = 0;
  for (let k = i + 1; k < toks.length; k += 1) {
    if (isPunct(toks[k], "(")) depth += 1;
    if (isPunct(toks[k], ")")) {
      depth -= 1;
      if (depth === 0) return k === toks.length - 1;
    }
  }
  return false;
}

/**
 * The arm body from index `from` of slice `L` (`"""` blocks are handled by the
 * callers). Returns the body text and, for a quoted body, the token after it.
 * Anything outside the grammar is `E_PARSE` at `col`.
 */
function armBody(L: SliceLexer, from: number, lineNo: number, col: number): { body: string; rest: Token | undefined } {
  const err = (message: string): never => fail(L.filePath, message, lineNo, col);
  const first = L.at(from, BODY);
  if (!first) err("match arm body cannot be empty");
  if (first!.text.startsWith('"')) {
    if (first!.kind !== "string") err("unterminated string in match arm body");
    return { body: first!.text, rest: L.at(L.end(first!), BODY) };
  }
  const body = L.text.slice(L.rel(first!));
  const toks = L.all(L.rel(first!), BODY);
  const [head, second] = toks as [Token, Token | undefined];
  if (body.endsWith(",")) err(ARM_COMMA_MESSAGE);
  const spaced = second !== undefined && !adjacent(head, second);
  if (head.kind === "ident" && head.text === "return" && (!second || spaced)) err(ARM_RETURN_MESSAGE);
  const emptyScript = head.kind === "script_oneline" && head.text.endsWith("''");
  if (
    head.text === "`" ||
    (head.kind === "script_oneline" &&
      (isPunct(second, "(") || (emptyScript && second?.text.startsWith("'") && adjacent(head, second))))
  ) {
    err(ARM_INLINE_SCRIPT_MESSAGE);
  }
  if (body.startsWith("'")) err(SINGLE_QUOTE_MESSAGE);
  const whole = (n: number): boolean => toks.length === n && toks.slice(1).every((t, k) => adjacent(toks[k]!, t));
  const dotted = whole(3) && isPunct(toks[1], ".") && toks[2]!.kind === "ident";
  if (head.kind === "ident" && (whole(1) || dotted || isCallBody(toks))) return { body, rest: undefined };
  if (isInterpBody(toks)) return { body, rest: undefined };
  if (head.kind === "ident" && spaced) {
    if (head.text !== "fail") {
      const hint = head.text === "error" ? ' did you mean "fail"?' : "";
      err(`unknown match arm verb "${head.text}"; allowed: fail "...", ref(...).${hint}`);
    }
    if (toks.length === 2 && second!.kind === "string") return { body, rest: undefined };
  }
  return err(invalidArmBodyMessage(body));
}

/** Column just past the end of slice `L`, or of `tok` when there is one. */
function colAt(L: SliceLexer, tok: Token | undefined): number {
  return tok ? tok.col : L.col + L.text.length;
}

/**
 * Parse match arms inside `{ … }`, from position `start` up to the closing
 * `}` line. Each line holds one arm, or several separated by `;`; a
 * `pattern => """` arm reads the block on the following lines. Returns the
 * arms and the position after the closing `}`.
 */
export function parseMatchArms(
  cursor: BodyCursor,
  start: number,
  openerLineNo: number,
): { arms: MatchArmDef[]; next: number } {
  const filePath = cursor.filePath;
  const arms: MatchArmDef[] = [];
  let at = start;
  while (!cursor.atEnd(at)) {
    const lineNo = cursor.lineNo(at);
    const line = new SliceLexer(filePath, cursor.text(at), lineNo, 1, at);
    const first = line.at(0, PATTERN);
    if (isPunct(first, "}") && !line.at(line.end(first!), PATTERN)) return { arms, next: cursor.next(at) };
    let next = cursor.next(at);
    if (first?.text.startsWith("#")) {
      at = next;
      continue;
    }
    for (const [from, to] of splitStatements(line, true)) {
      const L = line.slice(from, to);
      if (L.text.startsWith("#")) continue;
      const { pattern, bodyFrom } = armHead(L, lineNo);
      const bodyTok = L.at(bodyFrom, BODY);
      if (bodyTok && L.text.startsWith('"""', L.rel(bodyTok))) {
        if (L.rel(bodyTok) + 3 < L.text.length) {
          fail(filePath, 'opening """ in match arm must not have content on the same line', lineNo);
        }
        let block: Token;
        try {
          block = cursor.tokenAt(at, bodyTok.col);
        } catch {
          fail(filePath, 'unterminated triple-quoted block in match arm: no closing """ before end of match', lineNo);
        }
        const closeAt = cursor.closeOf(block);
        next = cursor.next(closeAt);
        if (cursor.textAfter(block).trim()) {
          fail(filePath, 'closing """ in match arm must not have content on the same line', cursor.lineNo(closeAt));
        }
        arms.push({ pattern, body: tripleQuoteBodyToRaw(blockBody(block)), tripleQuotedBody: true });
        break;
      }
      const col = colAt(L, bodyTok);
      const { body, rest } = armBody(L, bodyFrom, lineNo, col);
      if (rest?.text.startsWith(",")) fail(filePath, ARM_COMMA_MESSAGE, lineNo, col);
      if (rest) fail(filePath, invalidArmBodyMessage(L.text.slice(L.rel(bodyTok!))), lineNo, col);
      arms.push({ pattern, body });
    }
    at = next;
  }
  fail(filePath, "unterminated match block", openerLineNo);
}

/**
 * The compact one-line form: `afterBrace` is the text after `{` on the match
 * line, starting at line `lineNo`, column `col`. Returns the index of its
 * closing `}` (the last one outside strings and regexes), or -1.
 */
export function compactClose(filePath: string, afterBrace: string, lineNo: number, col: number): number {
  const L = new SliceLexer(filePath, afterBrace, lineNo, col, 0);
  let close = -1;
  for (const tok of L.all(0, COMPACT)) if (isPunct(tok, "}")) close = L.rel(tok);
  return close;
}

/** Arms of a compact `{ arm, arm }` body: `inner` is the text between the braces, at column `col`. */
export function parseCompactMatchArms(filePath: string, inner: string, lineNo: number, col: number): MatchArmDef[] {
  const L = new SliceLexer(filePath, inner, lineNo, col, 0);
  const arms: MatchArmDef[] = [];
  const segments: Token[][] = [[]];
  // Split only on commas at parenthesis depth 0, so a comma inside a call's
  // `(…)` — `f(x, y)`, `'echo'(a, b)` — stays in one arm. An unbalanced `(`
  // keeps depth above 0, so the rest of the line stays one arm and `armBody`
  // reports an `E_PARSE` at the body column instead of splitting silently.
  let depth = 0;
  for (const tok of L.all(0, COMPACT)) {
    if (isPunct(tok, "(")) depth += 1;
    else if (isPunct(tok, ")") && depth > 0) depth -= 1;
    if (depth === 0 && isPunct(tok, ",")) segments.push([]);
    else segments[segments.length - 1]!.push(tok);
  }
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const S = L.slice(L.rel(seg[0]!), L.end(seg[seg.length - 1]!));
    const { pattern, bodyFrom } = armHead(S, lineNo);
    const bodyTok = S.at(bodyFrom, BODY);
    const bodyCol = colAt(S, bodyTok);
    if (bodyTok && S.text.startsWith('"""', S.rel(bodyTok))) {
      fail(filePath, "triple-quoted match arm bodies need a multiline match", lineNo, bodyCol);
    }
    const { body, rest } = armBody(S, bodyFrom, lineNo, bodyCol);
    if (rest) fail(filePath, "unexpected content after match arm body", lineNo, bodyCol);
    arms.push({ pattern, body });
  }
  return arms;
}
