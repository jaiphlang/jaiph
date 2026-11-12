import type { Expr, StepDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, SINGLE_QUOTE_MESSAGE, isJaiphInterpolationRef, rejectTrailingContent } from "./core";
import { firstToken } from "./slice-lexer";
import { parseCallRef } from "./call-args";
import { dedentTripleQuotedBody, readTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import type { BodyCursor } from "./body-cursor";

/**
 * Prompt body source tag stored in trivia.
 * - "string"        → single-line `"..."`
 * - "identifier"    → bare identifier after `prompt`
 * - "triple_quoted" → triple-quote `"""..."""` block
 */
export type PromptBodyKind = "string" | "identifier" | "triple_quoted";

/** True when the line after the one at `at` exists. */
function hasNextLine(cursor: BodyCursor, at: number): boolean {
  return !cursor.atEnd(cursor.next(at));
}

/**
 * Split the prompt string token `promptRaw` (at the start of `rawPrompt`, on
 * the line at `at`) from an optional `returns "..."` after it. Consumes line
 * continuation (trailing \) after the closing quote; the schema string may
 * continue on later lines, which are read as text. Returns the optional
 * returns schema string and the position after the last line read.
 */
function splitPromptAndReturns(
  filePath: string,
  lineNo: number,
  rawPrompt: string,
  promptRaw: string,
  cursor: BodyCursor,
  at: number,
): { returns?: string; next: number } {
  let rest = rawPrompt.slice(promptRaw.length);
  let last = at;
  while (hasNextLine(cursor, last) && /\\\s*$/.test(rest.trimEnd())) {
    last = cursor.next(last);
    rest = rest.replace(/\\\s*$/, "") + "\n" + cursor.text(last).replace(/\\\s*$/, "").trimStart();
  }
  let trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { next: cursor.next(last) };
  }
  const returnsMatch = trimmed.match(/^returns\s+"/);
  if (!returnsMatch) {
    if (/^returns\s+'/.test(trimmed)) {
      fail(
        filePath,
        SINGLE_QUOTE_MESSAGE,
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
    if (!hasNextLine(cursor, last)) break;
    last = cursor.next(last);
    rest += "\n" + cursor.text(last);
    trimmed = rest.trim();
    contentStart = trimmed.indexOf('"', trimmed.indexOf("returns")) + 1;
  }
  if (contentEnd === -1) {
    fail(filePath, "unterminated returns schema string", lineNo, 1);
  }
  const returnsContent = trimmed.slice(contentStart, contentEnd).replace(/\\"/g, '"');
  return { returns: returnsContent, next: cursor.next(last) };
}

/**
 * Parse optional `returns "..."` after any prompt body form. `rest` is the
 * remaining text after the body on the line at `at`; continuation lines and a
 * schema string that continues on later lines are read as text. Returns the
 * position after the last line read.
 */
function parseReturnsClause(
  filePath: string,
  lineNo: number,
  rest: string,
  cursor: BodyCursor,
  at: number,
): { returns?: string; next: number } {
  let buf = rest;
  let last = at;
  // consume line continuations
  while (hasNextLine(cursor, last) && /\\\s*$/.test(buf.trimEnd())) {
    last = cursor.next(last);
    buf = buf.replace(/\\\s*$/, "") + "\n" + cursor.text(last).replace(/\\\s*$/, "").trimStart();
  }
  const trimmed = buf.trim();
  if (trimmed.length === 0) {
    return { next: cursor.next(last) };
  }
  const returnsMatch = trimmed.match(/^returns\s+"/);
  if (!returnsMatch) {
    if (/^returns\s+'/.test(trimmed)) {
      fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo, 1);
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
      return { returns: returnsContent, next: cursor.next(last) };
    }
    if (!hasNextLine(cursor, last)) break;
    last = cursor.next(last);
    curBuf += "\n" + cursor.text(last);
  }
  fail(filePath, "unterminated returns schema string", lineNo, 1);
}

/**
 * Parse a prompt triple-quoted block, allowing optional `returns "..."` on the closing `"""` line.
 */
function parsePromptTripleQuoteBlock(
  cursor: BodyCursor,
  at: number,
  openText: string,
): { body: string; next: number; returns?: string } {
  const { body, next, closeLine, afterClose } = readTripleQuoteBlock(cursor, at, openText);
  if (afterClose.length === 0) {
    return { body, next };
  }
  const m = afterClose.match(/^returns\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (m) {
    const content = m[1].replace(/\\"/g, '"');
    return { body, returns: content, next };
  }
  fail(
    cursor.filePath,
    'closing """ must be alone, or followed by returns "{ ... }" (same line)',
    closeLine,
  );
}

/**
 * Parse a prompt step (captured or uncaptured) on the line at `at`. Returns
 * an `exec` step whose `body` is an `Expr` with `kind: "prompt"`, and the
 * position after the step's last line.
 *
 * Supports three body forms:
 *   1. Single-line string literal: prompt "text"
 *   2. Bare identifier: prompt myVar
 *   3. Triple-quoted block: prompt """ ... """
 */
export function parsePromptStep(
  cursor: BodyCursor,
  at: number,
  promptArg: string,
  promptCol: number,
  captureName?: string,
  trivia: Trivia = createTrivia(),
): { step: StepDef; next: number } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);

  // --- Reject script fences for prompts (''' now, ``` previously) ---
  if (promptArg.startsWith("'''") || promptArg.startsWith("```")) {
    fail(
      filePath,
      'prompt blocks use triple quotes: prompt """..."""; script bodies use triple single quotes',
      lineNo,
      promptCol,
    );
  }

  const stepLoc = { line: lineNo, col: promptCol };

  const buildStep = (
    body: Expr,
    bodyTrivia: { bodyKind?: PromptBodyKind; bodyIdentifier?: string; rawBody?: string },
    next: number,
  ): { step: StepDef; next: number } => {
    trivia.setNode(body, {
      ...(bodyTrivia.bodyKind ? { bodyKind: bodyTrivia.bodyKind } : {}),
      ...(bodyTrivia.bodyIdentifier ? { bodyIdentifier: bodyTrivia.bodyIdentifier } : {}),
      ...(bodyTrivia.rawBody !== undefined ? { rawBody: bodyTrivia.rawBody } : {}),
    });
    const step: StepDef = {
      type: "exec",
      body,
      ...(captureName ? { captureName } : {}),
      loc: stepLoc,
    };
    return { step, next };
  };

  // --- Case 1: Triple-quoted block ---
  if (promptArg.startsWith('"""')) {
    const { body, next: afterBlock, returns: returnsOnClosingLine } = parsePromptTripleQuoteBlock(cursor, at, promptArg);
    const raw = tripleQuoteBodyToRaw(dedentTripleQuotedBody(body));
    let returnsSchema: string | undefined = returnsOnClosingLine;
    let consumeEnd = afterBlock;
    if (returnsSchema === undefined) {
      const lineAfterClose = cursor.text(afterBlock).trim();
      if (lineAfterClose.startsWith("returns ")) {
        const pr = parseReturnsClause(filePath, cursor.lineNo(afterBlock), lineAfterClose, cursor, afterBlock);
        returnsSchema = pr.returns;
        consumeEnd = pr.next;
      }
    }
    const expr: Expr = {
      kind: "prompt",
      raw,
      loc: stepLoc,
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
    return buildStep(expr, { bodyKind: "triple_quoted", rawBody: body }, consumeEnd);
  }

  // --- Case 2: String literal ---
  if (promptArg.startsWith('"')) {
    const str = firstToken(filePath, promptArg)!;
    if (str.kind !== "string") {
      fail(filePath, 'multiline prompt strings are no longer supported; use a triple-quoted block instead: prompt """...""""', lineNo, promptCol);
    }
    const promptRaw = str.text;
    const { returns: returnsSchema, next } = splitPromptAndReturns(filePath, lineNo, promptArg, promptRaw, cursor, at);
    const expr: Expr = {
      kind: "prompt",
      raw: promptRaw,
      loc: stepLoc,
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
    return buildStep(expr, { bodyKind: "string" }, next);
  }

  // --- Case 2b: Bare ${name} or ${name.field} interpolation ref ---
  if (promptArg.startsWith("${")) {
    const closeIdx = promptArg.indexOf("}");
    if (closeIdx !== -1) {
      const refToken = promptArg.slice(0, closeIdx + 1);
      if (isJaiphInterpolationRef(refToken)) {
        const afterRef = promptArg.slice(closeIdx + 1);
        const { returns: returnsSchema, next } = parseReturnsClause(filePath, lineNo, afterRef, cursor, at);
        const raw = `"${refToken}"`;
        const expr: Expr = {
          kind: "prompt",
          raw,
          loc: stepLoc,
          ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
        };
        return buildStep(expr, { bodyKind: "string" }, next);
      }
    }
  }

  // --- Case 2c: Named-prompt invocation `prompt foo(args)` ---
  // A parenthesised call form invokes a module-level named prompt. The bare
  // `prompt foo` (no `()`) form below stays the identifier-as-body sugar.
  const call = parseCallRef(promptArg);
  if (call) {
    rejectTrailingContent(filePath, lineNo, "prompt", call.rest);
    const expr: Expr = {
      kind: "prompt",
      raw: "",
      loc: stepLoc,
      name: call.ref,
      ...(call.args ? { args: call.args } : {}),
    };
    return buildStep(expr, {}, cursor.next(at));
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

  const { returns: returnsSchema, next } = parseReturnsClause(filePath, lineNo, afterIdent, cursor, at);

  // Store as "${identifier}" so the runtime interpolates the variable.
  const raw = `"\${${identifier}}"`;
  const expr: Expr = {
    kind: "prompt",
    raw,
    loc: stepLoc,
    ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
  };
  return buildStep(expr, { bodyKind: "identifier", bodyIdentifier: identifier }, next);
}
