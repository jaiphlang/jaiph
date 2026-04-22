import type { WorkflowDef } from "../types";
import {
  colFromRaw,
  fail,
  hasUnescapedClosingQuote,
  indexOfClosingDoubleQuote,
  matchSendOperator,
  parseCallRef,
  parseLogMessageRhs,
  parseParamList,
} from "./core";
import { parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseConstRhs } from "./const-rhs";
import { parseConfigBlock } from "./metadata";
import { parsePromptStep } from "./prompt";
import { parseSendRhs } from "./send-rhs";
import { parseAnonymousInlineScript } from "./inline-script";
import { parseEnsureStep, parseRunCatchStep, parseRunRecoverStep } from "./steps";
import { parseBraceBlockBody, parseBlockStatement } from "./workflow-brace";
import { dottedReturnToQuotedString, isBareDottedIdentifierReturn } from "./workflow-return-dotted";
import { parseMatchExpr } from "./match";
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

/**
 * Detect Jaiph value-return syntax vs bash exit-code return.
 * Jaiph value-return: return | return "..." | return '...' | return $var
 * (`return` alone is empty string; see bare-return handling before this matcher.)
 * Bash return: return 0 | return 1 | return $?
 */
function isJaiphValueReturn(expr: string): boolean {
  const arg = expr.trim();
  if (/^[0-9]+$/.test(arg)) return false;
  if (arg === "$?") return false;
  return arg.startsWith('"') || arg.startsWith("'") || arg.startsWith("$");
}

