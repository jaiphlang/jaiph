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
import { parseEnsureStep } from "./steps";
import { tryParseBraceIfChain } from "./workflow-brace";
import { dottedReturnToQuotedString, isBareDottedIdentifierReturn } from "./workflow-return-dotted";
import { parseMatchExpr } from "./match";

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
  const match = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{$/);
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

  let idx = startIndex + 1;
  /** Track whether a non-comment step has been seen (config must come first). */
  let hadNonCommentStep = false;

  for (; idx < lines.length; idx += 1) {
    const innerNo = idx + 1;
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    if (!inner) {
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
      workflow.metadata = metadata;
      idx = nextIndex - 1;
      continue;
    }

    hadNonCommentStep = true;

    const braceIf = tryParseBraceIfChain(filePath, lines, idx);
    if (braceIf) {
      workflow.steps.push(braceIf.step);
      idx = braceIf.nextIdx - 1;
      continue;
    }

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
      workflow.steps.push({
        type: "wait",
        loc: { line: innerNo, col: innerRaw.indexOf("wait") + 1 },
      });
      continue;
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
      if (matchSendOperator(rest)) {
        fail(filePath, "E_PARSE capture and send cannot be combined; use separate steps", innerNo);
      }
      if (rest.startsWith("ensure ")) {
        const result = parseEnsureStep(
          filePath, lines, idx, innerNo, innerRaw,
          rest.slice("ensure ".length).trim(), captureName,
        );
        idx = result.nextIdx;
        workflow.steps.push(result.step);
        continue;
      }
      if (rest.startsWith("run async ")) {
        fail(filePath, "capture is not supported with run async; use separate steps", innerNo, innerRaw.indexOf("run") + 1);
      }
      if (rest.startsWith("run ")) {
        const runBody = rest.slice("run ".length).trim();
        if (runBody.startsWith("`")) {
          const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
          workflow.steps.push({
            type: "run_inline_script",
            body: result.body,
            ...(result.lang ? { lang: result.lang } : {}),
            args: result.args,
            ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
            captureName,
            loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
          });
          idx = result.nextLineIdx - 1;
          continue;
        }
        if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
          fail(filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', innerNo);
        }
        const call = parseCallRef(runBody);
        if (!call) {
          fail(filePath, "run must target a valid reference: run ref or run ref(args)", innerNo);
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
          captureName,
        });
        continue;
      }
      workflow.steps.push({
        type: "shell",
        command: rest,
        loc: { line: innerNo, col: innerRaw.indexOf(rest) + 1 },
        captureName,
      });
      continue;
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
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "run async must target a valid reference: run async ref or run async ref(args)", innerNo);
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
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "run must target a valid reference: run ref or run ref(args)", innerNo);
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
      if (logArg.startsWith('"""')) {
        const tqLines = [...lines];
        tqLines[idx] = logArg;
        const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
        if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
        workflow.steps.push({ type: "log", message: body, loc: { line: innerNo, col: logCol } });
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
      if (logerrArg.startsWith('"""')) {
        const tqLines = [...lines];
        tqLines[idx] = logerrArg;
        const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
        if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
        workflow.steps.push({ type: "logerr", message: body, loc: { line: innerNo, col: logerrCol } });
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
        workflow.steps.push({ type: "return", value: tripleQuoteBodyToRaw(body), loc: retLoc });
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
        const call = parseCallRef(returnValue.slice("run ".length).trim());
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

    if (/^if\s/.test(inner)) {
      const looksLikeJaiphIf =
        /^if\s+!\s*ensure\b/.test(inner) ||
        /^if\s+ensure\b/.test(inner) ||
        /^if\s+!\s*run\b/.test(inner) ||
        /^if\s+run\b/.test(inner) ||
        /^if\s+not\s+ensure\b/.test(inner) ||
        /^if\s+not\s+run\b/.test(inner);
      if (looksLikeJaiphIf) {
        fail(
          filePath,
          'use brace-style if: if [not] ensure|run <ref> [args] { ... } (then/fi syntax is not supported)',
          innerNo,
          innerRaw.indexOf("if") + 1,
        );
      }
      workflow.steps.push({
        type: "shell",
        command: inner,
        loc: { line: innerNo, col: colFromRaw(innerRaw) },
      });
      continue;
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
  return { workflow, nextIndex: idx + 1, exported: isExported };
}
