import type { IfConditionDef, WorkflowStepDef } from "../types";
import {
  colFromRaw,
  fail,
  hasUnescapedClosingQuote,
  indexOfClosingDoubleQuote,
  isRef,
  matchSendOperator,
  parseCallRef,
  parseLogMessageRhs,
} from "./core";
import { parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseConstRhs } from "./const-rhs";
import { parseAnonymousInlineScript } from "./inline-script";
import { parseEnsureStep } from "./steps";
import { parsePromptStep } from "./prompt";
import { parseSendRhs } from "./send-rhs";
import { parseMatchExpr, extractPostfixMatchSubject } from "./match";
import { dottedReturnToQuotedString, isBareDottedIdentifierReturn } from "./workflow-return-dotted";

type BraceIfHead =
  | { kind: "ensure"; negated: boolean; ref: string; args?: string; bareIdentifierArgs?: string[]; rest: string }
  | { kind: "run"; negated: boolean; ref: string; args?: string; bareIdentifierArgs?: string[]; rest: string };

function parseIfBraceHead(inner: string): BraceIfHead | null {
  let s = inner.trim();
  if (!s.startsWith("if ")) return null;
  s = s.slice(3).trimStart();
  let negated = false;
  if (s.startsWith("not ")) {
    negated = true;
    s = s.slice(4).trimStart();
  }
  if (s.startsWith("ensure ")) {
    s = s.slice("ensure ".length).trimStart();
    const lb = s.lastIndexOf("{");
    if (lb === -1) return null;
    if (s.slice(lb + 1).trim() !== "") return null;
    const before = s.slice(0, lb).trim();
    const call = parseCallRef(before);
    if (!call) return null;
    return { kind: "ensure", negated, ref: call.ref, args: call.args, bareIdentifierArgs: call.bareIdentifierArgs, rest: call.rest };
  }
  if (s.startsWith("run ")) {
    s = s.slice("run ".length).trimStart();
    const lb = s.lastIndexOf("{");
    if (lb === -1) return null;
    if (s.slice(lb + 1).trim() !== "") return null;
    const before = s.slice(0, lb).trim();
    const call = parseCallRef(before);
    if (!call) return null;
    return { kind: "run", negated, ref: call.ref, args: call.args, bareIdentifierArgs: call.bareIdentifierArgs, rest: call.rest };
  }
  return null;
}

function parseElseIfBraceHead(inner: string): BraceIfHead | null {
  let s = inner.trim();
  if (!s.startsWith("else if ")) return null;
  s = s.slice("else if ".length).trimStart();
  let negated = false;
  if (s.startsWith("not ")) {
    negated = true;
    s = s.slice(4).trimStart();
  }
  if (s.startsWith("ensure ")) {
    s = s.slice("ensure ".length).trimStart();
    const lb = s.lastIndexOf("{");
    if (lb === -1) return null;
    if (s.slice(lb + 1).trim() !== "") return null;
    const before = s.slice(0, lb).trim();
    const call = parseCallRef(before);
    if (!call) return null;
    return { kind: "ensure", negated, ref: call.ref, args: call.args, bareIdentifierArgs: call.bareIdentifierArgs, rest: call.rest };
  }
  if (s.startsWith("run ")) {
    s = s.slice("run ".length).trimStart();
    const lb = s.lastIndexOf("{");
    if (lb === -1) return null;
    if (s.slice(lb + 1).trim() !== "") return null;
    const before = s.slice(0, lb).trim();
    const call = parseCallRef(before);
    if (!call) return null;
    return { kind: "run", negated, ref: call.ref, args: call.args, bareIdentifierArgs: call.bareIdentifierArgs, rest: call.rest };
  }
  return null;
}

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

function headToCondition(filePath: string, h: BraceIfHead, lineNo: number, innerRaw: string): IfConditionDef {
  rejectTrailingContent(filePath, lineNo, h.kind === "ensure" ? "ensure" : "run", h.rest);
  if (h.kind === "ensure") {
    return {
      kind: "ensure",
      ref: { value: h.ref, loc: { line: lineNo, col: innerRaw.indexOf("ensure") + 1 } },
      args: h.args,
      ...(h.bareIdentifierArgs ? { bareIdentifierArgs: h.bareIdentifierArgs } : {}),
    };
  }
  return {
    kind: "run",
    ref: { value: h.ref, loc: { line: lineNo, col: innerRaw.indexOf("run") + 1 } },
    args: h.args,
    ...(h.bareIdentifierArgs ? { bareIdentifierArgs: h.bareIdentifierArgs } : {}),
  };
}

