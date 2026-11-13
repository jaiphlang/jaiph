// `return <value>` in a def body.

import type { Expr } from "../types";
import { fail, rejectTrailingContent, SINGLE_QUOTE_MESSAGE } from "./core";
import { parseCallRefMultiline } from "./call-args";
import { parseAnonymousInlineScript } from "./inline-script";
import { parsePromptStep } from "./prompt";
import { parseMatchAfterKeyword } from "./match";
import { isCallShaped, isScriptHead } from "./stmt-call";
import {
  afterKeyword,
  isKeywordForm,
  makeInlineScriptExpr,
  rejectTrailingAfterString,
  tripleQuotedArg,
  firstCol,
  type BlockCtx,
  type BlockResult,
} from "./block-ctx";
import {
  bareIdentifierToQuotedString,
  dottedReturnToQuotedString,
  isBareDottedIdentifierReturn,
  isBareIdentifierReturn,
} from "./workflow-return-dotted";

/** `return prompt …`: the prompt expression, with its body trivia moved onto it. */
function parseReturnPrompt(c: BlockCtx, returnValue: string, retLoc: { line: number; col: number }): BlockResult {
  const promptCol = firstCol(c, "prompt");
  const promptArg = returnValue === "prompt" ? "" : returnValue.slice("prompt ".length).trimStart();
  const result = parsePromptStep(c.cursor, c.at, promptArg, promptCol, undefined, c.trivia);
  const st = result.step;
  if (st.type !== "exec" || st.body.kind !== "prompt") {
    fail(c.filePath, "return prompt internal parse error", c.innerNo, retLoc.col);
  }
  const promptBody = st.body;
  const promptTrivia = c.trivia.getNode(st);
  if (promptTrivia) {
    c.trivia.setNode(promptBody, {
      ...(promptTrivia.bodyKind ? { bodyKind: promptTrivia.bodyKind } : {}),
      ...(promptTrivia.bodyIdentifier ? { bodyIdentifier: promptTrivia.bodyIdentifier } : {}),
      ...(promptTrivia.rawBody !== undefined ? { rawBody: promptTrivia.rawBody } : {}),
    });
  }
  return {
    step: { type: "return", value: promptBody, loc: retLoc },
    next: result.next,
  };
}

/** `return "…"`, `return $x`, `return name`, `return a.b`: a string value. */
function parseReturnString(c: BlockCtx, returnValue: string, retLoc: { line: number; col: number }): BlockResult {
  const valueTok = c.tokens[1]!;
  if (valueTok.text.startsWith('"') && valueTok.kind !== "string") {
    fail(c.filePath, 'multiline strings use triple quotes: return """..."""', c.innerNo, retLoc.col);
  }
  if (valueTok.kind === "string") {
    rejectTrailingAfterString(c, "return", valueTok, retLoc.col);
  }
  const isBareDotted = isBareDottedIdentifierReturn(returnValue);
  const isBare = !isBareDotted && isBareIdentifierReturn(returnValue);
  const raw = isBareDotted
    ? dottedReturnToQuotedString(returnValue)
    : isBare
      ? bareIdentifierToQuotedString(returnValue)
      : returnValue;
  const value: Expr = { kind: "literal", raw };
  if (isBareDotted || isBare) {
    c.trivia.setNode(value, { bareSource: returnValue.trim() });
  }
  return { step: { type: "return", value, loc: retLoc }, next: c.cursor.next(c.at) };
}

export function tryParseReturn(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  const retLoc = { line: c.innerNo, col: head.col };
  if (head.kind !== "ident") return null;
  const after = afterKeyword(c);
  if (after === "") {
    return {
      step: { type: "return", value: { kind: "literal", raw: '""' }, loc: retLoc },
      next: c.cursor.next(c.at),
    };
  }
  if (!/^\s/.test(after)) return null;
  const returnValue = after.trim();
  const value = c.tokens[1]!;
  const valueForm = { ...c, tokens: c.tokens.slice(1) };
  if (value.text.startsWith('"""')) {
    const { expr, next } = tripleQuotedArg(c, returnValue);
    return { step: { type: "return", value: expr, loc: retLoc }, next };
  }
  if (isKeywordForm(valueForm, "match")) {
    const afterMatch = returnValue === "match" ? "" : returnValue.slice("match ".length);
    const { expr, next } = parseMatchAfterKeyword(c.cursor, c.at, afterMatch, retLoc);
    return { step: { type: "return", value: { kind: "match", match: expr }, loc: retLoc }, next };
  }
  if (isKeywordForm(valueForm, "prompt")) {
    return parseReturnPrompt(c, returnValue, retLoc);
  }
  const spaced = value.kind === "ident" && afterKeyword(valueForm).startsWith(" ");
  if (spaced && value.text === "run" && !(c.tokens[2]?.kind === "punct" && c.tokens[2].text === "(")) {
    fail(
      c.filePath,
      "'run' is not a keyword; return the call directly: return name(...)",
      c.innerNo,
      firstCol(c, "run"),
    );
  }
  if (spaced && value.text === "ensure") {
    fail(c.filePath, "'ensure' is not a keyword; return the call directly: return name(...)", c.innerNo, firstCol(c, "ensure"));
  }
  if (isScriptHead(value)) {
    const result = parseAnonymousInlineScript(c.cursor, c.at, returnValue, c.innerNo, retLoc.col);
    const scriptValue = makeInlineScriptExpr(result, c.trivia);
    return { step: { type: "return", value: scriptValue, loc: retLoc }, next: result.next };
  }
  // Bare call `return ref(args)`. parseCallRefMultiline returns null when the
  // value does not start with `ref(`; when it starts with `ref(` but the call
  // is incomplete it calls fail() so the line never becomes a shell step.
  if (isCallShaped(c.tokens, 1, 1)) {
    const call = parseCallRefMultiline(c.cursor, c.at, returnValue);
    if (call) {
      rejectTrailingContent(c.filePath, c.innerNo, "return", call.rest);
      const callee = { value: call.ref, loc: retLoc };
      return {
        step: { type: "return", value: { kind: "call", callee, args: call.args }, loc: retLoc },
        next: call.next,
      };
    }
  }
  if (returnValue.startsWith("'")) {
    fail(c.filePath, SINGLE_QUOTE_MESSAGE, c.innerNo, retLoc.col);
  }
  if (/^[0-9]+$/.test(returnValue) || returnValue === "$?") {
    fail(
      c.filePath,
      'bash exit codes are only valid in scripts; use return "..." for a workflow value',
      c.innerNo,
      retLoc.col,
    );
  }
  if (
    returnValue.startsWith('"') ||
    returnValue.startsWith("$") ||
    isBareDottedIdentifierReturn(returnValue) ||
    isBareIdentifierReturn(returnValue)
  ) {
    return parseReturnString(c, returnValue, retLoc);
  }
  fail(
    c.filePath,
    'return value must be a string, identifier, call, prompt …, or match …',
    c.innerNo,
    retLoc.col,
  );
}
