import type { Expr, DefRef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, rejectTrailingContent } from "./core";
import { parseCallRefMultiline, parseCallRef } from "./call-args";
import { dedentTripleQuotedBody, readTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseAnonymousInlineScript, startsScript } from "./inline-script";
import type { BodyCursor } from "./body-cursor";
import { parsePromptStep } from "./prompt";
import { parseMatchAfterKeyword } from "./match";
import {
  bareIdentifierToQuotedString,
  dottedReturnToQuotedString,
  isBareDottedIdentifierReturn,
  isBareIdentifierReturn,
} from "./workflow-return-dotted";

/**
 * Reject P10 disallowed forms: command substitution and bash string ops in const RHS.
 */
export function validateConstBashExpr(filePath: string, expr: string, lineNo: number, col: number): void {
  const t = expr.trim();
  if (t.length === 0) {
    fail(filePath, "const value cannot be empty", lineNo, col);
  }
  if (/\$\(/.test(t)) {
    fail(
      filePath,
      'const value cannot use command substitution "$(...)"; use a script and const name = ref()',
      lineNo,
      col,
    );
  }
  if (/\$\{[^}]*%%/.test(t)) {
    fail(filePath, "const value cannot use ${var%%...} expansion; use a script", lineNo, col);
  }
  if (/\$\{[^}]*\/\//.test(t)) {
    fail(filePath, "const value cannot use ${var//...} expansion; use a script", lineNo, col);
  }
  if (/\$\{#/.test(t)) {
    fail(filePath, "const value cannot use ${#var}; use a script", lineNo, col);
  }
  if (/\$\{[a-zA-Z_][a-zA-Z0-9_]*:[-+=?]/.test(t)) {
    fail(
      filePath,
      "shell fallback syntax (e.g. ${var:-default}) is not supported; use conditional logic or named params instead",
      lineNo,
      col,
    );
  }
}

/**
 * Parse RHS after `const name = ` (trimmed) on the line at `at`.
 * Returns an `Expr` node — the typed value-form that replaces the legacy
 * `ConstRhs` union — and the position after the value's last line.
 */
export function parseConstRhs(
  cursor: BodyCursor,
  at: number,
  rhs: string,
  lineNo: number,
  col: number,
  constName: string,
  trivia: Trivia = createTrivia(),
): { value: Expr; next: number } {
  const filePath = cursor.filePath;
  const head = rhs.trimStart();
  if (head.startsWith("prompt ")) {
    const promptCol = cursor.firstCol(at, "prompt");
    const promptArg = head.slice("prompt".length).trimStart();
    const result = parsePromptStep(cursor, at, promptArg, promptCol, constName, trivia);
    const st = result.step;
    if (st.type !== "exec" || st.body.kind !== "prompt" || st.captureName !== constName) {
      fail(filePath, "const ... = prompt internal parse error", lineNo, col);
    }
    const promptBody = st.body;
    if (promptBody.kind !== "prompt") {
      fail(filePath, "const ... = prompt internal parse error", lineNo, col);
    }
    const promptTrivia = trivia.getNode(st);
    if (promptTrivia) {
      trivia.setNode(promptBody, {
        ...(promptTrivia.bodyKind ? { bodyKind: promptTrivia.bodyKind } : {}),
        ...(promptTrivia.bodyIdentifier ? { bodyIdentifier: promptTrivia.bodyIdentifier } : {}),
        ...(promptTrivia.rawBody !== undefined ? { rawBody: promptTrivia.rawBody } : {}),
      });
    }
    return { value: promptBody, next: result.next };
  }
  if (head.startsWith("run ") && !/^run\s*\(/.test(head)) {
    fail(filePath, "'run' is not a keyword; capture the call directly: const name = ref(args)", lineNo, col);
  }
  if (head.startsWith("ensure ")) {
    fail(filePath, "'ensure' is not a keyword; capture the call directly: const name = ref(args)", lineNo, col);
  }
  // const x = async ref() — async capture returning a handle
  if (head === "async" || head.startsWith("async ")) {
    const asyncRest = head === "async" ? "" : head.slice("async ".length).trim();
    if (startsScript(filePath, asyncRest)) {
      fail(filePath, "async is not supported with inline scripts", lineNo, col);
    }
    const call = parseCallRef(asyncRest);
    if (!call) {
      fail(filePath, "const ... = async must target a valid reference", lineNo, col);
    }
    rejectTrailingContent(filePath, lineNo, "async", call.rest);
    const callee: DefRef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: { kind: "call", callee, args: call.args, async: true },
      next: cursor.next(at),
    };
  }
  // const x = 'body'(args) — inline script
  if (startsScript(filePath, head)) {
    const result = parseAnonymousInlineScript(cursor, at, head, lineNo, col);
    const value: Expr = {
      kind: "inline_script",
      body: result.body,
      ...(result.lang ? { lang: result.lang } : {}),
      args: result.args,
    };
    trivia.setNode(value, { scriptBodyKind: result.fenced ? "fenced" : "oneline" });
    return { value, next: result.next };
  }
  // const name = match var { ... }  (compact one-line or multiline `{` opener)
  if (head.startsWith("match ") || head === "match") {
    const after = head === "match" ? "" : head.slice("match ".length);
    const { expr, next } = parseMatchAfterKeyword(cursor, at, after, { line: lineNo, col });
    return { value: { kind: "match", match: expr }, next };
  }
  // const name = """..."""
  if (head.startsWith('"""')) {
    const { body, next, closeLine, afterClose } = readTripleQuoteBlock(cursor, at, head);
    if (afterClose) fail(filePath, 'unexpected content after closing """', closeLine);
    const value: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
    trivia.setNode(value, { tripleQuoted: true, rawBody: body });
    return { value, next };
  }
  // const x = ref(args) — managed call
  const call = head.includes("(") ? parseCallRefMultiline(cursor, at, head) : null;
  if (call) {
    rejectTrailingContent(filePath, lineNo, "const", call.rest);
    const callee: DefRef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: { kind: "call", callee, args: call.args },
      next: call.next,
    };
  }
  validateConstBashExpr(filePath, head, lineNo, col);
  const isBareDotted = isBareDottedIdentifierReturn(head);
  const isBare = !isBareDotted && isBareIdentifierReturn(head);
  const raw = isBareDotted
    ? dottedReturnToQuotedString(head)
    : isBare
      ? bareIdentifierToQuotedString(head)
      : head;
  return { value: { kind: "literal", raw }, next: cursor.next(at) };
}
