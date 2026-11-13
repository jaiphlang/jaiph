// Control-flow statements in a def body: `if` / `else if` / `else`, `for … in`,
// and a standalone `match`. Bodies recurse through `c.parse.body`.

import { fail } from "./core";
import { parseMatchAfterKeyword } from "./match";
import { adjacent, isPunct, keyOf } from "./body-cursor";
import { afterKeyword, execStep, isKeywordForm, type BlockCtx, type BlockResult } from "./block-ctx";
import { SliceLexer, type SliceMode } from "./slice-lexer";

type IfOperator = "==" | "!=" | "=~" | "!~";
type IfCondition = { subject: string; operator: IfOperator; rawOperand: string };

const OPERATORS = ["==", "!=", "=~", "!~"];
const PAIR: SliceMode = { triple: "pair" };

/**
 * The condition `if <subject> <op> <operand> {` from its tokens: `text` is the
 * line from the `if` keyword on, at line `lineNo`, column `col`. The subject
 * is an identifier or `a.b`; the operand a `"…"` string or `/…/` regex
 * (whatever the operator); `{` ends the line. Null when the line is not that shape.
 */
function readIfCondition(filePath: string, text: string, lineNo: number, col: number): IfCondition | null {
  const L = new SliceLexer(filePath, text, lineNo, col, 0);
  const kw = L.at(0, PAIR);
  const head = kw && L.at(L.end(kw), PAIR);
  if (kw?.kind !== "ident" || kw.text !== "if" || head?.kind !== "ident" || adjacent(kw, head)) return null;
  let last = head;
  let subject = head.text;
  const dot = L.at(L.end(head), PAIR);
  if (isPunct(dot, ".") && adjacent(head, dot!)) {
    const field = L.at(L.end(dot!), PAIR);
    if (field?.kind !== "ident" || !adjacent(dot!, field)) return null;
    subject += `.${field.text}`;
    last = field;
  }
  const op = L.at(L.end(last), PAIR);
  if (op?.kind !== "punct" || !OPERATORS.includes(op.text) || adjacent(last, op)) return null;
  const operand = L.at(L.end(op), { regex: true, triple: "pair" });
  if (!operand || adjacent(op, operand)) return null;
  const operator = op.text as IfOperator;
  if (operand.kind !== "string" && operand.kind !== "regex") return null;
  const brace = L.at(L.end(operand), PAIR);
  if (!isPunct(brace, "{") || L.at(L.end(brace!), PAIR)) return null;
  return { subject, operator, rawOperand: operand.text };
}

const INVALID_IF =
  'invalid if syntax; expected: if <identifier> <op> <operand> { ... } where op is ==, !=, =~, or !~ and operand is "string" or /regex/';

/**
 * Parse one `if` / `else if` arm and its body, recursing into `else if` chains.
 * A chain desugars to nested `if`/`else`: each `else if` arm becomes the single
 * `if` step inside the parent arm's `elseBody`, matching a human-written tree.
 *
 * `headAt` is the position of the head line; for an `else if` arm the
 * condition is read from the `if` token after `} else`.
 */
function parseIfArm(c: BlockCtx, headAt: number, isElseIf: boolean): BlockResult {
  const toks = c.cursor.tokens(headAt);
  const ifTok = toks[isElseIf ? 2 : 0]!;
  const ifCol = ifTok.col;
  const headNo = c.cursor.lineNo(headAt);
  const ifLoc = { line: headNo, col: ifCol };
  const head = c.cursor.text(headAt).trim().slice(ifTok.offset - toks[0]!.offset);
  const cond = readIfCondition(c.filePath, head, headNo, ifCol);
  if (!cond) {
    fail(c.filePath, INVALID_IF, headNo, ifCol);
  }
  const { subject, operator, rawOperand } = cond;
  const operand: { kind: "string_literal"; value: string } | { kind: "regex"; source: string } =
    rawOperand.startsWith('"')
      ? { kind: "string_literal", value: rawOperand.slice(1, -1) }
      : { kind: "regex", source: rawOperand.slice(1, -1) };
  if ((operator === "==" || operator === "!=") && operand.kind === "regex") {
    fail(c.filePath, `operator "${operator}" requires a string operand ("..."), not a regex`, headNo, ifCol);
  }
  if ((operator === "=~" || operator === "!~") && operand.kind === "string_literal") {
    fail(c.filePath, `operator "${operator}" requires a regex operand (/pattern/), not a string`, headNo, ifCol);
  }
  const thenResult = c.parse.body(c, c.cursor.next(headAt), headNo, {
    allowElseTerminator: true,
    inNestedDef: c.opts?.inNestedDef,
  });
  if (isElseIf && thenResult.steps.length === 0) {
    fail(c.filePath, '"else if" body cannot be empty', headNo, ifCol);
  }
  const base = { type: "if" as const, subject, operator, operand, body: thenResult.steps, loc: ifLoc };
  if (thenResult.closedWithElseIf) {
    const nested = parseIfArm(c, thenResult.next, true);
    return { step: { ...base, elseBody: [nested.step] }, next: nested.next };
  }
  if (thenResult.closedWithElse) {
    // The `} else {` line opens the else body: its line number is the one before `next`.
    const elseResult = c.parse.body(c, thenResult.next, c.cursor.lineNo(thenResult.next) - 1, {
      inNestedDef: c.opts?.inNestedDef,
    });
    return { step: { ...base, elseBody: elseResult.steps }, next: elseResult.next };
  }
  return { step: base, next: thenResult.next };
}

