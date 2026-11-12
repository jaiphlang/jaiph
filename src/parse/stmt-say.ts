// Message statements in a def body: `fail`, `log` / `logerr` / `logwarn`,
// `send … -> channel`, and `prompt` (a prompt step, or a nested named-prompt
// definition).

import type { Expr } from "../types";
import {
  fail,
  isJaiphInterpolationRef,
  matchSendOperator,
  parseLogMessageRhs,
  parseSendChannelArrow,
} from "./core";
import { readTripleQuoteBlock } from "./triple-quote";
import { parseAnonymousInlineScript } from "./inline-script";
import { parsePromptStep } from "./prompt";
import { parsePromptDefBlock } from "./prompt-def";
import { parseSendRhs } from "./send-rhs";
import { isScriptHead } from "./stmt-call";
import {
  afterKeyword,
  isKeywordForm,
  localDeclStep,
  makeInlineScriptExpr,
  makeTripleQuotedLiteral,
  tripleQuotedArg,
  type BlockCtx,
  type BlockHandler,
  type BlockResult,
} from "./block-ctx";

export function tryParseFail(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  if (head.kind !== "ident" || !/^\s/.test(afterKeyword(c))) return null;
  const arg = c.inner.slice("fail".length).trimStart();
  const failCol = head.col;
  const stepLoc = { line: c.innerNo, col: failCol };
  if (c.tokens[1]?.text.startsWith('"""')) {
    const { expr: message, nextIdx } = tripleQuotedArg(c, arg);
    return { step: { type: "say", level: "fail", message, loc: stepLoc }, nextIdx };
  }
  if (isJaiphInterpolationRef(arg.trim())) {
    const message: Expr = { kind: "literal", raw: arg.trim() };
    return { step: { type: "say", level: "fail", message, loc: stepLoc }, nextIdx: c.idx + 1 };
  }
  const message = c.tokens[1];
  if (!message?.text.startsWith('"')) {
    fail(c.filePath, 'fail must match: fail "<reason>" or fail """..."""', c.innerNo, failCol);
  }
  // A quote the lexer could not close is the rest of the line as one `other` token.
  if (message.kind !== "string") {
    fail(c.filePath, 'multiline strings use triple quotes: fail """..."""', c.innerNo, failCol);
  }
  return {
    step: { type: "say", level: "fail", message: { kind: "literal", raw: message.text }, loc: stepLoc },
    nextIdx: c.idx + 1,
  };
}

function parseSayBody(c: BlockCtx, level: "log" | "logerr" | "logwarn"): BlockResult {
  const arg = c.inner.slice(level.length).trimStart();
  const col = c.tokens[0]!.col;
  const stepLoc = { line: c.innerNo, col };
  if (isScriptHead(c.tokens[1])) {
    const result = parseAnonymousInlineScript(c.filePath, c.lines, c.idx, arg, c.innerNo, col);
    const message = makeInlineScriptExpr(result, c.trivia);
    return { step: { type: "say", level, message, loc: stepLoc }, nextIdx: result.nextLineIdx };
  }
  if (c.tokens[1]?.text.startsWith('"""')) {
    const { expr: message, nextIdx } = tripleQuotedArg(c, arg);
    return { step: { type: "say", level, message, loc: stepLoc }, nextIdx };
  }
  const quoted = c.tokens[1];
  let messageRaw: string;
  if (quoted?.text.startsWith('"')) {
    if (quoted.kind !== "string") {
      fail(c.filePath, `multiline strings use triple quotes: ${level} """..."""`, c.innerNo, col);
    }
    const trailing = c.cursor.textAfter(quoted).trim();
    if (trailing) {
      fail(c.filePath, `unexpected content after ${level} string: '${trailing}'`, c.innerNo, col);
    }
    messageRaw = quoted.text;
  } else {
    messageRaw = parseLogMessageRhs(c.filePath, c.innerNo, col, arg, level);
  }
  return {
    step: { type: "say", level, message: { kind: "literal", raw: messageRaw }, loc: stepLoc },
    nextIdx: c.idx + 1,
  };
}

/** Build a `log`/`logerr`/`logwarn` handler that fires on `<level>` or `<level> …`. */
function makeSayHandler(level: "log" | "logerr" | "logwarn"): BlockHandler {
  return (c) => (isKeywordForm(c, level) ? parseSayBody(c, level) : null);
}

export const tryParseLog = makeSayHandler("log");
export const tryParseLogerr = makeSayHandler("logerr");
export const tryParseLogwarn = makeSayHandler("logwarn");

/**
 * A named-prompt *definition* (`prompt name(params) [use …] = …`) — distinct
 * from a prompt *step* / invocation. The `= ` after the parameter list is the
 * discriminator: an invocation `prompt foo(a)` has no `=`.
 */
function looksLikeNamedPromptDef(inner: string): boolean {
  return /^prompt\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)(?:\s+use\s+[^=]+?)?\s*=/.test(inner);
}

export function tryParsePrompt(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  if (head.kind !== "ident" || !afterKeyword(c).startsWith(" ")) return null;
  const promptCol = head.col;
  if (looksLikeNamedPromptDef(c.inner)) {
    const { promptDef, nextIndex } = parsePromptDefBlock(c.filePath, c.lines, c.idx, [], c.trivia);
    const loc = { line: c.innerNo, col: promptCol };
    return { step: localDeclStep(c.filePath, { kind: "prompt", prompt: promptDef }, loc), nextIdx: nextIndex };
  }
  const promptArg = c.innerRaw.slice(promptCol - 1 + "prompt".length).trimStart();
  const result = parsePromptStep(c.filePath, c.lines, c.idx, promptArg, promptCol, undefined, c.trivia);
  return { step: result.step, nextIdx: result.nextLineIdx + 1 };
}

export function tryParseSend(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "send")) return null;
  const rest = c.inner.slice("send".length).trimStart();
  if (c.tokens[1]?.text.startsWith('"""')) {
    const { body, nextIdx, afterClose } = readTripleQuoteBlock(c.filePath, c.lines, c.idx, rest);
    const channel = parseSendChannelArrow(afterClose);
    if (!channel) {
      fail(c.filePath, "use 'send <payload> -> <channel>'", c.innerNo);
    }
    const value = makeTripleQuotedLiteral(c.trivia, body);
    return {
      step: { type: "send", channel, value, loc: { line: c.innerNo, col: 1 } },
      nextIdx,
    };
  }
  const sendMatch = matchSendOperator(c.inner);
  if (!sendMatch) {
    fail(c.filePath, "use 'send <payload> -> <channel>'", c.innerNo);
  }
  const rhsCol = c.tokens[1]!.col;
  const { value, nextIdx } = parseSendRhs(
    c.filePath, sendMatch.rhsText, c.innerNo, rhsCol, c.lines, c.idx, c.trivia,
  );
  return {
    step: { type: "send", channel: sendMatch.channel, value, loc: { line: c.innerNo, col: 1 } },
    nextIdx,
  };
}
