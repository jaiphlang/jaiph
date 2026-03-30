import type { WorkflowDef } from "../types";
import {
  colFromRaw,
  fail,
  indexOfClosingDoubleQuote,
  isRef,
  matchSendOperator,
  parseCallRef,
} from "./core";
import { parseConstRhs } from "./const-rhs";
import { parseConfigBlock } from "./metadata";
import { parsePromptStep } from "./prompt";
import { parseSendRhs } from "./send-rhs";
import { parseEnsureStep } from "./steps";
import { tryParseBraceIfChain } from "./workflow-brace";

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
 * Jaiph value-return: return "..." | return '...' | return $var
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

  const match = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  if (!match) {
    const parensMatch = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (parensMatch) {
      fail(
        filePath,
        `definitions must not use parentheses: workflow ${parensMatch[2]} { … }`,
        lineNo,
      );
    }
    const loose = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `workflow declarations require braces: workflow ${loose[2]} { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid workflow declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const workflow: WorkflowDef = {
    name: match[2],
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
      const nextLine = value.kind === "prompt_capture" ? nextLineIdx + 1 : idx + 1;
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
      if (!arg.startsWith('"')) {
        fail(filePath, 'fail must match: fail "<reason>"', innerNo, innerRaw.indexOf("fail") + 1);
      }
      const closeIdx = indexOfClosingDoubleQuote(arg, 1);
      if (closeIdx === -1) {
        fail(filePath, "unterminated fail string", innerNo, innerRaw.indexOf("fail") + 1);
      }
      const message = arg.slice(0, closeIdx + 1);
      workflow.steps.push({
        type: "fail",
        message,
        loc: { line: innerNo, col: innerRaw.indexOf("fail") + 1 },
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
      const promptCol = innerRaw.indexOf("prompt") + 1;
      const result = parsePromptStep(
        filePath, lines, idx, promptAssignMatch[2].trimStart(),
        promptCol, promptAssignMatch[1],
      );
      idx = result.nextLineIdx;
      workflow.steps.push(result.step);
      continue;
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
        const call = parseCallRef(runBody);
        if (!call) {
          fail(filePath, "calls require parentheses: run ref() or run ref(args)", innerNo);
        }
        rejectTrailingContent(filePath, innerNo, "run", call.rest);
        workflow.steps.push({
          type: "run",
          workflow: {
            value: call.ref,
            loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
          },
          args: call.args,
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
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "calls require parentheses: run async ref() or run async ref(args)", innerNo);
      }
      rejectTrailingContent(filePath, innerNo, "run async", call.rest);
      workflow.steps.push({
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
        async: true,
      });
      continue;
    }

    if (inner.startsWith("run ")) {
      const runBody = inner.slice("run ".length).trim();
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "calls require parentheses: run ref() or run ref(args)", innerNo);
      }
      rejectTrailingContent(filePath, innerNo, "run", call.rest);
      workflow.steps.push({
        type: "run",
        workflow: {
          value: call.ref,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: call.args,
      });
      continue;
    }

    if (inner.startsWith("log ") || inner === "log") {
      const logArg = inner.slice("log".length).trimStart();
      const logCol = innerRaw.indexOf("log") + 1;
      if (!logArg.startsWith('"')) {
        fail(filePath, 'log must match: log "<message>"', innerNo, logCol);
      }
      const closeIdx = indexOfClosingDoubleQuote(logArg, 1);
      if (closeIdx === -1) {
        fail(filePath, "unterminated log string", innerNo, logCol);
      }
      const message = logArg.slice(1, closeIdx);
      workflow.steps.push({
        type: "log",
        message,
        loc: { line: innerNo, col: logCol },
      });
      continue;
    }

    if (inner.startsWith("logerr ") || inner === "logerr") {
      const logerrArg = inner.slice("logerr".length).trimStart();
      const logerrCol = innerRaw.indexOf("logerr") + 1;
      if (!logerrArg.startsWith('"')) {
        fail(filePath, 'logerr must match: logerr "<message>"', innerNo, logerrCol);
      }
      const closeIdx = indexOfClosingDoubleQuote(logerrArg, 1);
      if (closeIdx === -1) {
        fail(filePath, "unterminated logerr string", innerNo, logerrCol);
      }
      const message = logerrArg.slice(1, closeIdx);
      workflow.steps.push({
        type: "logerr",
        message,
        loc: { line: innerNo, col: logerrCol },
      });
      continue;
    }

    const returnMatch = inner.match(/^return\s+(.+)$/s);
    if (returnMatch) {
      const returnValue = returnMatch[1].trim();
      if (isJaiphValueReturn(returnValue)) {
        workflow.steps.push({
          type: "return",
          value: returnValue,
          loc: { line: innerNo, col: innerRaw.indexOf("return") + 1 },
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

    const routeMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+->\s+(.+)$/,
    );
    if (routeMatch) {
      const channel = routeMatch[1];
      const targetsStr = routeMatch[2].trim();
      const targetNames = targetsStr.split(/\s*,\s*/);
      const workflows = targetNames.map((name) => {
        const trimmedName = name.trim();
        if (!isRef(trimmedName)) {
          fail(filePath, `invalid workflow reference in route: "${trimmedName}"`, innerNo);
        }
        return { value: trimmedName, loc: { line: innerNo, col: innerRaw.indexOf(trimmedName) + 1 } };
      });
      if (!workflow.routes) {
        workflow.routes = [];
      }
      workflow.routes.push({
        channel,
        workflows,
        loc: { line: innerNo, col: 1 },
      });
      continue;
    }

    const sendMatch = matchSendOperator(inner);
    if (sendMatch) {
      const arrowIdx = inner.indexOf("<-");
      const rhsCol = arrowIdx >= 0 ? arrowIdx + 3 : 1;
      const rhs = parseSendRhs(filePath, sendMatch.rhsText, innerNo, rhsCol);
      workflow.steps.push({
        type: "send",
        channel: sendMatch.channel,
        rhs,
        loc: { line: innerNo, col: 1 },
      });
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
