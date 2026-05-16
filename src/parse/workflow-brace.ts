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
import { parseEnsureStep, parseRunCatchStep, parseRunRecoverStep } from "./steps";
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
 * One workflow statement inside `{ … }` (catch body, etc.).
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
  const forRule = opts?.forRule === true;

  if (inner.startsWith("#")) {
    return {
      step: {
        type: "trivia",
        kind: "comment",
        text: innerRaw.trim(),
        loc: { line: innerNo, col: 1 },
      },
      nextIdx: idx + 1,
    };
  }

  // if <subject> <op> <operand> { ... }
  const ifHead = inner.match(
    /^if\s+([A-Za-z_][A-Za-z0-9_]*)\s+(==|!=|=~|!~)\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/)\s*\{\s*$/,
  );
  if (ifHead) {
    const subject = ifHead[1];
    const operator = ifHead[2] as "==" | "!=" | "=~" | "!~";
    const rawOperand = ifHead[3];
    const ifLoc = { line: innerNo, col: innerRaw.indexOf("if") + 1 };

    let operand: { kind: "string_literal"; value: string } | { kind: "regex"; source: string };
    if (rawOperand.startsWith('"')) {
      operand = { kind: "string_literal", value: rawOperand.slice(1, -1) };
    } else {
      operand = { kind: "regex", source: rawOperand.slice(1, -1) };
    }

    if ((operator === "==" || operator === "!=") && operand.kind === "regex") {
      fail(filePath, `operator "${operator}" requires a string operand ("..."), not a regex`, innerNo, ifLoc.col);
    }
    if ((operator === "=~" || operator === "!~") && operand.kind === "string_literal") {
      fail(filePath, `operator "${operator}" requires a regex operand (/pattern/), not a string`, innerNo, ifLoc.col);
    }

    const { steps: body, nextIdx } = parseBraceBlockBody(filePath, lines, idx + 1, innerNo, trivia);
    return {
      step: { type: "if", subject, operator, operand, body, loc: ifLoc },
      nextIdx,
    };
  }
  if (/^if[\s(]/.test(inner)) {
    fail(
      filePath,
      'invalid if syntax; expected: if <identifier> <op> <operand> { ... } where op is ==, !=, =~, or !~ and operand is "string" or /regex/',
      innerNo,
      innerRaw.indexOf("if") + 1,
    );
  }

  // for <iter> in <string-var> { ... }
  const forHead = inner.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/);
  if (forHead) {
    const iterVar = forHead[1];
    const sourceVar = forHead[2];
    const forLoc = { line: innerNo, col: innerRaw.indexOf("for") + 1 };
    const { steps: body, nextIdx } = parseBraceBlockBody(filePath, lines, idx + 1, innerNo, trivia, opts);
    return {
      step: { type: "for_lines", iterVar, sourceVar, body, loc: forLoc },
      nextIdx,
    };
  }
  if (/^for\s/.test(inner)) {
    fail(
      filePath,
      'invalid for syntax; expected: for <identifier> in <identifier> { ... }',
      innerNo,
      innerRaw.indexOf("for") + 1,
    );
  }

  const constMatch = inner.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
  if (constMatch) {
    const name = constMatch[1];
    const rhs = constMatch[2].trim();
    const { value, nextLineIdx } = parseConstRhs(
      filePath, lines, idx, rhs, innerNo, innerRaw.indexOf(rhs) + 1, forRule, name, trivia,
    );
    const nextLine = nextLineIdx > idx ? nextLineIdx + 1 : idx + 1;
    return {
      step: { type: "const", name, value, loc: { line: innerNo, col: innerRaw.indexOf("const") + 1 } },
      nextIdx: nextLine,
    };
  }

  const failMatch = inner.match(/^fail\s+/);
  if (failMatch) {
    const arg = inner.slice("fail".length).trimStart();
    const failCol = innerRaw.indexOf("fail") + 1;
    if (arg.startsWith('"""')) {
      const { body, nextIdx } = consumeTripleQuotedArg(filePath, lines, idx, arg);
      const raw = tripleQuoteBodyToRaw(dedentTripleQuotedBody(body));
      const message: Expr = { kind: "literal", raw };
      trivia.setNode(message, { tripleQuoted: true, rawBody: body });
      const step: WorkflowStepDef = { type: "say", level: "fail", message, loc: { line: innerNo, col: failCol } };
      return { step, nextIdx };
    }
    if (!arg.startsWith('"')) {
      fail(filePath, 'fail must match: fail "<reason>" or fail """..."""', innerNo, failCol);
    }
    if (!hasUnescapedClosingQuote(arg, 1)) {
      fail(filePath, 'multiline strings use triple quotes: fail """..."""', innerNo, failCol);
    }
    const closeIdx = indexOfClosingDoubleQuote(arg, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated fail string", innerNo, failCol);
    }
    const raw = arg.slice(0, closeIdx + 1);
    return {
      step: {
        type: "say",
        level: "fail",
        message: { kind: "literal", raw },
        loc: { line: innerNo, col: failCol },
      },
      nextIdx: idx + 1,
    };
  }

  if (inner === "wait") {
    fail(filePath, '"wait" has been removed from the language', innerNo, innerRaw.indexOf("wait") + 1);
  }

  if (inner.startsWith("ensure ")) {
    const ensureBody = inner.slice("ensure ".length).trim();
    const r = parseEnsureStep(
      filePath, lines, idx, innerNo, innerRaw,
      ensureBody, undefined, trivia,
    );
    return { step: r.step, nextIdx: r.nextIdx + 1 };
  }

  if (inner.startsWith("run async ")) {
    const runBody = inner.slice("run async ".length).trim();
    const runCol = innerRaw.indexOf("run") + 1;
    if (runBody.startsWith("`")) {
      fail(filePath, "run async is not supported with inline scripts", innerNo, runCol);
    }
    // run async ... recover(name) { ... }
    const recoverResult = parseRunRecoverStep(filePath, lines, idx, innerNo, innerRaw, runBody, undefined, trivia);
    if (recoverResult && recoverResult.step.type === "exec" && recoverResult.step.body.kind === "call") {
      const body: Expr = { ...recoverResult.step.body, async: true };
      return {
        step: { ...recoverResult.step, body },
        nextIdx: recoverResult.nextIdx + 1,
      };
    }
    // run async ... catch(name) { ... }
    const catchResult = parseRunCatchStep(filePath, lines, idx, innerNo, innerRaw, runBody, undefined, trivia);
    if (catchResult && catchResult.step.type === "exec" && catchResult.step.body.kind === "call") {
      const body: Expr = { ...catchResult.step.body, async: true };
      return {
        step: { ...catchResult.step, body },
        nextIdx: catchResult.nextIdx + 1,
      };
    }
    const call = parseCallRef(runBody);
    if (!call) {
      fail(filePath, "run async must target a valid reference: run async ref() or run async ref(args) — parentheses are required", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "run async", call.rest);
    const callee = { value: call.ref, loc: { line: innerNo, col: runCol } };
    return {
      step: execStep(
        { kind: "call", callee, args: call.args, async: true },
        { line: innerNo, col: runCol },
      ),
      nextIdx: idx + 1,
    };
  }

  if (inner.startsWith("run ")) {
    const runBody = inner.slice("run ".length).trim();
    const runCol = innerRaw.indexOf("run") + 1;
    if (runBody.startsWith("`")) {
      const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, runCol);
      return {
        step: execStep(
          {
            kind: "inline_script",
            body: result.body,
            ...(result.lang ? { lang: result.lang } : {}),
            args: result.args,
          },
          { line: innerNo, col: runCol },
        ),
        nextIdx: result.nextLineIdx,
      };
    }
    if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
      fail(filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', innerNo);
    }
    // Check for run ... recover (loop semantics)
    const recoverResult = parseRunRecoverStep(filePath, lines, idx, innerNo, innerRaw, runBody, undefined, trivia);
    if (recoverResult) {
      return { step: recoverResult.step, nextIdx: recoverResult.nextIdx + 1 };
    }
    // Check for run ... catch
    const catchResult = parseRunCatchStep(filePath, lines, idx, innerNo, innerRaw, runBody, undefined, trivia);
    if (catchResult) {
      return { step: catchResult.step, nextIdx: catchResult.nextIdx + 1 };
    }
    const call = parseCallRef(runBody);
    if (!call) {
      fail(filePath, "run must target a valid reference: run ref() or run ref(args) — parentheses are required", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "run", call.rest);
    const callee = { value: call.ref, loc: { line: innerNo, col: runCol } };
    return {
      step: execStep(
        { kind: "call", callee, args: call.args },
        { line: innerNo, col: runCol },
      ),
      nextIdx: idx + 1,
    };
  }

  if (forRule && (inner.startsWith("prompt ") || /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*prompt\s/.test(inner))) {
    fail(filePath, "prompt is not allowed in rules", innerNo, colFromRaw(innerRaw));
  }

  const promptAssignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s);
  if (promptAssignMatch) {
    fail(
      filePath,
      'use "const name = prompt ..." to capture the prompt result (e.g. const answer = prompt "..." )',
      innerNo,
      innerRaw.indexOf(promptAssignMatch[1]) + 1,
    );
  }
  if (inner.startsWith("prompt ")) {
    const promptCol = innerRaw.indexOf("prompt") + 1;
    const promptArg = innerRaw.slice(innerRaw.indexOf("prompt") + "prompt".length).trimStart();
    const result = parsePromptStep(filePath, lines, idx, promptArg, promptCol, undefined, trivia);
    return { step: result.step, nextIdx: result.nextLineIdx + 1 };
  }

  const genericAssignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
  if (
    genericAssignMatch &&
    !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
    !genericAssignMatch[2].trimStart().startsWith('"') &&
    !genericAssignMatch[2].trimStart().startsWith("$")
  ) {
    const captureName = genericAssignMatch[1];
    const rest = genericAssignMatch[2].trim();
    if (rest.startsWith("run ") || rest.startsWith("ensure ")) {
      fail(
        filePath,
        `assignment without "const" is no longer supported; use "const ${captureName} = ${rest}"`,
        innerNo,
        innerRaw.indexOf(captureName) + 1,
      );
    }
  }

  if (inner.startsWith("log ") || inner === "log") {
    const logArg = inner.slice("log".length).trimStart();
    const logCol = innerRaw.indexOf("log") + 1;
    const stepLoc = { line: innerNo, col: logCol };
    if (logArg.startsWith("run ") && logArg.slice("run ".length).trimStart().startsWith("`")) {
      const runBody = logArg.slice("run ".length).trim();
      const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, logCol);
      const message: Expr = {
        kind: "inline_script",
        body: result.body,
        ...(result.lang ? { lang: result.lang } : {}),
        args: result.args,
      };
      return { step: { type: "say", level: "log", message, loc: stepLoc }, nextIdx: result.nextLineIdx };
    }
    if (logArg.startsWith("`") || logArg.startsWith("```")) {
      fail(filePath, 'bare inline scripts in log are not allowed; use "log run `...`()" to execute a managed inline script', innerNo, logCol);
    }
    if (logArg.startsWith('"""')) {
      const { body, nextIdx } = consumeTripleQuotedArg(filePath, lines, idx, logArg);
      const raw = dedentTripleQuotedBody(body);
      const message: Expr = { kind: "literal", raw };
      trivia.setNode(message, { tripleQuoted: true, rawBody: body });
      return { step: { type: "say", level: "log", message, loc: stepLoc }, nextIdx };
    }
    if (logArg.startsWith('"') && !hasUnescapedClosingQuote(logArg, 1)) {
      fail(filePath, 'multiline strings use triple quotes: log """..."""', innerNo, logCol);
    }
    const messageRaw = parseLogMessageRhs(filePath, innerNo, logCol, logArg, "log");
    return {
      step: { type: "say", level: "log", message: { kind: "literal", raw: messageRaw }, loc: stepLoc },
      nextIdx: idx + 1,
    };
  }

  if (inner.startsWith("logerr ") || inner === "logerr") {
    const logerrArg = inner.slice("logerr".length).trimStart();
    const logerrCol = innerRaw.indexOf("logerr") + 1;
    const stepLoc = { line: innerNo, col: logerrCol };
    if (logerrArg.startsWith("run ") && logerrArg.slice("run ".length).trimStart().startsWith("`")) {
      const runBody = logerrArg.slice("run ".length).trim();
      const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, logerrCol);
      const message: Expr = {
        kind: "inline_script",
        body: result.body,
        ...(result.lang ? { lang: result.lang } : {}),
        args: result.args,
      };
      return { step: { type: "say", level: "logerr", message, loc: stepLoc }, nextIdx: result.nextLineIdx };
    }
    if (logerrArg.startsWith("`") || logerrArg.startsWith("```")) {
      fail(filePath, 'bare inline scripts in logerr are not allowed; use "logerr run `...`()" to execute a managed inline script', innerNo, logerrCol);
    }
    if (logerrArg.startsWith('"""')) {
      const { body, nextIdx } = consumeTripleQuotedArg(filePath, lines, idx, logerrArg);
      const raw = dedentTripleQuotedBody(body);
      const message: Expr = { kind: "literal", raw };
      trivia.setNode(message, { tripleQuoted: true, rawBody: body });
      return { step: { type: "say", level: "logerr", message, loc: stepLoc }, nextIdx };
    }
    if (logerrArg.startsWith('"') && !hasUnescapedClosingQuote(logerrArg, 1)) {
      fail(filePath, 'multiline strings use triple quotes: logerr """..."""', innerNo, logerrCol);
    }
    const messageRaw = parseLogMessageRhs(filePath, innerNo, logerrCol, logerrArg, "logerr");
    return {
      step: { type: "say", level: "logerr", message: { kind: "literal", raw: messageRaw }, loc: stepLoc },
      nextIdx: idx + 1,
    };
  }

  if (inner.trim() === "return") {
    return {
      step: {
        type: "return",
        value: { kind: "literal", raw: '""' },
        loc: { line: innerNo, col: innerRaw.indexOf("return") + 1 },
      },
      nextIdx: idx + 1,
    };
  }

  const returnMatch = inner.match(/^return\s+(.+)$/s);
  if (returnMatch) {
    const returnValue = returnMatch[1].trim();
    const retLoc = { line: innerNo, col: innerRaw.indexOf("return") + 1 };
    // return """..."""
    if (returnValue.startsWith('"""')) {
      const { body, nextIdx } = consumeTripleQuotedArg(filePath, lines, idx, returnValue);
      const value: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
      trivia.setNode(value, { tripleQuoted: true, rawBody: body });
      return {
        step: { type: "return", value, loc: retLoc },
        nextIdx,
      };
    }
    // return match var { ... }
    const returnMatchHead = returnValue.match(/^match\s+(.+?)\s*\{\s*$/);
    if (returnMatchHead) {
      const subject = returnMatchHead[1].trim();
      const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, subject, retLoc);
      return {
        step: { type: "return", value: { kind: "match", match: expr }, loc: retLoc },
        nextIdx: nextIndex,
      };
    }
    if (returnValue.startsWith("run ")) {
      const runBody = returnValue.slice("run ".length).trim();
      if (runBody.startsWith("`")) {
        const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
        const value: Expr = {
          kind: "inline_script",
          body: result.body,
          ...(result.lang ? { lang: result.lang } : {}),
          args: result.args,
        };
        return {
          step: { type: "return", value, loc: retLoc },
          nextIdx: result.nextLineIdx,
        };
      }
      const call = parseCallRef(runBody);
      if (call) {
        rejectTrailingContent(filePath, innerNo, "run", call.rest);
        const callee = { value: call.ref, loc: retLoc };
        return {
          step: { type: "return", value: { kind: "call", callee, args: call.args }, loc: retLoc },
          nextIdx: idx + 1,
        };
      }
    }
    if (returnValue.startsWith("ensure ")) {
      const call = parseCallRef(returnValue.slice("ensure ".length).trim());
      if (call) {
        rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
        const callee = { value: call.ref, loc: retLoc };
        return {
          step: { type: "return", value: { kind: "ensure_call", callee, args: call.args }, loc: retLoc },
          nextIdx: idx + 1,
        };
      }
    }
    if (returnValue.startsWith("`") || returnValue.startsWith("```")) {
      fail(filePath, 'bare inline scripts in return are not allowed; use "return run `...`()" to execute a managed inline script', innerNo, retLoc.col);
    }
    if (returnValue.startsWith("'")) {
      fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', innerNo, retLoc.col);
    }
    if (/^[0-9]+$/.test(returnValue) || returnValue === "$?") {
      fail(
        filePath,
        'bash exit codes are only valid in scripts; use return "..." for a workflow value',
        innerNo,
        retLoc.col,
      );
    }
    if (
      returnValue.startsWith('"') ||
      returnValue.startsWith("$") ||
      isBareDottedIdentifierReturn(returnValue) ||
      isBareIdentifierReturn(returnValue)
    ) {
      // Reject multiline "..."
      if (returnValue.startsWith('"') && !hasUnescapedClosingQuote(returnValue, 1)) {
        fail(filePath, 'multiline strings use triple quotes: return """..."""', innerNo, retLoc.col);
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
        trivia.setNode(value, { bareSource: returnValue.trim() });
      }
      return {
        step: { type: "return", value, loc: retLoc },
        nextIdx: idx + 1,
      };
    }
  }

  // Standalone match statement: match <subject> { ... }
  const standaloneMatchHead = inner.match(/^match\s+(.+?)\s*\{\s*$/);
  if (standaloneMatchHead) {
    const subject = standaloneMatchHead[1].trim();
    const matchLoc = { line: innerNo, col: innerRaw.indexOf("match") + 1 };
    const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, subject, matchLoc);
    return {
      step: execStep({ kind: "match", match: expr }, matchLoc),
      nextIdx: nextIndex,
    };
  }

  const sendMatch = matchSendOperator(inner);
  if (sendMatch) {
    if (forRule) {
      fail(filePath, "send operator is not allowed in rules", innerNo, 1);
    }
    const arrowIdx = inner.indexOf("<-");
    const rhsCol = arrowIdx >= 0 ? arrowIdx + 3 : 1;
    const { value, nextIdx: sendNextIdx } = parseSendRhs(filePath, sendMatch.rhsText, innerNo, rhsCol, lines, idx, trivia);
    return {
      step: {
        type: "send",
        channel: sendMatch.channel,
        value,
        loc: { line: innerNo, col: 1 },
      },
      nextIdx: sendNextIdx,
    };
  }

  return {
    step: execStep(
      { kind: "shell", command: inner, loc: { line: innerNo, col: colFromRaw(innerRaw) } },
      { line: innerNo, col: colFromRaw(innerRaw) },
    ),
    nextIdx: idx + 1,
  };
}
