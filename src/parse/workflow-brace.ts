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
  body: (c, startIdx, openerLineNo, opts) =>
    parseBraceBlockBody(c.filePath, c.lines, startIdx, openerLineNo, c.trivia, opts),
  inline: (c, hostIdx, stmt) => {
    // Padded lines keep the host line number in nested error messages.
    const padded = new Array<string>(hostIdx).fill("");
    padded.push(stmt);
    return parseBlockStatement(c.filePath, padded, hostIdx, c.trivia, c.opts).step;
  },
};

function makeCtx(cursor: BodyCursor, idx: number, trivia: Trivia, opts: BlockParseOpts | undefined): BlockCtx {
  const innerRaw = cursor.lines[idx]!;
  return {
    filePath: cursor.filePath,
    lines: cursor.lines,
    idx,
    innerRaw,
    inner: innerRaw.trim(),
    innerNo: idx + 1,
    trivia,
    opts,
    cursor,
    tokens: cursor.tokens(idx),
    parse: PARSERS,
  };
}

/** A `#` comment line, kept as trivia. */
function commentStep(c: BlockCtx): StepDef {
  return { type: "trivia", kind: "comment", text: c.inner, loc: { line: c.innerNo, col: 1 } };
}

/** Parse statements until a closing `}` at the current block level. */
export function parseBraceBlockBody(
  filePath: string,
  lines: string[],
  startIdx: number,
  openerLineNo: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): BraceBodyResult {
  const cursor = BodyCursor.of(filePath, lines);
  const steps: StepDef[] = [];
  let idx = startIdx;
  let hadNonCommentStep = false;
  while (idx < lines.length) {
    const c = makeCtx(cursor, idx, trivia, opts);
    const head = c.tokens[0];
    if (!head) {
      if (opts?.preserveBlankLines) {
        const last = steps[steps.length - 1];
        if (last && !(last.type === "trivia" && last.kind === "blank_line")) {
          steps.push({ type: "trivia", kind: "blank_line" });
        }
      }
      idx += 1;
      continue;
    }
    if (isComment(c)) {
      steps.push(commentStep(c));
      idx += 1;
      continue;
    }
    if (opts?.allowElseTerminator) {
      const terminator = elseTerminator(c);
      // `} else if ...` closes this body; the caller (the `if` handler)
      // re-reads this same line to parse the next arm, so nextIdx points at it.
      if (terminator === "else_if") return { steps, nextIdx: idx, closedWithElseIf: true };
      if (terminator === "else") return { steps, nextIdx: idx + 1, closedWithElse: true };
    }
    if (isPunct(head, "}") && c.tokens.length === 1) {
      return { steps, nextIdx: idx + 1 };
    }
    const afterConfig = tryConfigBlock(c, hadNonCommentStep);
    if (afterConfig !== null) {
      idx = afterConfig;
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
    idx = one.nextIdx;
  }
  fail(filePath, 'unterminated block, expected "}"', openerLineNo);
}

/**
 * STATEMENT dispatch table keyed by the leading keyword: the first token when
 * it is an identifier, or the identifier an interpreter-tagged script token
 * starts with (`log'…'`). Each handler either returns a step (terminating),
 * calls `fail(...)` (also terminating), or returns null to allow fallthrough
 * to the bare-call / legacy-send handling.
 *
 * To add a new top-level keyword, add (a) a row here pointing at the parser
 * and (b) the keyword to the JAIPH_KEYWORDS set in `core.ts`. No other file
 * needs to change.
 */
export const STATEMENT: Record<string, BlockHandler> = {
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
};

function isComment(c: BlockCtx): boolean {
  const head = c.tokens[0];
  return head?.kind === "other" && head.text.startsWith("#");
}

function dispatch(c: BlockCtx): BlockResult {
  if (isComment(c)) return { step: commentStep(c), nextIdx: c.idx + 1 };
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
  filePath: string,
  lines: string[],
  idx: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): BlockResult {
  return dispatch(makeCtx(BodyCursor.of(filePath, lines), idx, trivia, opts));
}
