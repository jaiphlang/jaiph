import type { CatchBody, Expr, WorkflowMetadata, WorkflowStepDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import {
  colFromRaw,
  fail,
  hasUnescapedClosingQuote,
  indexOfClosingDoubleQuote,
  matchSendOperator,
  parseCallRef,
  parseLogMessageRhs,
  rejectTrailingContent,
} from "./core";
import { consumeTripleQuotedArg, dedentTripleQuotedBody, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseConstRhs } from "./const-rhs";
import { parseAnonymousInlineScript } from "./inline-script";
import { parseConfigBlock } from "./metadata";
import { parseAttachedBlock } from "./steps";
import { parsePromptStep } from "./prompt";
import { parseSendRhs } from "./send-rhs";
import { parseMatchExpr } from "./match";
import { dottedReturnToQuotedString, isBareDottedIdentifierReturn, isBareIdentifierReturn, bareIdentifierToQuotedString } from "./workflow-return-dotted";

export type BlockParseOpts = {
  forRule?: boolean;
  /** When true, push `blank_line` trivia steps so the formatter can preserve spacing. */
  preserveBlankLines?: boolean;
  /**
   * When set, allow a `config { … }` block as the first non-comment statement.
   * The callback receives the parsed metadata and may throw via `fail()` to
   * reject specific keys (workflows reject `runtime.*` and `module.*`).
   */
  onConfigBlock?: (metadata: WorkflowMetadata, lineNo: number) => void;
};

/** Parse statements until a closing `}` at the current block level. */
export function parseBraceBlockBody(
  filePath: string,
  lines: string[],
  startIdx: number,
  openerLineNo: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): { steps: WorkflowStepDef[]; nextIdx: number } {
  const steps: WorkflowStepDef[] = [];
  let idx = startIdx;
  let hadNonCommentStep = false;
  while (idx < lines.length) {
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    const innerNo = idx + 1;
    if (inner === "") {
      if (opts?.preserveBlankLines) {
        const last = steps[steps.length - 1];
        if (last && !(last.type === "trivia" && last.kind === "blank_line")) {
          steps.push({ type: "trivia", kind: "blank_line" });
        }
      }
      idx += 1;
      continue;
    }
    if (inner.startsWith("#")) {
      steps.push({
        type: "trivia",
        kind: "comment",
        text: innerRaw.trim(),
        loc: { line: innerNo, col: 1 },
      });
      idx += 1;
      continue;
    }
    if (inner === "}") {
      return { steps, nextIdx: idx + 1 };
    }
    if (opts?.onConfigBlock && /^config\s*\{/.test(inner)) {
      if (hadNonCommentStep) {
        fail(filePath, "config block inside workflow must appear before any steps", innerNo);
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, idx, trivia);
      opts.onConfigBlock(metadata, innerNo);
      idx = nextIndex;
      continue;
    }
    // Reject route declarations at body level: routes belong at the top of the file.
    const routeMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+->\s+(.+)$/,
    );
    if (routeMatch) {
      fail(
        filePath,
        `route declarations belong at the top level: channel ${routeMatch[1]} -> ${routeMatch[2].trim()}`,
        innerNo,
      );
    }
    hadNonCommentStep = true;
    const one = parseBlockStatement(filePath, lines, idx, trivia, opts);
    steps.push(one.step);
    idx = one.nextIdx;
  }
  fail(filePath, 'unterminated block, expected "}"', openerLineNo);
}

/** Build an `exec` step from a value expression and optional capture/catch/recover. */
function execStep(
  body: Expr,
  loc: { line: number; col: number },
  extras: { captureName?: string; catch?: CatchBody; recover?: CatchBody } = {},
): WorkflowStepDef {
  return {
    type: "exec",
    body,
    ...(extras.captureName ? { captureName: extras.captureName } : {}),
    ...(extras.catch ? { catch: extras.catch } : {}),
    ...(extras.recover ? { recover: extras.recover } : {}),
    loc,
  };
}

/**
 * Parse `run [async] <ref>(args)` or `ensure <ref>(args)`, optionally followed
 * by `catch (binding) { ... }` or — for `run` only — `recover(binding) { ... }`.
 *
 * The catch/recover clause is parsed via the unified `parseAttachedBlock`, whose
 * body uses the same `parseBlockStatement` as the top-level dispatcher.
 */
function parseRunOrEnsure(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  host: "run" | "ensure",
  hostBody: string,
  isAsync: boolean,
  captureName: string | undefined,
  trivia: Trivia,
): { step: WorkflowStepDef; nextIdx: number } {
  const hostName = host === "ensure" ? "ensure" : isAsync ? "run async" : "run";
  const hostCol = innerRaw.indexOf(host) + 1;
  const stepLoc = { line: innerNo, col: hostCol };

  if (/\scatch$/.test(hostBody)) {
    fail(
      filePath,
      'catch requires explicit bindings and a body: catch (<name>) { ... }',
      innerNo,
      innerRaw.indexOf("catch") + 1,
    );
  }
  if (host === "run" && / recover$/.test(hostBody)) {
    fail(
      filePath,
      'recover requires explicit bindings and a body: recover(<name>) { ... }',
      innerNo,
      innerRaw.indexOf("recover") + 1,
    );
  }

  let attached:
    | { keyword: "catch" | "recover"; left: string; after: string }
    | null = null;
  if (host === "run") {
    const m = hostBody.match(/ recover(?=[\s(])/);
    if (m) {
      const pos = m.index!;
      attached = {
        keyword: "recover",
        left: hostBody.slice(0, pos).trim(),
        after: hostBody.slice(pos + " recover".length),
      };
    }
  }
  if (!attached) {
    const ci = hostBody.indexOf(" catch ");
    if (ci !== -1) {
      attached = {
        keyword: "catch",
        left: hostBody.slice(0, ci).trim(),
        after: hostBody.slice(ci + " catch ".length),
      };
    }
  }

  // `run` falls back to plain parsing when the call before catch/recover has
  // trailing content, preserving the legacy "unexpected content" error shape.
  if (attached && host === "run") {
    const probe = parseCallRef(attached.left);
    if (!probe || probe.rest.trim()) {
      attached = null;
    }
  }

  if (!attached) {
    const call = parseCallRef(hostBody);
    if (!call) {
      fail(
        filePath,
        `${hostName} must target a valid reference: ${hostName} ref() or ${hostName} ref(args) — parentheses are required`,
        innerNo,
      );
    }
    rejectTrailingContent(filePath, innerNo, hostName, call.rest);
    const callee = { value: call.ref, loc: stepLoc };
    const body: Expr = host === "ensure"
      ? { kind: "ensure_call", callee, args: call.args }
      : { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };
    return { step: execStep(body, stepLoc, { captureName }), nextIdx: idx + 1 };
  }

  const call = parseCallRef(attached.left);
  if (!call) {
    fail(
      filePath,
      `${hostName} must target a valid reference: ${hostName} ref() or ${hostName} ref(args) — parentheses are required`,
      innerNo,
    );
  }
  rejectTrailingContent(filePath, innerNo, hostName, call.rest);
  const callee = { value: call.ref, loc: stepLoc };
  const body: Expr = host === "ensure"
    ? { kind: "ensure_call", callee, args: call.args }
    : { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };

  const result = parseAttachedBlock(
    filePath, lines, idx, innerNo, innerRaw, attached.keyword, attached.after, trivia,
  );
  const extras = attached.keyword === "catch"
    ? { captureName, catch: result.body }
    : { captureName, recover: result.body };
  return { step: execStep(body, stepLoc, extras), nextIdx: result.nextIdx };
}

export type BlockCtx = {
  filePath: string;
  lines: string[];
  idx: number;
  innerRaw: string;
  inner: string;
  innerNo: number;
  trivia: Trivia;
  forRule: boolean;
  opts: BlockParseOpts | undefined;
};
export type BlockResult = { step: WorkflowStepDef; nextIdx: number };
export type BlockHandler = (c: BlockCtx) => BlockResult | null;

function tryParseIf(c: BlockCtx): BlockResult | null {
  const ifLoc = { line: c.innerNo, col: c.innerRaw.indexOf("if") + 1 };
  const m = c.inner.match(
    /^if\s+([A-Za-z_][A-Za-z0-9_]*)\s+(==|!=|=~|!~)\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/)\s*\{\s*$/,
  );
  if (!m) {
    if (/^if[\s(]/.test(c.inner)) {
      fail(
        c.filePath,
        'invalid if syntax; expected: if <identifier> <op> <operand> { ... } where op is ==, !=, =~, or !~ and operand is "string" or /regex/',
        c.innerNo,
        ifLoc.col,
      );
    }
    return null;
  }
  const subject = m[1];
  const operator = m[2] as "==" | "!=" | "=~" | "!~";
  const rawOperand = m[3];
  const operand: { kind: "string_literal"; value: string } | { kind: "regex"; source: string } =
    rawOperand.startsWith('"')
      ? { kind: "string_literal", value: rawOperand.slice(1, -1) }
      : { kind: "regex", source: rawOperand.slice(1, -1) };
  if ((operator === "==" || operator === "!=") && operand.kind === "regex") {
    fail(c.filePath, `operator "${operator}" requires a string operand ("..."), not a regex`, c.innerNo, ifLoc.col);
  }
  if ((operator === "=~" || operator === "!~") && operand.kind === "string_literal") {
    fail(c.filePath, `operator "${operator}" requires a regex operand (/pattern/), not a string`, c.innerNo, ifLoc.col);
  }
  const { steps: body, nextIdx } = parseBraceBlockBody(c.filePath, c.lines, c.idx + 1, c.innerNo, c.trivia);
  return { step: { type: "if", subject, operator, operand, body, loc: ifLoc }, nextIdx };
}

function tryParseFor(c: BlockCtx): BlockResult | null {
  const forLoc = { line: c.innerNo, col: c.innerRaw.indexOf("for") + 1 };
  const m = c.inner.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/);
  if (!m) {
    if (/^for\s/.test(c.inner)) {
      fail(
        c.filePath,
        'invalid for syntax; expected: for <identifier> in <identifier> { ... }',
        c.innerNo,
        forLoc.col,
      );
    }
    return null;
  }
  const { steps: body, nextIdx } = parseBraceBlockBody(c.filePath, c.lines, c.idx + 1, c.innerNo, c.trivia, c.opts);
  return { step: { type: "for_lines", iterVar: m[1], sourceVar: m[2], body, loc: forLoc }, nextIdx };
}

function tryParseConst(c: BlockCtx): BlockResult | null {
  const m = c.inner.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
  if (!m) return null;
  const name = m[1];
  const rhs = m[2].trim();
  const { value, nextLineIdx } = parseConstRhs(
    c.filePath, c.lines, c.idx, rhs, c.innerNo, c.innerRaw.indexOf(rhs) + 1, c.forRule, name, c.trivia,
  );
  const nextLine = nextLineIdx > c.idx ? nextLineIdx + 1 : c.idx + 1;
  return {
    step: { type: "const", name, value, loc: { line: c.innerNo, col: c.innerRaw.indexOf("const") + 1 } },
    nextIdx: nextLine,
  };
}

function tryParseFail(c: BlockCtx): BlockResult | null {
  if (!/^fail\s+/.test(c.inner)) return null;
  const arg = c.inner.slice("fail".length).trimStart();
  const failCol = c.innerRaw.indexOf("fail") + 1;
  const stepLoc = { line: c.innerNo, col: failCol };
  if (arg.startsWith('"""')) {
    const { body, nextIdx } = consumeTripleQuotedArg(c.filePath, c.lines, c.idx, arg);
    const raw = tripleQuoteBodyToRaw(dedentTripleQuotedBody(body));
    const message: Expr = { kind: "literal", raw };
    c.trivia.setNode(message, { tripleQuoted: true, rawBody: body });
    return { step: { type: "say", level: "fail", message, loc: stepLoc }, nextIdx };
  }
  if (!arg.startsWith('"')) {
    fail(c.filePath, 'fail must match: fail "<reason>" or fail """..."""', c.innerNo, failCol);
  }
  if (!hasUnescapedClosingQuote(arg, 1)) {
    fail(c.filePath, 'multiline strings use triple quotes: fail """..."""', c.innerNo, failCol);
  }
  const closeIdx = indexOfClosingDoubleQuote(arg, 1);
  if (closeIdx === -1) {
    fail(c.filePath, "unterminated fail string", c.innerNo, failCol);
  }
  const raw = arg.slice(0, closeIdx + 1);
  return {
    step: { type: "say", level: "fail", message: { kind: "literal", raw }, loc: stepLoc },
    nextIdx: c.idx + 1,
  };
}

function tryParseWait(c: BlockCtx): BlockResult | null {
  if (c.inner !== "wait") return null;
  fail(c.filePath, '"wait" has been removed from the language', c.innerNo, c.innerRaw.indexOf("wait") + 1);
}

function tryParseEnsure(c: BlockCtx): BlockResult | null {
  if (!c.inner.startsWith("ensure ")) return null;
  const ensureBody = c.inner.slice("ensure ".length).trim();
  return parseRunOrEnsure(
    c.filePath, c.lines, c.idx, c.innerNo, c.innerRaw, "ensure", ensureBody, false, undefined, c.trivia,
  );
}

function tryParseRun(c: BlockCtx): BlockResult | null {
  if (!c.inner.startsWith("run ")) return null;
  const runCol = c.innerRaw.indexOf("run") + 1;
  if (c.inner.startsWith("run async ")) {
    const runBody = c.inner.slice("run async ".length).trim();
    if (runBody.startsWith("`")) {
      fail(c.filePath, "run async is not supported with inline scripts", c.innerNo, runCol);
    }
    return parseRunOrEnsure(
      c.filePath, c.lines, c.idx, c.innerNo, c.innerRaw, "run", runBody, true, undefined, c.trivia,
    );
  }
  const runBody = c.inner.slice("run ".length).trim();
  if (runBody.startsWith("`")) {
    const result = parseAnonymousInlineScript(c.filePath, c.lines, c.idx, runBody, c.innerNo, runCol);
    return {
      step: execStep(
        { kind: "inline_script", body: result.body, ...(result.lang ? { lang: result.lang } : {}), args: result.args },
        { line: c.innerNo, col: runCol },
      ),
      nextIdx: result.nextLineIdx,
    };
  }
  if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
    fail(c.filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', c.innerNo);
  }
  return parseRunOrEnsure(
    c.filePath, c.lines, c.idx, c.innerNo, c.innerRaw, "run", runBody, false, undefined, c.trivia,
  );
}

function tryParsePrompt(c: BlockCtx): BlockResult | null {
  if (!c.inner.startsWith("prompt ")) return null;
  const promptCol = c.innerRaw.indexOf("prompt") + 1;
  const promptArg = c.innerRaw.slice(c.innerRaw.indexOf("prompt") + "prompt".length).trimStart();
  const result = parsePromptStep(c.filePath, c.lines, c.idx, promptArg, promptCol, undefined, c.trivia);
  return { step: result.step, nextIdx: result.nextLineIdx + 1 };
}

function parseSayBody(
  c: BlockCtx,
  level: "log" | "logerr",
): BlockResult {
  const arg = c.inner.slice(level.length).trimStart();
  const col = c.innerRaw.indexOf(level) + 1;
  const stepLoc = { line: c.innerNo, col };
  if (arg.startsWith("run ") && arg.slice("run ".length).trimStart().startsWith("`")) {
    const runBody = arg.slice("run ".length).trim();
    const result = parseAnonymousInlineScript(c.filePath, c.lines, c.idx, runBody, c.innerNo, col);
    const message: Expr = {
      kind: "inline_script",
      body: result.body,
      ...(result.lang ? { lang: result.lang } : {}),
      args: result.args,
    };
    return { step: { type: "say", level, message, loc: stepLoc }, nextIdx: result.nextLineIdx };
  }
  if (arg.startsWith("`") || arg.startsWith("```")) {
    fail(c.filePath, `bare inline scripts in ${level} are not allowed; use "${level} run \`...\`()" to execute a managed inline script`, c.innerNo, col);
  }
  if (arg.startsWith('"""')) {
    const { body, nextIdx } = consumeTripleQuotedArg(c.filePath, c.lines, c.idx, arg);
    const raw = dedentTripleQuotedBody(body);
    const message: Expr = { kind: "literal", raw };
    c.trivia.setNode(message, { tripleQuoted: true, rawBody: body });
    return { step: { type: "say", level, message, loc: stepLoc }, nextIdx };
  }
  if (arg.startsWith('"') && !hasUnescapedClosingQuote(arg, 1)) {
    fail(c.filePath, `multiline strings use triple quotes: ${level} """..."""`, c.innerNo, col);
  }
  const messageRaw = parseLogMessageRhs(c.filePath, c.innerNo, col, arg, level);
  return {
    step: { type: "say", level, message: { kind: "literal", raw: messageRaw }, loc: stepLoc },
    nextIdx: c.idx + 1,
  };
}

function tryParseLog(c: BlockCtx): BlockResult | null {
  if (!c.inner.startsWith("log ") && c.inner !== "log") return null;
  return parseSayBody(c, "log");
}

function tryParseLogerr(c: BlockCtx): BlockResult | null {
  if (!c.inner.startsWith("logerr ") && c.inner !== "logerr") return null;
  return parseSayBody(c, "logerr");
}

function tryParseReturn(c: BlockCtx): BlockResult | null {
  const retLoc = { line: c.innerNo, col: c.innerRaw.indexOf("return") + 1 };
  if (c.inner.trim() === "return") {
    return {
      step: { type: "return", value: { kind: "literal", raw: '""' }, loc: retLoc },
      nextIdx: c.idx + 1,
    };
  }
  const m = c.inner.match(/^return\s+(.+)$/s);
  if (!m) return null;
  const returnValue = m[1].trim();
  if (returnValue.startsWith('"""')) {
    const { body, nextIdx } = consumeTripleQuotedArg(c.filePath, c.lines, c.idx, returnValue);
    const value: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
    c.trivia.setNode(value, { tripleQuoted: true, rawBody: body });
    return { step: { type: "return", value, loc: retLoc }, nextIdx };
  }
  const matchHead = returnValue.match(/^match\s+(.+?)\s*\{\s*$/);
  if (matchHead) {
    const { expr, nextIndex } = parseMatchExpr(c.filePath, c.lines, c.idx, matchHead[1].trim(), retLoc);
    return { step: { type: "return", value: { kind: "match", match: expr }, loc: retLoc }, nextIdx: nextIndex };
  }
  if (returnValue.startsWith("run ")) {
    const runBody = returnValue.slice("run ".length).trim();
    if (runBody.startsWith("`")) {
      const result = parseAnonymousInlineScript(c.filePath, c.lines, c.idx, runBody, c.innerNo, c.innerRaw.indexOf("run") + 1);
      const value: Expr = {
        kind: "inline_script",
        body: result.body,
        ...(result.lang ? { lang: result.lang } : {}),
        args: result.args,
      };
      return { step: { type: "return", value, loc: retLoc }, nextIdx: result.nextLineIdx };
    }
    const call = parseCallRef(runBody);
    if (call) {
      rejectTrailingContent(c.filePath, c.innerNo, "run", call.rest);
      const callee = { value: call.ref, loc: retLoc };
      return {
        step: { type: "return", value: { kind: "call", callee, args: call.args }, loc: retLoc },
        nextIdx: c.idx + 1,
      };
    }
  }
  if (returnValue.startsWith("ensure ")) {
    const call = parseCallRef(returnValue.slice("ensure ".length).trim());
    if (call) {
      rejectTrailingContent(c.filePath, c.innerNo, "ensure", call.rest);
      const callee = { value: call.ref, loc: retLoc };
      return {
        step: { type: "return", value: { kind: "ensure_call", callee, args: call.args }, loc: retLoc },
        nextIdx: c.idx + 1,
      };
    }
  }
  if (returnValue.startsWith("`") || returnValue.startsWith("```")) {
    fail(c.filePath, 'bare inline scripts in return are not allowed; use "return run `...`()" to execute a managed inline script', c.innerNo, retLoc.col);
  }
  if (returnValue.startsWith("'")) {
    fail(c.filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', c.innerNo, retLoc.col);
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
    if (returnValue.startsWith('"') && !hasUnescapedClosingQuote(returnValue, 1)) {
      fail(c.filePath, 'multiline strings use triple quotes: return """..."""', c.innerNo, retLoc.col);
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
    return { step: { type: "return", value, loc: retLoc }, nextIdx: c.idx + 1 };
  }
  return null;
}

function tryParseStandaloneMatch(c: BlockCtx): BlockResult | null {
  const m = c.inner.match(/^match\s+(.+?)\s*\{\s*$/);
  if (!m) return null;
  const subject = m[1].trim();
  const matchLoc = { line: c.innerNo, col: c.innerRaw.indexOf("match") + 1 };
  const { expr, nextIndex } = parseMatchExpr(c.filePath, c.lines, c.idx, subject, matchLoc);
  return { step: execStep({ kind: "match", match: expr }, matchLoc), nextIdx: nextIndex };
}

/**
 * STATEMENT dispatch table keyed by the leading keyword. Handlers fire only
 * when the first token matches the key; each handler either returns a step
 * (terminating), calls `fail(...)` (also terminating), or returns null to
 * allow fallthrough to send / shell handling.
 *
 * To add a new top-level keyword, add (a) a row here pointing at the parser
 * and (b) the keyword to the JAIPH_KEYWORDS set in `core.ts`. No other file
 * needs to change.
 */
export const STATEMENT: Record<string, BlockHandler> = {
  if: tryParseIf,
  for: tryParseFor,
  const: tryParseConst,
  fail: tryParseFail,
  wait: tryParseWait,
  ensure: tryParseEnsure,
  run: tryParseRun,
  prompt: tryParsePrompt,
  log: tryParseLog,
  logerr: tryParseLogerr,
  return: tryParseReturn,
  match: tryParseStandaloneMatch,
};

/** Error guards for assignment-shape lines. Emit a fail() or no-op; never return a step. */
function applyAssignmentGuards(c: BlockCtx): void {
  if (c.forRule && (c.inner.startsWith("prompt ") || /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*prompt\s/.test(c.inner))) {
    fail(c.filePath, "prompt is not allowed in rules", c.innerNo, colFromRaw(c.innerRaw));
  }
  const promptAssign = c.inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s);
  if (promptAssign) {
    fail(
      c.filePath,
      'use "const name = prompt ..." to capture the prompt result (e.g. const answer = prompt "..." )',
      c.innerNo,
      c.innerRaw.indexOf(promptAssign[1]) + 1,
    );
  }
  const generic = c.inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
  if (
    generic &&
    !generic[2].trimStart().startsWith("prompt ") &&
    !generic[2].trimStart().startsWith('"') &&
    !generic[2].trimStart().startsWith("$")
  ) {
    const captureName = generic[1];
    const rest = generic[2].trim();
    if (rest.startsWith("run ") || rest.startsWith("ensure ")) {
      fail(
        c.filePath,
        `assignment without "const" is no longer supported; use "const ${captureName} = ${rest}"`,
        c.innerNo,
        c.innerRaw.indexOf(captureName) + 1,
      );
    }
  }
}

function trySend(c: BlockCtx): BlockResult | null {
  const sendMatch = matchSendOperator(c.inner);
  if (!sendMatch) return null;
  if (c.forRule) {
    fail(c.filePath, "send operator is not allowed in rules", c.innerNo, 1);
  }
  const arrowIdx = c.inner.indexOf("<-");
  const rhsCol = arrowIdx >= 0 ? arrowIdx + 3 : 1;
  const { value, nextIdx } = parseSendRhs(
    c.filePath, sendMatch.rhsText, c.innerNo, rhsCol, c.lines, c.idx, c.trivia,
  );
  return {
    step: { type: "send", channel: sendMatch.channel, value, loc: { line: c.innerNo, col: 1 } },
    nextIdx,
  };
}

function shellFallthrough(c: BlockCtx): BlockResult {
  const loc = { line: c.innerNo, col: colFromRaw(c.innerRaw) };
  return { step: execStep({ kind: "shell", command: c.inner, loc }, loc), nextIdx: c.idx + 1 };
}

/**
 * One workflow statement inside `{ … }` (catch body, etc.).
 *
 * Dispatches by leading keyword through `STATEMENT`; falls through to send /
 * shell for non-keyword lines.
 */
export function parseBlockStatement(
  filePath: string,
  lines: string[],
  idx: number,
  trivia: Trivia = createTrivia(),
  opts?: BlockParseOpts,
): { step: WorkflowStepDef; nextIdx: number } {
  const innerRaw = lines[idx];
  const inner = innerRaw.trim();
  const innerNo = idx + 1;
  const c: BlockCtx = {
    filePath, lines, idx, innerRaw, inner, innerNo, trivia,
    forRule: opts?.forRule === true, opts,
  };

  if (inner.startsWith("#")) {
    return {
      step: { type: "trivia", kind: "comment", text: innerRaw.trim(), loc: { line: innerNo, col: 1 } },
      nextIdx: idx + 1,
    };
  }

  applyAssignmentGuards(c);

  const keyword = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (keyword) {
    const handler = STATEMENT[keyword];
    if (handler) {
      const result = handler(c);
      if (result) return result;
    }
  }

  return trySend(c) ?? shellFallthrough(c);
}