export function parseWorkflowBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { workflow: WorkflowDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const rawDecl = lines[startIndex];
  const lineDecl = rawDecl.trim();

  const parensNoBrace = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/);
  if (parensNoBrace) {
    fail(
      filePath,
      `workflow declarations require braces: workflow ${parensNoBrace[2]}() { … } or workflow ${parensNoBrace[2]}(params) { … }`,
      lineNo,
    );
  }

  // Match: [export] workflow name() { OR [export] workflow name(params) {
  const match = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/);
  if (!match) {
    const loose = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `workflow declarations require parentheses: workflow ${loose[2]}() { … } or workflow ${loose[2]}(params) { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid workflow declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const params = parseParamList(filePath, match[3], lineNo);
  const workflow: WorkflowDef = {
    name: match[2],
    params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  const braceIdx = match[0].length - 1;
  if (lineDecl[braceIdx] !== "{") {
    fail(filePath, "expected '{' after workflow header", lineNo);
  }
  const closeIdx = findClosingBraceIndex(lineDecl, braceIdx);
  const isInlineBody = closeIdx !== -1 && lineDecl.slice(closeIdx + 1).trim() === "";

  if (isInlineBody) {
    const bodyInner = lineDecl.slice(braceIdx + 1, closeIdx);
    const bodyLines = bodyInner.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const chunks: string[] = [];
    for (const bl of bodyLines) {
      if (shouldSkipSemicolonSplitForLine(bl)) {
        chunks.push(bl);
        continue;
      }
      const ex = expandBlockLineStatements(bl);
      if (shouldApplySemicolonStatementSplit(ex)) {
        chunks.push(...ex);
      } else {
        chunks.push(bl);
      }
    }
    let hadNonCommentStepInline = false;
    for (const chunk of chunks) {
      const t = chunk.trim();
      if (!t) continue;
      if (t.startsWith("#")) {
        workflow.steps.push({
          type: "comment",
          text: t,
          loc: { line: lineNo, col: 1 },
        });
        continue;
      }
      if (/^config\s*\{/.test(t)) {
        if (workflow.metadata !== undefined) {
          fail(filePath, "duplicate config block inside workflow (only one allowed per workflow)", lineNo);
        }
        if (hadNonCommentStepInline) {
          fail(filePath, "config block inside workflow must appear before any steps", lineNo);
        }
        const { metadata, nextIndex } = parseConfigBlock(filePath, [t], 0);
        if (nextIndex !== 1) {
          fail(filePath, "internal parse error: inline config expected on one line", lineNo);
        }
        if (metadata.runtime) {
          fail(filePath, "runtime.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", lineNo);
        }
        if (metadata.module) {
          fail(filePath, "module.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", lineNo);
        }
        workflow.metadata = metadata;
        continue;
      }
      hadNonCommentStepInline = true;
      const st = parseBlockStatement(filePath, [t], 0, { forRule: false });
      workflow.steps.push(st.step);
    }
    return { workflow, nextIndex: startIndex + 1, exported: isExported };
  }

  if (closeIdx === -1) {
    const afterBrace = lineDecl.slice(braceIdx + 1).trim();
    if (afterBrace !== "") {
      fail(
        filePath,
        "expected newline after '{' or a complete inline workflow body ending with '}' on the same line",
        lineNo,
      );
    }
  }

  let idx = startIndex + 1;
  /** Track whether a non-comment step has been seen (config must come first). */
  let hadNonCommentStep = false;

  for (; idx < lines.length; idx += 1) {
    const innerNo = idx + 1;
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    if (!inner) {
      // Preserve a single blank line between steps for the formatter.
      const lastStep = workflow.steps[workflow.steps.length - 1];
      if (lastStep && lastStep.type !== "blank_line") {
        workflow.steps.push({ type: "blank_line" });
      }
      continue;
    }
    if (inner === "}") {
      break;
    }
    if (inner.startsWith("#")) {
      workflow.steps.push({
        type: "comment",
        text: innerRaw.trim(),
        loc: { line: innerNo, col: 1 },
      });
      continue;
    }
    if (/^config\s*\{/.test(inner)) {
      if (workflow.metadata !== undefined) {
        fail(filePath, "duplicate config block inside workflow (only one allowed per workflow)", innerNo);
      }
      if (hadNonCommentStep) {
        fail(filePath, "config block inside workflow must appear before any steps", innerNo);
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, idx);
      if (metadata.runtime) {
        fail(filePath, "runtime.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", innerNo);
      }
      if (metadata.module) {
        fail(filePath, "module.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", innerNo);
      }
      workflow.metadata = metadata;
      idx = nextIndex - 1;
      continue;
    }

    if (!shouldSkipSemicolonSplitForLine(innerRaw)) {
      const expanded = expandBlockLineStatements(innerRaw);
      if (shouldApplySemicolonStatementSplit(expanded) && expanded.length > 1) {
        for (const chunk of expanded) {
          const t = chunk.trim();
          if (!t) continue;
          if (t.startsWith("#")) {
            workflow.steps.push({
              type: "comment",
              text: t,
              loc: { line: innerNo, col: 1 },
            });
            continue;
          }
          if (/^config\s*\{/.test(t)) {
            fail(
              filePath,
              "config must be the first workflow step; it cannot appear after semicolon-separated steps on the same line",
              innerNo,
            );
          }
          hadNonCommentStep = true;
          const st = parseBlockStatement(filePath, [t], 0, { forRule: false });
          workflow.steps.push(st.step);
        }
        continue;
      }
    }

    hadNonCommentStep = true;

    const constDecl = inner.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
    if (constDecl) {
      const name = constDecl[1];
      const rhs = constDecl[2].trim();
      const { value, nextLineIdx } = parseConstRhs(
        filePath, lines, idx, rhs, innerNo, innerRaw.indexOf(rhs) + 1, false, name,
      );
      const nextLine = nextLineIdx > idx ? nextLineIdx + 1 : idx + 1;
      workflow.steps.push({
        type: "const",
        name,
        value,
        loc: { line: innerNo, col: innerRaw.indexOf("const") + 1 },
      });
      idx = nextLine - 1;
      continue;
    }

    const failLine = inner.match(/^fail\s+/);
    if (failLine) {
      const arg = inner.slice("fail".length).trimStart();
      const failCol = innerRaw.indexOf("fail") + 1;
      if (arg.startsWith('"""')) {
        const tqLines = [...lines];
        tqLines[idx] = arg;
        const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
        if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
        workflow.steps.push({
          type: "fail",
          message: tripleQuoteBodyToRaw(body),
          tripleQuoted: true,
          loc: { line: innerNo, col: failCol },
        });
        idx = nextIdx - 1;
        continue;
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
      workflow.steps.push({
        type: "fail",
        message,
        loc: { line: innerNo, col: failCol },
      });
      continue;
    }

    if (inner === "wait") {
      fail(filePath, '"wait" has been removed from the language', innerNo, innerRaw.indexOf("wait") + 1);
    }

    const promptAssignMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
    );
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
      idx = result.nextLineIdx;
      workflow.steps.push(result.step);
      continue;
    }

    const genericAssignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
    if (
      genericAssignMatch &&
      !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
      !genericAssignMatch[2].trimStart().startsWith('"') &&
      !genericAssignMatch[2].trimStart().startsWith("'") &&
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

    if (inner.startsWith("ensure ")) {
      const result = parseEnsureStep(
        filePath, lines, idx, innerNo, innerRaw,
        inner.slice("ensure ".length).trim(),
      );
      idx = result.nextIdx;
      workflow.steps.push(result.step);
      continue;
    }

    if (inner.startsWith("run async ")) {
      const runBody = inner.slice("run async ".length).trim();
      if (runBody.startsWith("`")) {
        fail(filePath, "run async is not supported with inline scripts", innerNo, innerRaw.indexOf("run") + 1);
      }
      // Check for run async ... recover (loop semantics)
      const recoverResult = parseRunRecoverStep(filePath, lines, idx, innerNo, innerRaw, runBody);
      if (recoverResult) {
        if (recoverResult.step.type === "run") recoverResult.step.async = true;
        workflow.steps.push(recoverResult.step);
        idx = recoverResult.nextIdx;
        continue;
      }
      // Check for run async ... catch
      const catchResult = parseRunCatchStep(filePath, lines, idx, innerNo, innerRaw, runBody);
      if (catchResult) {
        if (catchResult.step.type === "run") catchResult.step.async = true;
        workflow.steps.push(catchResult.step);
        idx = catchResult.nextIdx;
        continue;
      }
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "run async must target a valid reference: run async ref() or run async ref(args) — parentheses are required", innerNo);
      }
      rejectTrailingContent(filePath, innerNo, "run async", call.rest);
      workflow.steps.push({
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
        async: true,
      });
      continue;
    }

    if (inner.startsWith("run ")) {
      const runBody = inner.slice("run ".length).trim();
      if (runBody.startsWith("`")) {
        const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
        workflow.steps.push({
          type: "run_inline_script",
          body: result.body,
          ...(result.lang ? { lang: result.lang } : {}),
          args: result.args,
          ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        });
        idx = result.nextLineIdx - 1;
        continue;
      }
      if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
        fail(filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', innerNo);
      }
      // Check for run ... recover (loop semantics)
      const recoverResult = parseRunRecoverStep(filePath, lines, idx, innerNo, innerRaw, runBody);
      if (recoverResult) {
        workflow.steps.push(recoverResult.step);
        idx = recoverResult.nextIdx;
        continue;
      }
      // Check for run ... catch
      const catchResult = parseRunCatchStep(filePath, lines, idx, innerNo, innerRaw, runBody);
      if (catchResult) {
        workflow.steps.push(catchResult.step);
        idx = catchResult.nextIdx;
        continue;
      }
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "run must target a valid reference: run ref() or run ref(args) — parentheses are required", innerNo);
      }
      rejectTrailingContent(filePath, innerNo, "run", call.rest);
      workflow.steps.push({
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      });
      continue;
    }

    if (inner.startsWith("log ") || inner === "log") {
      const logArg = inner.slice("log".length).trimStart();
      const logCol = innerRaw.indexOf("log") + 1;
      if (logArg.startsWith("run ") && logArg.slice("run ".length).trimStart().startsWith("`")) {
        const runBody = logArg.slice("run ".length).trim();
        const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, logCol);
        workflow.steps.push({
          type: "log",
          message: "",
          loc: { line: innerNo, col: logCol },
          managed: {
            kind: "run_inline_script",
            body: result.body,
            ...(result.lang ? { lang: result.lang } : {}),
            args: result.args,
            ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
          },
        });
        idx = result.nextLineIdx - 1;
        continue;
      }
      if (logArg.startsWith("`") || logArg.startsWith("```")) {
        fail(filePath, 'bare inline scripts in log are not allowed; use "log run `...`()" to execute a managed inline script', innerNo, logCol);
      }
      if (logArg.startsWith('"""')) {
        const tqLines = [...lines];
        tqLines[idx] = logArg;
        const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
        if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
        workflow.steps.push({ type: "log", message: body, tripleQuoted: true, loc: { line: innerNo, col: logCol } });
        idx = nextIdx - 1;
        continue;
      }
      if (logArg.startsWith('"') && !hasUnescapedClosingQuote(logArg, 1)) {
        fail(filePath, 'multiline strings use triple quotes: log """..."""', innerNo, logCol);
      }
      const message = parseLogMessageRhs(filePath, innerNo, logCol, logArg, "log");
      workflow.steps.push({ type: "log", message, loc: { line: innerNo, col: logCol } });
      continue;
    }

    if (inner.startsWith("logerr ") || inner === "logerr") {
      const logerrArg = inner.slice("logerr".length).trimStart();
      const logerrCol = innerRaw.indexOf("logerr") + 1;
      if (logerrArg.startsWith("run ") && logerrArg.slice("run ".length).trimStart().startsWith("`")) {
        const runBody = logerrArg.slice("run ".length).trim();
        const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, logerrCol);
        workflow.steps.push({
          type: "logerr",
          message: "",
          loc: { line: innerNo, col: logerrCol },
          managed: {
            kind: "run_inline_script",
            body: result.body,
            ...(result.lang ? { lang: result.lang } : {}),
            args: result.args,
            ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
          },
        });
        idx = result.nextLineIdx - 1;
        continue;
      }
      if (logerrArg.startsWith("`") || logerrArg.startsWith("```")) {
        fail(filePath, 'bare inline scripts in logerr are not allowed; use "logerr run `...`()" to execute a managed inline script', innerNo, logerrCol);
      }
      if (logerrArg.startsWith('"""')) {
        const tqLines = [...lines];
        tqLines[idx] = logerrArg;
        const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
        if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
        workflow.steps.push({ type: "logerr", message: body, tripleQuoted: true, loc: { line: innerNo, col: logerrCol } });
        idx = nextIdx - 1;
        continue;
      }
      if (logerrArg.startsWith('"') && !hasUnescapedClosingQuote(logerrArg, 1)) {
        fail(filePath, 'multiline strings use triple quotes: logerr """..."""', innerNo, logerrCol);
      }
      const message = parseLogMessageRhs(filePath, innerNo, logerrCol, logerrArg, "logerr");
      workflow.steps.push({ type: "logerr", message, loc: { line: innerNo, col: logerrCol } });
      continue;
    }

    /** Bare `return` exits the workflow with an empty string (not a Bash `return` shell step). */
    if (inner.trim() === "return") {
      workflow.steps.push({
        type: "return",
        value: '""',
        loc: { line: innerNo, col: innerRaw.indexOf("return") + 1 },
      });
      continue;
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
        workflow.steps.push({ type: "return", value: tripleQuoteBodyToRaw(body), tripleQuoted: true, loc: retLoc });
        idx = nextIdx - 1;
        continue;
      }
      // return match var { ... }
      const returnMatchHead = returnValue.match(/^match\s+(.+?)\s*\{\s*$/);
      if (returnMatchHead) {
        const subject = returnMatchHead[1].trim();
        const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, subject, retLoc);
        workflow.steps.push({
          type: "return",
          value: `__match__`,
          loc: retLoc,
          managed: { kind: "match", match: expr },
        });
        idx = nextIndex - 1;
        continue;
      }
      if (returnValue.startsWith("run ")) {
        const runBody = returnValue.slice("run ".length).trim();
        if (runBody.startsWith("`")) {
          const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
          workflow.steps.push({
            type: "return",
            value: `run inline_script`,
            loc: retLoc,
            managed: {
              kind: "run_inline_script",
              body: result.body,
              ...(result.lang ? { lang: result.lang } : {}),
              args: result.args,
              ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
            },
          });
          idx = result.nextLineIdx - 1;
          continue;
        }
        const call = parseCallRef(runBody);
        if (call) {
          rejectTrailingContent(filePath, innerNo, "run", call.rest);
          workflow.steps.push({
            type: "return",
            value: `run ${call.ref}(${call.args ?? ""})`,
            loc: retLoc,
            managed: {
              kind: "run", ref: { value: call.ref, loc: retLoc }, args: call.args,
              ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
            },
          });
          continue;
        }
      }
      if (returnValue.startsWith("ensure ")) {
        const call = parseCallRef(returnValue.slice("ensure ".length).trim());
        if (call) {
          rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
          workflow.steps.push({
            type: "return",
            value: `ensure ${call.ref}(${call.args ?? ""})`,
            loc: retLoc,
            managed: {
              kind: "ensure", ref: { value: call.ref, loc: retLoc }, args: call.args,
              ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
            },
          });
          continue;
        }
      }
      if (returnValue.startsWith("`") || returnValue.startsWith("```")) {
        fail(filePath, 'bare inline scripts in return are not allowed; use "return run `...`()" to execute a managed inline script', innerNo, retLoc.col);
      }
      if (returnValue.startsWith("'")) {
        fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', innerNo, retLoc.col);
      }
      if (isJaiphValueReturn(returnValue) || isBareDottedIdentifierReturn(returnValue)) {
        // Reject multiline "..."
        if (returnValue.startsWith('"') && !hasUnescapedClosingQuote(returnValue, 1)) {
          fail(filePath, 'multiline strings use triple quotes: return """..."""', innerNo, retLoc.col);
        }
        const value = isBareDottedIdentifierReturn(returnValue)
          ? dottedReturnToQuotedString(returnValue)
          : returnValue;
        workflow.steps.push({
          type: "return",
          value,
          loc: retLoc,
        });
        continue;
      }
    }

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
      workflow.steps.push({ type: "if", subject, operator, operand, body, loc: ifLoc });
      idx = nextIdx - 1;
      continue;
    }
    if (/^if[\s(]/.test(inner)) {
      fail(
        filePath,
        'invalid if syntax; expected: if <identifier> <op> <operand> { ... } where op is ==, !=, =~, or !~ and operand is "string" or /regex/',
        innerNo,
        innerRaw.indexOf("if") + 1,
      );
    }

    // Standalone match statement: match <subject> { ... }
    const standaloneMatchHead = inner.match(/^match\s+(.+?)\s*\{\s*$/);
    if (standaloneMatchHead) {
      const subject = standaloneMatchHead[1].trim();
      const matchLoc = { line: innerNo, col: innerRaw.indexOf("match") + 1 };
      const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, subject, matchLoc);
      workflow.steps.push({ type: "match", expr });
      idx = nextIndex - 1;
      continue;
    }

    const routeMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+->\s+(.+)$/,
    );
    if (routeMatch) {
      const channel = routeMatch[1];
      const targets = routeMatch[2].trim();
      fail(
        filePath,
        `route declarations belong at the top level: channel ${channel} -> ${targets}`,
        innerNo,
      );
    }

    const sendMatch = matchSendOperator(inner);
    if (sendMatch) {
      const arrowIdx = inner.indexOf("<-");
      const rhsCol = arrowIdx >= 0 ? arrowIdx + 3 : 1;
      const { rhs, nextIdx: sendNextIdx } = parseSendRhs(filePath, sendMatch.rhsText, innerNo, rhsCol, lines, idx);
      workflow.steps.push({
        type: "send",
        channel: sendMatch.channel,
        rhs,
        loc: { line: innerNo, col: 1 },
      });
      idx = sendNextIdx - 1;
      continue;
    }

    workflow.steps.push({
      type: "shell",
      command: inner,
      loc: { line: innerNo, col: colFromRaw(innerRaw) },
    });
  }

  if (idx >= lines.length) {
    fail(filePath, `unterminated workflow block: ${workflow.name}`, lineNo);
  }
  // Strip trailing blank_line (whitespace before closing brace).
  while (workflow.steps.length > 0 && workflow.steps[workflow.steps.length - 1].type === "blank_line") {
    workflow.steps.pop();
  }
  return { workflow, nextIndex: idx + 1, exported: isExported };
}
