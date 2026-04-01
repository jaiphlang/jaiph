import type { WorkflowStepDef } from "../types";
import { fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote } from "./core";

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
 * Parse a prompt step (captured or uncaptured, single-line or multiline).
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
  if (!promptArg.startsWith('"')) {
    const msg = captureName
      ? 'prompt must match: name = prompt "<text>"'
      : 'prompt must match: prompt "<text>"';
    fail(filePath, msg, lineNo, promptCol);
  }
  let rawPrompt = promptArg;
  let scanIdx = lineIdx;
  if (!hasUnescapedClosingQuote(promptArg, 1)) {
    let closed = false;
    for (let la = lineIdx + 1; la < lines.length; la += 1) {
      rawPrompt += `\n${lines[la]}`;
      if (hasUnescapedClosingQuote(lines[la], 0)) {
        scanIdx = la;
        closed = true;
        break;
      }
    }
    if (!closed) {
      fail(filePath, "unterminated prompt string", lineNo, promptCol);
    }
  }
  const { promptRaw, returns: returnsSchema, nextIndex } = splitPromptAndReturns(
    filePath,
    lineNo,
    rawPrompt,
    lines,
    scanIdx,
  );
  return {
    step: {
      type: "prompt",
      raw: promptRaw,
      loc: { line: lineNo, col: promptCol },
      ...(captureName ? { captureName } : {}),
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    },
    nextLineIdx: nextIndex - 1,
  };
}
