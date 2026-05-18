import type { Expr, WorkflowStepDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote } from "./core";
import { dedentTripleQuotedBody, parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";

/**
 * Prompt body source tag stored in trivia.
 * - "string"        → single-line `"..."`
 * - "identifier"    → bare identifier after `prompt`
 * - "triple_quoted" → triple-quote `"""..."""` block
 */
export type PromptBodyKind = "string" | "identifier" | "triple_quoted";

/**
 * Split raw prompt literal (opening " to closing ") and optional `returns "..."`.
 * Consumes line continuation (trailing \) after the closing quote.
 * Returns promptRaw (including quotes), optional returns schema string, and next line index.
 */
function splitPromptAndReturns(
  filePath: string,
  lineNo: number,
  rawPrompt: string,
  lines: string[],
  lineIndexAfterPrompt: number,
): { promptRaw: string; returns?: string; nextIndex: number } {
  const openIdx = rawPrompt.indexOf('"');
  if (openIdx === -1) {
    fail(filePath, "unterminated prompt string", lineNo, 1);
  }
  const closeIdx = indexOfClosingDoubleQuote(rawPrompt, openIdx + 1);
  if (closeIdx === -1) {
    fail(filePath, "unterminated prompt string", lineNo, 1);
  }
  const promptRaw = rawPrompt.slice(0, closeIdx + 1);
  let rest = rawPrompt.slice(closeIdx + 1);
  let nextIdx = lineIndexAfterPrompt;
  while (nextIdx + 1 < lines.length && /\\\s*$/.test(rest.trimEnd())) {
    rest = rest.replace(/\\\s*$/, "") + "\n" + lines[nextIdx + 1].replace(/\\\s*$/, "").trimStart();
    nextIdx += 1;
  }
  let trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { promptRaw, nextIndex: nextIdx + 1 };
  }
  const returnsMatch = trimmed.match(/^returns\s+"/);
  if (!returnsMatch) {
    if (/^returns\s+'/.test(trimmed)) {
      fail(
        filePath,
        'single-quoted strings are not supported; use double quotes ("...") instead',
        lineNo,
        1,
      );
    }
    fail(
      filePath,
      'after prompt string expected keyword "returns" with quoted schema (e.g. returns "{ type: string }") or end of line',
      lineNo,
      1,
    );
  }
  let contentStart = trimmed.indexOf('"', trimmed.indexOf("returns")) + 1;
  let contentEnd = -1;
  while (true) {
    for (let i = contentStart; i < trimmed.length; i += 1) {
      if (trimmed[i] === '"' && trimmed[i - 1] !== "\\") {
        contentEnd = i;
        break;
      }
    }
    if (contentEnd >= 0) break;
    if (nextIdx + 1 >= lines.length) break;
    rest += "\n" + lines[nextIdx + 1];
    nextIdx += 1;
    trimmed = rest.trim();
    contentStart = trimmed.indexOf('"', trimmed.indexOf("returns")) + 1;
  }
  if (contentEnd === -1) {
    fail(filePath, "unterminated returns schema string", lineNo, 1);
  }
  const returnsContent = trimmed.slice(contentStart, contentEnd).replace(/\\"/g, '"');
  return { promptRaw, returns: returnsContent, nextIndex: nextIdx + 1 };
}

/**
 * Parse optional `returns "..."` after any prompt body form.
 * `rest` is the remaining text on the line after the body, `lines[nextIdx]` is the next unprocessed line.
 */
export function parseReturnsClause(
  filePath: string,
  lineNo: number,
  rest: string,
  lines: string[],
  nextIdx: number,
): { returns?: string; nextIndex: number } {
  let buf = rest;
  let idx = nextIdx;
  // consume line continuations
  while (idx + 1 < lines.length && /\\\s*$/.test(buf.trimEnd())) {
    buf = buf.replace(/\\\s*$/, "") + "\n" + lines[idx + 1].replace(/\\\s*$/, "").trimStart();
    idx += 1;
  }
  const trimmed = buf.trim();
  if (trimmed.length === 0) {
    return { nextIndex: idx + 1 };
  }
  const returnsMatch = trimmed.match(/^returns\s+"/);
  if (!returnsMatch) {
    if (/^returns\s+'/.test(trimmed)) {
      fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo, 1);
    }
    fail(
      filePath,
      'after prompt body expected keyword "returns" with quoted schema (e.g. returns "{ type: string }") or end of line',
      lineNo,
      1,
    );
  }
  let contentStart = trimmed.indexOf('"', trimmed.indexOf("returns")) + 1;
  let contentEnd = -1;
  let curBuf = buf;
  let curIdx = idx;
  while (true) {
    const curTrimmed = curBuf.trim();
    contentStart = curTrimmed.indexOf('"', curTrimmed.indexOf("returns")) + 1;
    contentEnd = -1;
    for (let i = contentStart; i < curTrimmed.length; i += 1) {
      if (curTrimmed[i] === '"' && curTrimmed[i - 1] !== "\\") {
        contentEnd = i;
        break;
      }
    }
    if (contentEnd >= 0) {
      const returnsContent = curTrimmed.slice(contentStart, contentEnd).replace(/\\"/g, '"');
      return { returns: returnsContent, nextIndex: curIdx + 1 };
    }
    if (curIdx + 1 >= lines.length) break;
    curBuf += "\n" + lines[curIdx + 1];
    curIdx += 1;
  }
  fail(filePath, "unterminated returns schema string", lineNo, 1);
}

/**
 * Parse a prompt triple-quoted block, allowing optional `returns "..."` on the closing `"""` line.
 */
function parsePromptTripleQuoteBlock(
  filePath: string,
  lines: string[],
  tripleQuoteLineIdx: number,
): { body: string; nextIdx: number; returns?: string } {
  const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, lines, tripleQuoteLineIdx);
  if (afterClose.length === 0) {
    return { body, nextIdx };
  }
  const m = afterClose.match(/^returns\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (m) {
    const content = m[1].replace(/\\"/g, '"');
    return { body, returns: content, nextIdx };
  }
  fail(
    filePath,
    'closing """ must be alone, or followed by returns "{ ... }" (same line)',
    nextIdx,
  );
}

/**
 * Parse a prompt step (captured or uncaptured). Returns an `exec` step whose
 * `body` is an `Expr` with `kind: "prompt"`.
 *
 * Supports three body forms:
 *   1. Single-line string literal: prompt "text"
 *   2. Bare identifier: prompt myVar
 *   3. Triple-quoted block: prompt """ ... """
 *
 * For catch statements where multiline scanning is unnecessary, pass `[]` for lines.
 */
export function parsePromptStep(
  filePath: string,
  lines: string[],
  lineIdx: number,
  promptArg: string,
  promptCol: number,
  captureName?: string,
  trivia: Trivia = createTrivia(),
): { step: WorkflowStepDef; nextLineIdx: number } {
  const lineNo = lineIdx + 1;

  // --- Reject triple-backtick fences for prompts ---
  if (promptArg.startsWith("```")) {
    fail(
      filePath,
      'prompt blocks use triple quotes: prompt """..."""; triple backticks are for scripts',
      lineNo,
      promptCol,
    );
  }

  const stepLoc = { line: lineNo, col: promptCol };

  const buildStep = (
    body: Expr,
    bodyTrivia: { bodyKind?: PromptBodyKind; bodyIdentifier?: string; rawBody?: string },
    nextLineIdx: number,
  ): { step: WorkflowStepDef; nextLineIdx: number } => {
    trivia.setNode(body, {
      ...(bodyTrivia.bodyKind ? { bodyKind: bodyTrivia.bodyKind } : {}),
      ...(bodyTrivia.bodyIdentifier ? { bodyIdentifier: bodyTrivia.bodyIdentifier } : {}),
      ...(bodyTrivia.rawBody !== undefined ? { rawBody: bodyTrivia.rawBody } : {}),
    });
    const step: WorkflowStepDef = {
      type: "exec",
      body,
      ...(captureName ? { captureName } : {}),
      loc: stepLoc,
    };
    return { step, nextLineIdx };
  };

  // --- Case 1: Triple-quoted block ---
  if (promptArg.startsWith('"""')) {
    let tqLines: string[];
    let tripleQuoteLineIdx: number;
    if (lines.length === 0) {
      tqLines = promptArg.split(/\r?\n/);
      tripleQuoteLineIdx = 0;
    } else {
      tqLines = [...lines];
      tqLines[lineIdx] = promptArg;
      tripleQuoteLineIdx = lineIdx;
    }
    const { body, nextIdx: realNextIdx, returns: returnsOnClosingLine } = parsePromptTripleQuoteBlock(
      filePath,
      tqLines,
      tripleQuoteLineIdx,
    );
    const raw = tripleQuoteBodyToRaw(dedentTripleQuotedBody(body));
    const linesForReturns = lines.length === 0 ? tqLines : lines;
    let returnsSchema: string | undefined = returnsOnClosingLine;
    let consumeEndIdx = realNextIdx;
    if (returnsSchema === undefined) {
      const lineAfterClose = (linesForReturns[realNextIdx] ?? "").trim();
      if (lineAfterClose.startsWith("returns ")) {
        const pr = parseReturnsClause(
          filePath,
          realNextIdx + 1,
          lineAfterClose,
          linesForReturns,
          realNextIdx,
        );
        returnsSchema = pr.returns;
        consumeEndIdx = pr.nextIndex;
      }
    }
    const expr: Expr = {
      kind: "prompt",
      raw,
      loc: stepLoc,
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
    return buildStep(expr, { bodyKind: "triple_quoted", rawBody: body }, consumeEndIdx - 1);
  }

  // --- Case 2: String literal ---
  if (promptArg.startsWith('"')) {
    if (!hasUnescapedClosingQuote(promptArg, 1)) {
      fail(filePath, 'multiline prompt strings are no longer supported; use a triple-quoted block instead: prompt """...""""', lineNo, promptCol);
    }
    const { promptRaw, returns: returnsSchema, nextIndex } = splitPromptAndReturns(
      filePath,
      lineNo,
      promptArg,
      lines,
      lineIdx,
    );
    const expr: Expr = {
      kind: "prompt",
      raw: promptRaw,
      loc: stepLoc,
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
    return buildStep(expr, { bodyKind: "string" }, nextIndex - 1);
  }

  // --- Case 3: Bare identifier ---
  const identMatch = promptArg.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!identMatch) {
    const msg = captureName
      ? 'prompt body must be a quoted string, identifier, or triple-quoted block: const name = prompt "text" | prompt myVar | prompt """ ... """'
      : 'prompt body must be a quoted string, identifier, or triple-quoted block: prompt "text" | prompt myVar | prompt """ ... """';
    fail(filePath, msg, lineNo, promptCol);
  }
  const identifier = identMatch[1];
  const afterIdent = promptArg.slice(identifier.length);

  const { returns: returnsSchema, nextIndex } = parseReturnsClause(
    filePath,
    lineNo,
    afterIdent,
    lines,
    lineIdx,
  );

  // Store as "${identifier}" so the runtime interpolates the variable.
  const raw = `"\${${identifier}}"`;
  const expr: Expr = {
    kind: "prompt",
    raw,
    loc: stepLoc,
    ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
  };
  return buildStep(expr, { bodyKind: "identifier", bodyIdentifier: identifier }, nextIndex - 1);
}
