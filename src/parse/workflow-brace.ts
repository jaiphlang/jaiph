import type { WorkflowStepDef } from "../types";
import {
  colFromRaw,
  fail,
  hasUnescapedClosingQuote,
  indexOfClosingDoubleQuote,
  matchSendOperator,
  parseCallRef,
  parseLogMessageRhs,
} from "./core";
import { parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseConstRhs } from "./const-rhs";
import { parseAnonymousInlineScript } from "./inline-script";
import { parseEnsureStep, parseRunCatchStep } from "./steps";
import { parsePromptStep } from "./prompt";
import { parseSendRhs } from "./send-rhs";
import { parseMatchExpr } from "./match";
import { dottedReturnToQuotedString, isBareDottedIdentifierReturn } from "./workflow-return-dotted";
import {
  expandBlockLineStatements,
  findClosingBraceIndex,
  shouldApplySemicolonStatementSplit,
  shouldSkipSemicolonSplitForLine,
} from "./statement-split";

/** Reject non-empty trailing content after a call expression (e.g. shell redirection). */
function rejectTrailingContent(
  filePath: string,
  lineNo: number,
  keyword: string,
  rest: string,
): void {
  const trimmed = rest.trim();
  if (!trimmed) return;
  fail(filePath, `unexpected content after ${keyword} call: '${trimmed}'; shell redirection (>, |, &) is not supported — use a script block`, lineNo);
}

export type BlockParseOpts = { forRule?: boolean };

/** Parse statements until a closing `}` at the current block level. */
export function parseBraceBlockBody(
  filePath: string,
  lines: string[],
  startIdx: number,
  openerLineNo: number,
  opts?: BlockParseOpts,
): { steps: WorkflowStepDef[]; nextIdx: number } {
  const steps: WorkflowStepDef[] = [];
  let idx = startIdx;
  while (idx < lines.length) {
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    const innerNo = idx + 1;
    if (inner === "") {
      idx += 1;
      continue;
    }
    if (inner.startsWith("#")) {
      steps.push({
        type: "comment",
        text: innerRaw.trim(),
        loc: { line: innerNo, col: 1 },
      });
      idx += 1;
      continue;
    }
    if (inner === "}") {
      return { steps, nextIdx: idx + 1 };
    }
    if (!shouldSkipSemicolonSplitForLine(innerRaw)) {
      const expanded = expandBlockLineStatements(innerRaw);
      if (shouldApplySemicolonStatementSplit(expanded) && expanded.length > 1) {
        for (const chunk of expanded) {
          const t = chunk.trim();
          if (!t) continue;
          const one = parseBlockStatement(filePath, [t], 0, opts);
          steps.push(one.step);
        }
        idx += 1;
        continue;
      }
    }
    const one = parseBlockStatement(filePath, lines, idx, opts);
    steps.push(one.step);
    idx = one.nextIdx;
  }
  fail(filePath, 'unterminated block, expected "}"', openerLineNo);
}

/**
 * One workflow statement inside `{ … }` (catch body, etc.).
 */
