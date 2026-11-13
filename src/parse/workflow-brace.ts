// Def-body statement dispatcher. `parseBraceBlockBody` walks a `{ … }` body
// one statement at a time on a `BodyCursor`; `parseBlockStatement` dispatches
// a statement on its first token through the `STATEMENT` table. The handlers
// live in the stmt-*.ts modules and reach back into these two functions only
// through `BlockCtx.parse`, so there is no import cycle.

import type { StepDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { BodyCursor, isPunct, keyOf } from "./body-cursor";
import { elseTerminator, tryParseElseError, tryParseFor, tryParseIf, tryParseStandaloneMatch } from "./stmt-control";
import { tryParseConst, tryBareCall, tryParseAsync, tryParseStdin } from "./stmt-invoke";
import { tryParseFail, tryParseLog, tryParseLogerr, tryParseLogwarn, tryParsePrompt, tryParseSend } from "./stmt-say";
import { tryParseReturn } from "./stmt-return";
import {
  applyAssignmentGuards,
  rejectNestedModuleForms,
  rejectNonStatement,
  rejectRouteDeclaration,
  tryConfigBlock,
  tryLegacySend,
  tryParseEnsureRemoved,
  tryParseExportInDef,
  tryParseLocalDef,
  tryParseLocalScript,
  tryParseRunKeywordRemoved,
  tryParseWait,
} from "./stmt-decl";
import type { BlockCtx, BlockHandler as Handler, BlockParseOpts, BlockResult, BodyParsers, BraceBodyResult } from "./block-ctx";

/** A `STATEMENT` row: parses one statement, or returns null to fall through. */
export type BlockHandler = Handler;

const PARSERS: BodyParsers = {
  body: (c, start, openerLineNo, opts) => parseBraceBlockBody(c.cursor, start, openerLineNo, c.trivia, opts),
  inline: (c, hostAt, stmt) => {
    // Blank lines before the statement keep the host line number in nested
    // error messages; the statement is the last line of its own source.
    const blank = c.cursor.lineNo(hostAt) - 1;
    const cursor = BodyCursor.of(c.filePath, "\n".repeat(blank) + stmt);
    return parseBlockStatement(cursor, blank, c.trivia, c.opts).step;
  },
};

function makeCtx(cursor: BodyCursor, at: number, trivia: Trivia, opts: BlockParseOpts | undefined): BlockCtx {
  const innerRaw = cursor.text(at);
  return {
    filePath: cursor.filePath,
    at,
    innerRaw,
    inner: innerRaw.trim(),
    innerNo: cursor.lineNo(at),
    trivia,
    opts,
    cursor,
    tokens: cursor.tokens(at),
    parse: PARSERS,
  };
}

/** A `#` comment line, kept as trivia. */
function commentStep(c: BlockCtx): StepDef {
  return { type: "trivia", kind: "comment", text: c.inner, loc: { line: c.innerNo, col: 1 } };
}

/** Parse statements until a closing `}` at the current block level. */
export function parseBraceBlockBody(
  cursor: BodyCursor,
  start: number,
  openerLineNo: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): BraceBodyResult {
  const steps: StepDef[] = [];
  let at = start;
  let hadNonCommentStep = false;
  while (!cursor.atEnd(at)) {
    const c = makeCtx(cursor, at, trivia, opts);
    const head = c.tokens[0];
    if (!head) {
      if (opts?.preserveBlankLines) {
        const last = steps[steps.length - 1];
        if (last && !(last.type === "trivia" && last.kind === "blank_line")) {
          steps.push({ type: "trivia", kind: "blank_line" });
        }
      }
      at = cursor.next(at);
      continue;
    }
    if (isComment(c)) {
      steps.push(commentStep(c));
      at = cursor.next(at);
      continue;
    }
    if (opts?.allowElseTerminator) {
      const terminator = elseTerminator(c);
      // `} else if ...` closes this body; the caller (the `if` handler)
      // re-reads this same line to parse the next arm, so `next` points at it.
      if (terminator === "else_if") return { steps, next: at, closedWithElseIf: true };
      if (terminator === "else") return { steps, next: cursor.next(at), closedWithElse: true };
    }
    if (isPunct(head, "}") && c.tokens.length === 1) {
      return { steps, next: cursor.next(at) };
    }
    const afterConfig = tryConfigBlock(c, hadNonCommentStep);
    if (afterConfig !== null) {
      at = afterConfig;
      continue;
    }
    // Nested defs carry no config scope and cannot re-import modules; without
    // this rejection both lines would fall through to the shell handler and
    // run under `sh -c` (same class as the nested `export` rejection).
    rejectNestedModuleForms(c);
    rejectRouteDeclaration(c);
    hadNonCommentStep = true;
    const one = dispatch(c);
    steps.push(one.step);
    at = one.next;
  }
  fail(cursor.filePath, 'unterminated block, expected "}"', openerLineNo);
}

/**
 * STATEMENT dispatch table keyed by the leading keyword: the first token when
 * it is an identifier, or the identifier an interpreter-tagged script token
 * starts with (`log'…'`). Each handler either returns a step (terminating),
 * calls `fail(...)` (also terminating), or returns null to allow fallthrough
 * to the bare-call / legacy-send handling.
 *
 * Null-prototype so a lookup of an `Object.prototype` name (`toString`,
 * `constructor`, `hasOwnProperty`, …) returns undefined and the line falls
 * through to the bare-call path like any other unknown name.
 *
 * To add a new top-level keyword, add (a) a row here pointing at the parser
 * and (b) the keyword to the JAIPH_KEYWORDS set in `core.ts`. No other file
 * needs to change.
 */
export const STATEMENT: Record<string, BlockHandler> = Object.assign(Object.create(null), {
  if: tryParseIf,
  else: tryParseElseError,
  for: tryParseFor,
  const: tryParseConst,
  export: tryParseExportInDef,
  script: tryParseLocalScript,
  def: tryParseLocalDef,
  fail: tryParseFail,
  wait: tryParseWait,
  ensure: tryParseEnsureRemoved,
  run: tryParseRunKeywordRemoved,
  async: tryParseAsync,
  stdin: tryParseStdin,
  prompt: tryParsePrompt,
  log: tryParseLog,
  logerr: tryParseLogerr,
  logwarn: tryParseLogwarn,
  return: tryParseReturn,
  match: tryParseStandaloneMatch,
  send: tryParseSend,
});

function isComment(c: BlockCtx): boolean {
  const head = c.tokens[0];
  return head?.kind === "other" && head.text.startsWith("#");
}

function dispatch(c: BlockCtx): BlockResult {
  if (isComment(c)) return { step: commentStep(c), next: c.cursor.next(c.at) };
  rejectNestedModuleForms(c);
  applyAssignmentGuards(c);
  const keyword = keyOf(c.tokens[0]);
  const handler = keyword === undefined ? undefined : STATEMENT[keyword];
  if (handler) {
    const result = handler(c);
    if (result) return result;
  }
  return tryBareCall(c) ?? tryLegacySend(c) ?? rejectNonStatement(c);
}

/**
 * One workflow statement inside `{ … }` (catch body, etc.).
 *
 * Dispatches on the first token through `STATEMENT`. A line that is not a
 * keyword statement and not a call is `E_PARSE`.
 */
export function parseBlockStatement(
  cursor: BodyCursor,
  at: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): BlockResult {
  return dispatch(makeCtx(cursor, at, trivia, opts));
}