export function tryParseIf(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  if (!readIfCondition(c.filePath, c.inner, c.innerNo, head.col)) {
    if (head.kind === "ident" && (isPunct(c.tokens[1], "(") || /^\s/.test(afterKeyword(c)))) {
      fail(c.filePath, INVALID_IF, c.innerNo, head.col);
    }
    return null;
  }
  return parseIfArm(c, c.at, false);
}

export function tryParseFor(c: BlockCtx): BlockResult | null {
  const [forTok, iter, inTok, source, open, ...rest] = c.tokens;
  const forLoc = { line: c.innerNo, col: forTok!.col };
  const ok =
    forTok!.kind === "ident" &&
    iter?.kind === "ident" &&
    inTok?.kind === "ident" &&
    inTok.text === "in" &&
    source?.kind === "ident" &&
    isPunct(open, "{") &&
    rest.length === 0;
  if (!ok) {
    if (forTok!.kind === "ident" && /^\s/.test(afterKeyword(c))) {
      fail(c.filePath, "invalid for syntax; expected: for <identifier> in <identifier> { ... }", c.innerNo, forLoc.col);
    }
    return null;
  }
  const { steps: body, next } = c.parse.body(c, c.cursor.next(c.at), c.innerNo, c.opts);
  return { step: { type: "for_lines", iterVar: iter.text, sourceVar: source.text, body, loc: forLoc }, next };
}

export function tryParseElseError(c: BlockCtx): BlockResult | null {
  const elseCol = c.tokens[0]!.col;
  if (c.tokens[0]!.kind === "ident" && keyOf(c.tokens[1]) === "if") {
    fail(
      c.filePath,
      '"else if" must appear on the same line as the closing "}" of the preceding "if" block (e.g., "} else if ...")',
      c.innerNo,
      elseCol,
    );
  }
  fail(
    c.filePath,
    '"else" must appear on the same line as the closing "}" of an "if" block (e.g., "} else {")',
    c.innerNo,
    elseCol,
  );
}

export function tryParseStandaloneMatch(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "match")) return null;
  const matchLoc = { line: c.innerNo, col: c.tokens[0]!.col };
  const after = c.inner === "match" ? "" : c.inner.slice("match ".length);
  const { expr, next } = parseMatchAfterKeyword(c.cursor, c.at, after, matchLoc);
  return { step: execStep({ kind: "match", match: expr }, matchLoc), next };
}

/**
 * How a line starting with `}` ends an `if` body: `} else {`, `} else if …`,
 * or a misplaced `else` (an error).
 */
export function elseTerminator(c: BlockCtx): "else" | "else_if" | null {
  const [close, elseTok, next] = c.tokens;
  if (!isPunct(close, "}") || keyOf(elseTok) !== "else") return null;
  if (keyOf(next) === "if") return "else_if";
  if (elseTok!.kind === "ident" && isPunct(next, "{") && c.tokens.length === 3) return "else";
  fail(
    c.filePath,
    '"else" must appear on the same line as the closing "}" of the "if" block, followed by "{" (e.g., "} else {")',
    c.innerNo,
    elseTok!.col,
  );
}
