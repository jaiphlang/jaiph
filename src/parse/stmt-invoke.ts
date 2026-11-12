// Call-shaped statements: a bare call or inline script, `async ref(args)`,
// the `stdin <producer> -> <stage> [-> …]` connect / pipeline form, and
// `const name = <value>` (whose value may be such a call or connect).

import type { Expr } from "../types";
import type { Trivia } from "./trivia";
import {
  fail,
  isJaiphInterpolationRef,
  isReservedBuiltinName,
  SINGLE_QUOTE_MESSAGE,
} from "./core";
import { parseCallRef } from "./call-args";
import { parseAnonymousInlineScript } from "./inline-script";
import { firstToken, startsScript } from "./slice-lexer";
import { parseConstRhs } from "./const-rhs";
import { isCallShaped, isScriptHead, parseCallStatement, parseInlineScriptTail } from "./stmt-call";
import { firstCol, isKeywordForm, makeInlineScriptExpr, type BlockCtx, type BlockResult } from "./block-ctx";
import {
  bareIdentifierToQuotedString,
  dottedReturnToQuotedString,
  isBareDottedIdentifierReturn,
  isBareIdentifierReturn,
} from "./workflow-return-dotted";

/**
 * Split the first `stdin` operand token off `after` (the text following the
 * `stdin` keyword). A double-quoted string runs to its closing quote (may
 * contain spaces); any other token runs to the next whitespace.
 */
function takeStdinOperand(filePath: string, after: string): { operand: string; rest: string } {
  if (after.startsWith('"')) {
    const str = firstToken(filePath, after)!;
    if (str.kind !== "string") return { operand: after, rest: "" };
    return { operand: str.text, rest: after.slice(str.text.length).trim() };
  }
  const sp = after.search(/\s/);
  if (sp === -1) return { operand: after, rest: "" };
  return { operand: after.slice(0, sp), rest: after.slice(sp).trim() };
}

/**
 * Normalize a `stdin` operand into a `literal` Expr. Quoted strings are kept
 * verbatim; a bare identifier / `IDENT.IDENT` / `${…}` ref is wrapped as a
 * quoted interpolation so the runtime resolves it exactly like a value string.
 * Bare forms also stash `bareSource` on trivia so the formatter re-emits them
 * without rewriting to `"${…}"` (same pattern as `return foo`).
 */
function stdinOperandToExpr(
  filePath: string,
  innerNo: number,
  col: number,
  operand: string,
  trivia: Trivia,
): Expr {
  const t = operand.trim();
  if (t.startsWith('"')) {
    if (firstToken(filePath, t)!.kind !== "string") {
      fail(filePath, 'multiline strings use triple quotes: stdin """..."""', innerNo, col);
    }
    return { kind: "literal", raw: t };
  }
  if (t.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, innerNo, col);
  }
  if (isJaiphInterpolationRef(t)) return { kind: "literal", raw: `"${t}"` };
  if (isBareDottedIdentifierReturn(t)) {
    const expr: Expr = { kind: "literal", raw: dottedReturnToQuotedString(t) };
    trivia.setNode(expr, { bareSource: t });
    return expr;
  }
  if (isBareIdentifierReturn(t)) {
    const expr: Expr = { kind: "literal", raw: bareIdentifierToQuotedString(t) };
    trivia.setNode(expr, { bareSource: t });
    return expr;
  }
  fail(filePath, 'stdin value must be a string, identifier, or ${...} interpolation', innerNo, col);
}

/**
 * Parse a single pipeline stage (a script call or a single-line inline script)
 * off the start of `s`. Returns the parsed `Expr` and the text after it, or
 * `null` when `s` is not a bare call / single-line inline script (it is then the
 * final stage, which may carry a trailing `catch` / fenced body). Fenced and
 * multiline inline scripts are only supported as the final stage.
 */
function tryParsePipelineStage(c: BlockCtx, col: number, s: string): { expr: Expr; rest: string } | null {
  const t = s.trimStart();
  if (startsScript(c.filePath, t)) {
    const res = parseAnonymousInlineScript(c.cursor, c.at, t, c.innerNo, col, true);
    if (res.closingAt !== c.at || res.fenced) return null;
    return { expr: makeInlineScriptExpr(res), rest: res.trailing };
  }
  const call = parseCallRef(t);
  if (!call) return null;
  return {
    expr: {
      kind: "call",
      callee: { value: call.ref, loc: { line: c.innerNo, col } },
      ...(call.args ? { args: call.args } : {}),
    },
    rest: call.rest,
  };
}

