// Control-flow statements in a def body: `if` / `else if` / `else`, `for … in`,
// and a standalone `match`. Bodies recurse through `c.parse.body`.

import { fail } from "./core";
import { parseMatchAfterKeyword } from "./match";
import { isPunct, keyOf } from "./body-cursor";
import { afterKeyword, execStep, isKeywordForm, type BlockCtx, type BlockResult } from "./block-ctx";

/**
 * Condition grammar shared by a top-level `if` and each `else if` arm, matched
 * against the line text from the `if` keyword on.
 */
const IF_CONDITION_RE =
  /^if\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+(==|!=|=~|!~)\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/)\s*\{\s*$/;

const INVALID_IF =
  'invalid if syntax; expected: if <identifier> <op> <operand> { ... } where op is ==, !=, =~, or !~ and operand is "string" or /regex/';

/**
 * Parse one `if` / `else if` arm and its body, recursing into `else if` chains.
 * A chain desugars to nested `if`/`else`: each `else if` arm becomes the single
 * `if` step inside the parent arm's `elseBody`, matching a human-written tree.
 *
 * `headIdx` is the 0-based index of the head line; for an `else if` arm the
 * condition is read from the `if` token after `} else`.
 */
function parseIfArm(c: BlockCtx, headIdx: number, isElseIf: boolean): BlockResult {
  const toks = c.cursor.tokens(headIdx);
  const ifTok = toks[isElseIf ? 2 : 0]!;
  const ifCol = ifTok.col;
  const ifLoc = { line: headIdx + 1, col: ifCol };
  const head = c.lines[headIdx]!.trim().slice(ifTok.offset - toks[0]!.offset);
  const m = head.match(IF_CONDITION_RE);
  if (!m) {
    fail(c.filePath, INVALID_IF, headIdx + 1, ifCol);
  }
  const subject = m[1];
  const operator = m[2] as "==" | "!=" | "=~" | "!~";
  const rawOperand = m[3];
  const operand: { kind: "string_literal"; value: string } | { kind: "regex"; source: string } =
    rawOperand.startsWith('"')
      ? { kind: "string_literal", value: rawOperand.slice(1, -1) }
      : { kind: "regex", source: rawOperand.slice(1, -1) };
  if ((operator === "==" || operator === "!=") && operand.kind === "regex") {
    fail(c.filePath, `operator "${operator}" requires a string operand ("..."), not a regex`, headIdx + 1, ifCol);
  }
  if ((operator === "=~" || operator === "!~") && operand.kind === "string_literal") {
    fail(c.filePath, `operator "${operator}" requires a regex operand (/pattern/), not a string`, headIdx + 1, ifCol);
  }
  const thenResult = c.parse.body(c, headIdx + 1, headIdx + 1, {
    allowElseTerminator: true,
    inNestedDef: c.opts?.inNestedDef,
  });
  if (isElseIf && thenResult.steps.length === 0) {
    fail(c.filePath, '"else if" body cannot be empty', headIdx + 1, ifCol);
  }
  const base = { type: "if" as const, subject, operator, operand, body: thenResult.steps, loc: ifLoc };
  if (thenResult.closedWithElseIf) {
    const nested = parseIfArm(c, thenResult.nextIdx, true);
    return { step: { ...base, elseBody: [nested.step] }, nextIdx: nested.nextIdx };
  }
  if (thenResult.closedWithElse) {
    const elseResult = c.parse.body(c, thenResult.nextIdx, thenResult.nextIdx, {
      inNestedDef: c.opts?.inNestedDef,
    });
    return { step: { ...base, elseBody: elseResult.steps }, nextIdx: elseResult.nextIdx };
  }
  return { step: base, nextIdx: thenResult.nextIdx };
}

export function tryParseIf(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  if (!IF_CONDITION_RE.test(c.inner)) {
    if (head.kind === "ident" && (isPunct(c.tokens[1], "(") || /^\s/.test(afterKeyword(c)))) {
      fail(c.filePath, INVALID_IF, c.innerNo, head.col);
    }
    return null;
  }
  return parseIfArm(c, c.idx, false);
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
  const { steps: body, nextIdx } = c.parse.body(c, c.idx + 1, c.innerNo, c.opts);
  return { step: { type: "for_lines", iterVar: iter.text, sourceVar: source.text, body, loc: forLoc }, nextIdx };
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
  const { expr, nextIndex } = parseMatchAfterKeyword(c.filePath, c.lines, c.idx, after, matchLoc);
  return { step: execStep({ kind: "match", match: expr }, matchLoc), nextIdx: nextIndex };
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
