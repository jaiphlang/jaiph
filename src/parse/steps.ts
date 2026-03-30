import type { WorkflowStepDef } from "../types";
import { parseConstRhs } from "./const-rhs";
import { fail, indexOfClosingDoubleQuote, isRef, parseCallRef } from "./core";

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
import { parsePromptStep } from "./prompt";

/** Split recover block content into statements on `;` or `\n`, but not inside double-quoted strings. */
function splitRecoverStatements(blockContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  for (let i = 0; i < blockContent.length; i += 1) {
    const ch = blockContent[i];
    if (ch === '"' && (i === 0 || blockContent[i - 1] !== "\\")) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (!inDoubleQuote && (ch === ";" || ch === "\n")) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

/** Parse a single workflow statement string (e.g. "run foo", "ensure bar", "echo x") into a step. */
function parseRecoverStatement(
  filePath: string,
  lineNo: number,
  col: number,
  stmt: string,
): WorkflowStepDef {
  const t = stmt.trim();
  if (!t) {
    fail(filePath, "empty recover statement", lineNo, col);
  }
  if (t === "wait") {
    return { type: "wait", loc: { line: lineNo, col } };
  }
  if (/^fail\s+/.test(t)) {
    const arg = t.slice("fail".length).trimStart();
    if (!arg.startsWith('"')) {
      fail(filePath, 'fail must match: fail "<reason>"', lineNo, col);
    }
    const closeIdx = indexOfClosingDoubleQuote(arg, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated fail string", lineNo, col);
    }
    const message = arg.slice(0, closeIdx + 1);
    return { type: "fail", message, loc: { line: lineNo, col } };
  }
  const constRecover = t.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
  if (constRecover) {
    const name = constRecover[1];
    const rhs = constRecover[2].trim();
    const { value } = parseConstRhs(filePath, [], lineNo - 1, rhs, lineNo, col, false, name);
    return {
      type: "const",
      name,
      value,
      loc: { line: lineNo, col },
    };
  }
  const genericAssignMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
  if (
    genericAssignMatch &&
    !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
    !genericAssignMatch[2].trimStart().startsWith('"') &&
    !genericAssignMatch[2].trimStart().startsWith("'") &&
    !genericAssignMatch[2].trimStart().startsWith("$")
  ) {
    const captureName = genericAssignMatch[1];
    const rest = genericAssignMatch[2].trim();
    if (rest.startsWith("run ")) {
      const call = parseCallRef(rest.slice("run ".length).trim());
      if (call) {
        rejectTrailingContent(filePath, lineNo, "run", call.rest);
        return {
          type: "run",
          workflow: { value: call.ref, loc: { line: lineNo, col } },
          args: call.args,
          captureName,
        };
      }
    }
    if (rest.startsWith("ensure ")) {
      const call = parseCallRef(rest.slice("ensure ".length).trim());
      if (call) {
        rejectTrailingContent(filePath, lineNo, "ensure", call.rest);
        return {
          type: "ensure",
          ref: { value: call.ref, loc: { line: lineNo, col } },
          args: call.args,
          captureName,
        };
      }
    }
    return {
      type: "shell",
      command: rest,
      loc: { line: lineNo, col },
      captureName,
    };
  }
  if (t.startsWith("run ")) {
    const call = parseCallRef(t.slice("run ".length).trim());
    if (call) {
      rejectTrailingContent(filePath, lineNo, "run", call.rest);
      return {
        type: "run",
        workflow: { value: call.ref, loc: { line: lineNo, col } },
        args: call.args,
      };
    }
  }
  if (t.startsWith("ensure ")) {
    const call = parseCallRef(t.slice("ensure ".length).trim());
    if (call) {
      rejectTrailingContent(filePath, lineNo, "ensure", call.rest);
      return {
        type: "ensure",
        ref: { value: call.ref, loc: { line: lineNo, col } },
        args: call.args,
      };
    }
  }
  const promptAssignMatch = t.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
  );
  if (promptAssignMatch) {
    return parsePromptStep(
      filePath, [], lineNo - 1, promptAssignMatch[2].trimStart(),
      col + t.indexOf("prompt"), promptAssignMatch[1],
    ).step;
  }
  if (t.startsWith("prompt ")) {
    return parsePromptStep(
      filePath, [], lineNo - 1, t.slice("prompt ".length).trimStart(),
      col + t.indexOf("prompt"),
    ).step;
  }
  if (t.startsWith("log ") || t === "log") {
    const logArg = t.slice("log".length).trimStart();
    const logCol = col + Math.max(0, t.indexOf("log"));
    if (!logArg.startsWith('"')) {
      fail(filePath, 'log must match: log "<message>"', lineNo, logCol);
    }
    const closeIdx = indexOfClosingDoubleQuote(logArg, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated log string", lineNo, logCol);
    }
    const message = logArg.slice(1, closeIdx);
    return { type: "log", message, loc: { line: lineNo, col: logCol } };
  }
  if (t.startsWith("logerr ") || t === "logerr") {
    const logerrArg = t.slice("logerr".length).trimStart();
    const logerrCol = col + Math.max(0, t.indexOf("logerr"));
    if (!logerrArg.startsWith('"')) {
      fail(filePath, 'logerr must match: logerr "<message>"', lineNo, logerrCol);
    }
    const closeIdx = indexOfClosingDoubleQuote(logerrArg, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated logerr string", lineNo, logerrCol);
    }
    const message = logerrArg.slice(1, closeIdx);
    return { type: "logerr", message, loc: { line: lineNo, col: logerrCol } };
  }
  return { type: "shell", command: t, loc: { line: lineNo, col } };
}

/**
 * Parse an `ensure <ref> [args] [recover ...]` step, with optional captureName.
 * Returns the step and the updated 0-based line index.
 */
export function parseEnsureStep(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  ensureBody: string,
  captureName?: string,
): { step: WorkflowStepDef; nextIdx: number } {
  const recoverIdx = ensureBody.indexOf(" recover ");
  const ensureCol = innerRaw.indexOf("ensure") + 1;

  // `recover` at end of line with no block → error
  if (/\srecover$/.test(ensureBody)) {
    const recoverCol = innerRaw.indexOf("recover") + 1;
    fail(
      filePath,
      'recover requires a { ... } block. Valid syntax: ensure <rule> [args] recover { ... }',
      innerNo,
      recoverCol,
    );
  }

  if (recoverIdx === -1) {
    const call = parseCallRef(ensureBody);
    if (!call) {
      fail(filePath, "calls require parentheses: ensure ref() or ensure ref(args)", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
    return {
      step: {
        type: "ensure",
        ref: { value: call.ref, loc: { line: innerNo, col: ensureCol } },
        args: call.args,
        ...(captureName ? { captureName } : {}),
      },
      nextIdx: idx,
    };
  }
  const left = ensureBody.slice(0, recoverIdx).trim();
  const right = ensureBody.slice(recoverIdx + " recover ".length).trim();
  const call = parseCallRef(left);
  if (!call) {
    fail(filePath, "calls require parentheses: ensure ref() or ensure ref(args)", innerNo);
  }
  rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
  const ref = call.ref;
  const args = call.args;
  const recoverCol = innerRaw.indexOf("recover") + 1;

  // Arguments between `recover` and `{` → error
  if (right && !right.startsWith("{") && right.includes("{")) {
    fail(
      filePath,
      'invalid ensure syntax: rule arguments must appear before \'recover\'. Valid syntax: ensure <rule> [args] recover { ... }',
      innerNo,
      recoverCol,
    );
  }

  const refLoc = { value: ref, loc: { line: innerNo, col: ensureCol } };
  const base = { type: "ensure" as const, ref: refLoc, args, ...(captureName ? { captureName } : {}) };

  if (right === "{") {
    let blockLines: string[] = [];
    let closeLineIdx = -1;
    for (let look = idx + 1; look < lines.length; look += 1) {
      if (lines[look].trim() === "}") { closeLineIdx = look; break; }
      blockLines.push(lines[look].trim());
    }
    if (closeLineIdx === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const statements = splitRecoverStatements(blockLines.join("\n"));
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseRecoverStatement(filePath, innerNo, 1, s));
    return { step: { ...base, recover: { block: blockSteps } }, nextIdx: closeLineIdx };
  }

  if (right.startsWith("{")) {
    const closeBrace = right.indexOf("}");
    if (closeBrace === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const blockContent = right.slice(1, closeBrace).trim();
    const statements = splitRecoverStatements(blockContent);
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseRecoverStatement(filePath, innerNo, recoverCol, s));
    return { step: { ...base, recover: { block: blockSteps } }, nextIdx: idx };
  }

  const singleStep = parseRecoverStatement(filePath, innerNo, recoverCol, right);
  return { step: { ...base, recover: { single: singleStep } }, nextIdx: idx };
}