/** The `stdin` producer: a call / inline script whose output streams in, or a value. */
function parseStdinProducer(
  c: BlockCtx,
  t: string,
  stdinCol: number,
): { stdin: Expr; afterOperand: string; producerIsCall: boolean } {
  if (startsScript(c.filePath, t)) {
    const res = parseAnonymousInlineScript(c.cursor, c.at, t, c.innerNo, stdinCol, true);
    return { stdin: makeInlineScriptExpr(res, c.trivia), afterOperand: res.trailing.trimStart(), producerIsCall: true };
  }
  const producerCall = parseCallRef(t);
  if (producerCall) {
    const stdin: Expr = {
      kind: "call",
      callee: { value: producerCall.ref, loc: { line: c.innerNo, col: stdinCol } },
      ...(producerCall.args ? { args: producerCall.args } : {}),
    };
    return { stdin, afterOperand: producerCall.rest.trimStart(), producerIsCall: true };
  }
  const { operand, rest } = takeStdinOperand(c.filePath, t);
  const stdin = stdinOperandToExpr(c.filePath, c.innerNo, stdinCol, operand, c.trivia);
  return { stdin, afterOperand: rest.trimStart(), producerIsCall: false };
}

/**
 * Parse the `stdin <producer> -> <stage> [-> <stage>...]` connect / pipeline
 * form. `afterStdin` is the text after the `stdin` keyword; `captureName` is set
 * when the form is the RHS of a `const` binding.
 *
 * The producer (left of the first `->`) is a value (`stdin_value`) or a call to
 * a def / script / inline script whose output handle streams into the chain.
 * Each stage after the first `->` is a script (named or inline); the final stage
 * becomes the exec step's `body`, and any intermediate stages are collected into
 * `step.stages`.
 *
 * A **pipeline** — a call producer, or two or more `->` stages — rejects
 * `recover` (`E_PARSE`); `catch` stays legal as a one-shot. `async` anywhere is
 * `E_PARSE`. A plain `stdin <value> -> script()` connect keeps `recover`.
 */
function parseStdinConnect(
  c: BlockCtx,
  afterStdin: string,
  captureName: string | undefined,
  stdinCol: number,
): BlockResult {
  const { filePath, innerNo } = c;
  const t = afterStdin.trimStart();
  if (t === "") {
    fail(filePath, "stdin requires a value expression: stdin <expr> -> ref()", innerNo, stdinCol);
  }
  const { stdin, afterOperand, producerIsCall } = parseStdinProducer(c, t, stdinCol);
  if (!afterOperand.startsWith("->")) {
    fail(filePath, "stdin requires '-> ref()' after the value: stdin <expr> -> ref()", innerNo, stdinCol);
  }
  let remaining = afterOperand.slice(2).trimStart();
  if (remaining === "") {
    fail(filePath, "stdin requires a call target: stdin <expr> -> ref()", innerNo, stdinCol);
  }
  // Collect intermediate consumer stages: each bare call / single-line inline
  // script followed by another `->`. The first stage not followed by `->` (or a
  // final stage with a trailing catch / fenced body) is left in `remaining` for
  // the shared final-target logic below.
  const stages: Expr[] = [];
  while (true) {
    const stage = tryParsePipelineStage(c, stdinCol, remaining);
    if (!stage) break;
    const after = stage.rest.trimStart();
    if (!after.startsWith("->")) break;
    stages.push(stage.expr);
    remaining = after.slice(2).trimStart();
    if (remaining === "") {
      fail(filePath, "stdin requires a call target: stdin <expr> -> ref()", innerNo, stdinCol);
    }
  }

  const isPipeline = producerIsCall || stages.length > 0;
  const target = remaining;
  if (/^async(?:\s|$)/.test(target)) {
    fail(filePath, "async is not supported with stdin", innerNo, stdinCol);
  }
  let result: BlockResult;
  if (startsScript(filePath, target)) {
    const res = parseAnonymousInlineScript(c.cursor, c.at, target, innerNo, stdinCol, true);
    const body = makeInlineScriptExpr(res, c.trivia);
    const stepLoc = { line: innerNo, col: stdinCol };
    result = parseInlineScriptTail(c, res, body, stepLoc, stdinCol, stdin, captureName);
  } else {
    result = parseCallStatement(c, target, false, captureName, stdin, "stdin", stdinCol);
  }

  // Pipeline invariants: recover is rejected; intermediate stages are attached.
  if (isPipeline && result.step.type === "exec" && result.step.recover) {
    fail(filePath, "recover is not supported on a stdin pipeline; use catch", innerNo, stdinCol);
  }
  if (stages.length > 0 && result.step.type === "exec") {
    result.step.stages = stages;
  }
  return result;
}