export function parseBlockStatement(
  filePath: string,
  lines: string[],
  idx: number,
  opts?: BlockParseOpts,
): { step: WorkflowStepDef; nextIdx: number } {
  const innerRaw = lines[idx];
  const inner = innerRaw.trim();
  const innerNo = idx + 1;
  const forRule = opts?.forRule === true;

  if (inner.startsWith("#")) {
    return {
      step: {
        type: "comment",
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

    const { steps: body, nextIdx } = parseBraceBlockBody(filePath, lines, idx + 1, innerNo);
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

  const constMatch = inner.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
  if (constMatch) {
    const name = constMatch[1];
    const rhs = constMatch[2].trim();
    const { value, nextLineIdx } = parseConstRhs(
      filePath, lines, idx, rhs, innerNo, innerRaw.indexOf(rhs) + 1, forRule, name,
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
      const tqLines = [...lines];
      tqLines[idx] = arg;
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
      if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
      const message = tripleQuoteBodyToRaw(body);
      return {
        step: { type: "fail", message, tripleQuoted: true, loc: { line: innerNo, col: failCol } },
        nextIdx,
      };
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
    const message = arg.slice(0, closeIdx + 1);
    return {
      step: { type: "fail", message, loc: { line: innerNo, col: failCol } },
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
      ensureBody,
    );
    return { step: r.step, nextIdx: r.nextIdx + 1 };
  }

  if (inner.startsWith("run async ")) {
    const runBody = inner.slice("run async ".length).trim();
    if (runBody.startsWith("`")) {
      fail(filePath, "run async is not supported with inline scripts", innerNo, innerRaw.indexOf("run") + 1);
    }
    const call = parseCallRef(runBody);
    if (!call) {
      fail(filePath, "run async must target a valid reference: run async ref() or run async ref(args) — parentheses are required", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "run async", call.rest);
    return {
      step: {
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
        async: true,
      },
      nextIdx: idx + 1,
    };
  }

  if (inner.startsWith("run ")) {
    const runBody = inner.slice("run ".length).trim();
    if (runBody.startsWith("`")) {
      const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
      return {
        step: {
          type: "run_inline_script",
          body: result.body,
          ...(result.lang ? { lang: result.lang } : {}),
          args: result.args,
          ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        nextIdx: result.nextLineIdx,
      };
    }
    if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
      fail(filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', innerNo);
    }
    // Check for run ... catch
    const catchResult = parseRunCatchStep(filePath, lines, idx, innerNo, innerRaw, runBody);
    if (catchResult) {
      return { step: catchResult.step, nextIdx: catchResult.nextIdx + 1 };
    }
    const call = parseCallRef(runBody);
    if (!call) {
      fail(filePath, "run must target a valid reference: run ref() or run ref(args) — parentheses are required", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "run", call.rest);
    return {
      step: {
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      },
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
    const result = parsePromptStep(filePath, lines, idx, promptArg, promptCol);
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
    if (logArg.startsWith('"""')) {
      const tqLines = [...lines];
      tqLines[idx] = logArg;
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
      if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
      return { step: { type: "log", message: body, tripleQuoted: true, loc: { line: innerNo, col: logCol } }, nextIdx };
    }
    if (logArg.startsWith('"') && !hasUnescapedClosingQuote(logArg, 1)) {
      fail(filePath, 'multiline strings use triple quotes: log """..."""', innerNo, logCol);
    }
    const message = parseLogMessageRhs(filePath, innerNo, logCol, logArg, "log");
    return { step: { type: "log", message, loc: { line: innerNo, col: logCol } }, nextIdx: idx + 1 };
  }

  if (inner.startsWith("logerr ") || inner === "logerr") {
    const logerrArg = inner.slice("logerr".length).trimStart();
    const logerrCol = innerRaw.indexOf("logerr") + 1;
    if (logerrArg.startsWith('"""')) {
      const tqLines = [...lines];
      tqLines[idx] = logerrArg;
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
      if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
      return { step: { type: "logerr", message: body, tripleQuoted: true, loc: { line: innerNo, col: logerrCol } }, nextIdx };
    }
    if (logerrArg.startsWith('"') && !hasUnescapedClosingQuote(logerrArg, 1)) {
      fail(filePath, 'multiline strings use triple quotes: logerr """..."""', innerNo, logerrCol);
    }
    const message = parseLogMessageRhs(filePath, innerNo, logerrCol, logerrArg, "logerr");
    return { step: { type: "logerr", message, loc: { line: innerNo, col: logerrCol } }, nextIdx: idx + 1 };
  }

  if (inner.trim() === "return") {
    return {
      step: {
        type: "return",
        value: '""',
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
      const tqLines = [...lines];
      tqLines[idx] = returnValue;
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
      if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
      return {
        step: { type: "return", value: tripleQuoteBodyToRaw(body), tripleQuoted: true, loc: retLoc },
        nextIdx,
      };
    }
    // return match var { ... }
    const returnMatchHead = returnValue.match(/^match\s+(.+?)\s*\{\s*$/);
    if (returnMatchHead) {
      const subject = returnMatchHead[1].trim();
      const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, subject, retLoc);
      return {
        step: {
          type: "return",
          value: `__match__`,
          loc: retLoc,
          managed: { kind: "match", match: expr },
        },
        nextIdx: nextIndex,
      };
    }
    if (returnValue.startsWith("run ")) {
      const call = parseCallRef(returnValue.slice("run ".length).trim());
      if (call) {
        rejectTrailingContent(filePath, innerNo, "run", call.rest);
        return {
          step: {
            type: "return",
            value: `run ${call.ref}(${call.args ?? ""})`,
            loc: retLoc,
            managed: {
              kind: "run", ref: { value: call.ref, loc: retLoc }, args: call.args,
              ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
            },
          },
          nextIdx: idx + 1,
        };
      }
    }
    if (returnValue.startsWith("ensure ")) {
      const call = parseCallRef(returnValue.slice("ensure ".length).trim());
      if (call) {
        rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
        return {
          step: {
            type: "return",
            value: `ensure ${call.ref}(${call.args ?? ""})`,
            loc: retLoc,
            managed: {
              kind: "ensure", ref: { value: call.ref, loc: retLoc }, args: call.args,
              ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
            },
          },
          nextIdx: idx + 1,
        };
      }
    }
    if (returnValue.startsWith("'")) {
      fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', innerNo, retLoc.col);
    }
    if (
      !(/^[0-9]+$/.test(returnValue) || returnValue === "$?") &&
      (returnValue.startsWith('"') ||
        returnValue.startsWith("$") ||
        isBareDottedIdentifierReturn(returnValue))
    ) {
      // Reject multiline "..."
      if (returnValue.startsWith('"') && !hasUnescapedClosingQuote(returnValue, 1)) {
        fail(filePath, 'multiline strings use triple quotes: return """..."""', innerNo, retLoc.col);
      }
      const value = isBareDottedIdentifierReturn(returnValue)
        ? dottedReturnToQuotedString(returnValue)
        : returnValue;
      return {
        step: {
          type: "return",
          value,
          loc: retLoc,
        },
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
      step: { type: "match", expr },
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
    const { rhs, nextIdx: sendNextIdx } = parseSendRhs(filePath, sendMatch.rhsText, innerNo, rhsCol, lines, idx);
    return {
      step: {
        type: "send",
        channel: sendMatch.channel,
        rhs,
        loc: { line: innerNo, col: 1 },
      },
      nextIdx: sendNextIdx,
    };
  }

  return {
    step: {
      type: "shell",
      command: inner,
      loc: { line: innerNo, col: colFromRaw(innerRaw) },
    },
    nextIdx: idx + 1,
  };
}
