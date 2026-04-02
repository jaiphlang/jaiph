import type { WorkflowStepDef } from "../types";
import { fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote } from "./core";
import { parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";

/**
 * Prompt body source tag stored in the AST.
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
 * Parse a prompt step (captured or uncaptured).
 * Supports three body forms:
 *   1. Single-line string literal: prompt "text"
 *   2. Bare identifier: prompt myVar
 *   3. Triple-quoted block: prompt """ ... """
 *
 * Returns the parsed step and the 0-based line index to continue from.
 * For recover statements where multiline scanning is unnecessary, pass `[]` for lines.
 */
export function parsePromptStep(
  filePath: string,
  lines: string[],
  lineIdx: number,
  promptArg: string,
  promptCol: number,
  captureName?: string,
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

  // --- Case 1: Triple-quoted block ---
  if (promptArg.startsWith('"""')) {
    // Build a lines array where the opening """ sits at the real lineIdx
    // so that parseTripleQuoteBlock reports correct line numbers on errors.
    const tqLines = [...lines];
    tqLines[lineIdx] = promptArg;
    const { body, nextIdx: realNextIdx, returns: returnsOnClosingLine } = parsePromptTripleQuoteBlock(
      filePath,
      tqLines,
      lineIdx,
    );

    // Wrap body in quotes so the runtime's interpolateWithCaptures can process ${} vars
    const raw = tripleQuoteBodyToRaw(body);

    let returnsSchema: string | undefined = returnsOnClosingLine;
    let consumeEndIdx = realNextIdx;
    if (returnsSchema === undefined) {
      const lineAfterClose = (lines[realNextIdx] ?? "").trim();
      if (lineAfterClose.startsWith("returns ")) {
        const pr = parseReturnsClause(
          filePath,
          realNextIdx + 1,
          lineAfterClose,
          lines,
          realNextIdx,
        );
        returnsSchema = pr.returns;
        consumeEndIdx = pr.nextIndex;
      }
    }

    return {
      step: {
        type: "prompt",
        raw,
        bodyKind: "triple_quoted",
        loc: { line: lineNo, col: promptCol },
        ...(captureName ? { captureName } : {}),
        ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
      },
      nextLineIdx: consumeEndIdx - 1,
    };
  }

  // --- Case 2: String literal ---
  if (promptArg.startsWith('"')) {
    // Check for triple-quote opening: "\"\" (three quotes) — handle as triple-quoted block
    // This won't match since we check for """ above first.
    // Check for multiline quoted string (no closing quote on same line) — reject it
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
    return {
      step: {
        type: "prompt",
        raw: promptRaw,
        bodyKind: "string",
        loc: { line: lineNo, col: promptCol },
        ...(captureName ? { captureName } : {}),
        ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
      },
      nextLineIdx: nextIndex - 1,
    };
  }

  // --- Case 3: Bare identifier ---
  // Greedy: take the first token as the identifier
  const identMatch = promptArg.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!identMatch) {
    const msg = captureName
      ? 'prompt body must be a quoted string, identifier, or triple-quoted block: const name = prompt "text" | prompt myVar | prompt """ ... """'
      : 'prompt body must be a quoted string, identifier, or triple-quoted block: prompt "text" | prompt myVar | prompt """ ... """';
    fail(filePath, msg, lineNo, promptCol);
  }
  const identifier = identMatch[1];
  const afterIdent = promptArg.slice(identifier.length);

  // Check for `returns` after the identifier
  const { returns: returnsSchema, nextIndex } = parseReturnsClause(
    filePath,
    lineNo,
    afterIdent,
    lines,
    lineIdx,
  );

  // Store as "${identifier}" so the runtime interpolates the variable
  const raw = `"\${${identifier}}"`;
  return {
    step: {
      type: "prompt",
      raw,
      bodyKind: "identifier",
      bodyIdentifier: identifier,
      loc: { line: lineNo, col: promptCol },
      ...(captureName ? { captureName } : {}),
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    },
    nextLineIdx: nextIndex - 1,
  };
}