export type BlockParseOpts = { forRule?: boolean };

/** `} else {` / `} else if` on one line: strip leading `}` so the outer if-chain sees `else`. */
function peelCloseBraceBeforeElse(lines: string[], lineIdx: number): string[] {
  if (lineIdx >= lines.length) return lines;
  const m = lines[lineIdx].match(/^(\s*)}\s+(else\b.*)$/);
  if (!m) return lines;
  const out = lines.slice();
  out[lineIdx] = `${m[1]}${m[2]}`;
  return out;
}

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
    const closeThenElse = inner.match(/^}\s+(else\b.*)$/);
    if (closeThenElse) {
      return { steps, nextIdx: idx };
    }
    if (inner === "}") {
      return { steps, nextIdx: idx + 1 };
    }
    const one = parseBlockStatement(filePath, lines, idx, opts);
    steps.push(one.step);
    idx = one.nextIdx;
  }
  fail(filePath, 'unterminated block, expected "}"', openerLineNo);
}

function parseElseBraceBlock(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  opts?: BlockParseOpts,
): { steps: WorkflowStepDef[]; nextIdx: number } {
  const innerRaw = lines[idx];
  const inner = innerRaw.trim();
  const m = inner.match(/^else\s*\{\s*(.*)$/);
  if (!m) {
    fail(filePath, 'expected "else {" to start else branch', innerNo);
  }
  const after = m[1].trim();
  if (after === "}") {
    return { steps: [], nextIdx: idx + 1 };
  }
  if (after.includes("}")) {
    fail(filePath, "else branch body must not be on the same line as opening brace (use multiple lines)", innerNo);
  }
  return parseBraceBlockBody(filePath, lines, idx + 1, innerNo, opts);
}

/**
 * One workflow statement inside `{ … }` (brace-if body, else branch, etc.).
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

  const braceIf = tryParseBraceIfChain(filePath, lines, idx, opts);
  if (braceIf) return { step: braceIf.step, nextIdx: braceIf.nextIdx };

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
        step: { type: "fail", message, loc: { line: innerNo, col: failCol } },
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
    if (forRule) {
      fail(filePath, "wait is not allowed in rules", innerNo, innerRaw.indexOf("wait") + 1);
    }
    return { step: { type: "wait", loc: { line: innerNo, col: innerRaw.indexOf("wait") + 1 } }, nextIdx: idx + 1 };
  }

  if (inner.startsWith("ensure ")) {
    const ensureBody = inner.slice("ensure ".length).trim();
    if (forRule && /\brecover\b/.test(ensureBody)) {
      fail(filePath, "ensure ... recover is not allowed in rules", innerNo, innerRaw.indexOf("ensure") + 1);
    }
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
      fail(filePath, "run async must target a workflow or script reference with parenthesized arguments", innerNo);
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
    const call = parseCallRef(runBody);
    if (!call) {
      fail(filePath, "run must target a workflow or script reference with parenthesized arguments", innerNo);
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
    if (matchSendOperator(rest)) {
      fail(filePath, "E_PARSE capture and send cannot be combined; use separate steps", innerNo);
    }
    if (rest.startsWith("ensure ")) {
      const result = parseEnsureStep(
        filePath, lines, idx, innerNo, innerRaw,
        rest.slice("ensure ".length).trim(), captureName,
      );
      return { step: result.step, nextIdx: result.nextIdx + 1 };
    }
    if (rest.startsWith("run async ")) {
      fail(filePath, "capture is not supported with run async; use separate steps", innerNo, innerRaw.indexOf("run") + 1);
    }
    if (rest.startsWith("run ")) {
      const runBody = rest.slice("run ".length).trim();
      if (runBody.startsWith("`")) {
        const result = parseAnonymousInlineScript(filePath, lines, idx, runBody, innerNo, innerRaw.indexOf("run") + 1);
        return {
          step: {
            type: "run_inline_script",
            body: result.body,
            ...(result.lang ? { lang: result.lang } : {}),
            args: result.args,
            ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
            captureName,
            loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
          },
          nextIdx: result.nextLineIdx,
        };
      }
      if (runBody.startsWith("script(") || runBody.startsWith("script (")) {
        fail(filePath, 'inline script syntax has changed: use run `body`(args) instead of run script(args) "body"', innerNo);
      }
      const call = parseCallRef(runBody);
      if (!call) {
        fail(filePath, "run must target a workflow or script reference with parenthesized arguments", innerNo);
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
          captureName,
        },
        nextIdx: idx + 1,
      };
    }
    return {
      step: {
        type: "shell",
        command: rest,
        loc: { line: innerNo, col: innerRaw.indexOf(rest) + 1 },
        captureName,
      },
      nextIdx: idx + 1,
    };
  }

  if (inner.startsWith("log ") || inner === "log") {
    const logArg = inner.slice("log".length).trimStart();
    const logCol = innerRaw.indexOf("log") + 1;
    if (logArg.startsWith('"""')) {
      const tqLines = [...lines];
      tqLines[idx] = logArg;
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, idx);
      if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
      return { step: { type: "log", message: body, loc: { line: innerNo, col: logCol } }, nextIdx };
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
      return { step: { type: "logerr", message: body, loc: { line: innerNo, col: logerrCol } }, nextIdx };
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
        step: { type: "return", value: tripleQuoteBodyToRaw(body), loc: retLoc },
        nextIdx,
      };
    }
    // return <subject> match { ... }
    const returnMatchSubject = extractPostfixMatchSubject(returnValue);
    if (returnMatchSubject) {
      const { expr, nextIndex } = parseMatchExpr(filePath, lines, idx, returnMatchSubject, retLoc);
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

/** Brace-style `if [not] ensure|run … { … }` with optional `else if` / `else`. */
export function tryParseBraceIfChain(
  filePath: string,
  lines: string[],
  idx: number,
  opts?: BlockParseOpts,
): { step: WorkflowStepDef; nextIdx: number } | null {
  const innerRaw = lines[idx];
  const inner = innerRaw.trim();
  const innerNo = idx + 1;
  const head = parseIfBraceHead(inner);
  if (!head) return null;

  const condition = headToCondition(filePath, head, innerNo, innerRaw);
  let linesEff = lines;
  const { steps: thenSteps, nextIdx: afterThen } = parseBraceBlockBody(filePath, linesEff, idx + 1, innerNo, opts);
  linesEff = peelCloseBraceBeforeElse(linesEff, afterThen);
  let cursor = afterThen;
  const elseIfBranches: NonNullable<Extract<WorkflowStepDef, { type: "if" }>["elseIfBranches"]> = [];

  while (cursor < linesEff.length) {
    const t = linesEff[cursor].trim();
    if (t === "") {
      cursor += 1;
      continue;
    }
    if (t.startsWith("else if ")) {
      const eif = parseElseIfBraceHead(linesEff[cursor]);
      if (!eif) {
        fail(filePath, "malformed else if (expected else if [not] ensure|run … {)", cursor + 1);
      }
      const eifNo = cursor + 1;
      const eifRaw = linesEff[cursor];
      const cond = headToCondition(filePath, eif, eifNo, eifRaw);
      const { steps: branchSteps, nextIdx: afterBranch } = parseBraceBlockBody(
        filePath, linesEff, cursor + 1, eifNo, opts,
      );
      elseIfBranches.push({ negated: eif.negated, condition: cond, thenSteps: branchSteps });
      linesEff = peelCloseBraceBeforeElse(linesEff, afterBranch);
      cursor = afterBranch;
      continue;
    }
    if (t.startsWith("else")) {
      break;
    }
    break;
  }

  let elseSteps: WorkflowStepDef[] | undefined;
  if (cursor < linesEff.length && linesEff[cursor].trim().startsWith("else")) {
    const el = linesEff[cursor].trim();
    if (el.startsWith("else if")) {
      fail(filePath, 'malformed if-chain: "else if" must follow immediately after closing "}"', cursor + 1);
    }
    if (!/^else\s*\{/.test(el)) {
      fail(filePath, 'expected "else {" after if-chain', cursor + 1);
    }
    const eb = parseElseBraceBlock(filePath, linesEff, cursor, cursor + 1, opts);
    elseSteps = eb.steps;
    cursor = eb.nextIdx;
  }

  const step: WorkflowStepDef = {
    type: "if",
    negated: head.negated,
    condition,
    thenSteps,
    ...(elseIfBranches.length > 0 ? { elseIfBranches } : {}),
    ...(elseSteps && elseSteps.length > 0 ? { elseSteps } : {}),
  };
  return { step, nextIdx: cursor };
}