/** `stdin <expr> -> <call>` connect form in statement position. */
export function tryParseStdin(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "stdin")) return null;
  const after = c.inner === "stdin" ? "" : c.inner.slice("stdin ".length);
  return parseStdinConnect(c, after, undefined, c.tokens[0]!.col);
}

/** `async <ref>(args)` — an async capture in statement position. */
export function tryParseAsync(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "async")) return null;
  const col = c.tokens[0]!.col;
  const rest = c.inner === "async" ? "" : c.inner.slice("async ".length).trim();
  if (isScriptHead(c.tokens[1])) {
    fail(c.filePath, "async is not supported with inline scripts", c.innerNo, col);
  }
  if (isKeywordForm({ ...c, tokens: c.tokens.slice(1) }, "stdin")) {
    fail(c.filePath, "async is not supported with stdin", c.innerNo, col);
  }
  return parseCallStatement(c, rest, true, undefined, undefined, "async", col);
}

/**
 * A bare call statement: `` 'body'(args) `` inline script or `ref(args)` managed
 * call, optionally with an attached `catch` / `recover`. Fires only after the
 * keyword dispatch table misses, so a keyword line never reaches here. Returns
 * null for any line that is not call-shaped.
 */
export function tryBareCall(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0];
  if (!head) return null;
  if (isScriptHead(head)) {
    const result = parseAnonymousInlineScript(c.cursor, c.at, c.inner, c.innerNo, head.col, true);
    const body = makeInlineScriptExpr(result, c.trivia);
    const stepLoc = { line: c.innerNo, col: head.col };
    return parseInlineScriptTail(c, result, body, stepLoc, head.col);
  }
  // Any `ident(.ident)*(` is a call attempt; a malformed ref shape (e.g. a
  // three-part `a.b.c(`) then fails in parseCallStatement rather than silently
  // becoming a shell line.
  if (!isCallShaped(c.tokens)) return null;
  return parseCallStatement(c, c.inner, false, undefined, undefined, "call", head.col);
}

export function tryParseConst(c: BlockCtx): BlockResult | null {
  const [constTok, nameTok, eqTok] = c.tokens;
  if (constTok!.kind !== "ident" || nameTok?.kind !== "ident" || eqTok?.kind !== "punct" || !eqTok.text.startsWith("=")) {
    return null;
  }
  const rhs = c.innerRaw.trimEnd().slice(eqTok.col).trim();
  if (rhs === "") return null;
  const name = nameTok.text;
  const constCol = constTok!.col;
  if (isReservedBuiltinName(name)) {
    fail(c.filePath, `"${name}" is a reserved builtin record and cannot be used as a const name`, c.innerNo, constCol);
  }
  // const out = stdin <expr> -> ref()  →  an exec step that captures into `out`.
  if (rhs === "stdin" || rhs.startsWith("stdin ")) {
    const stdinCol = c.tokens[3]!.col;
    const after = rhs === "stdin" ? "" : rhs.slice("stdin ".length);
    return parseStdinConnect(c, after, name, stdinCol);
  }
  const { value, next } = parseConstRhs(c.cursor, c.at, rhs, c.innerNo, firstCol(c, rhs), name, c.trivia);
  return {
    step: { type: "const", name, value, loc: { line: c.innerNo, col: constCol } },
    next,
  };
}
