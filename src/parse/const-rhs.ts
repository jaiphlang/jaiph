import type { Expr, RuleRefDef, WorkflowRefDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseCallRef, rejectTrailingContent } from "./core";
import { parseCallRefMultiline } from "./call-args";
import { dedentTripleQuotedBody, parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";
import { parseAnonymousInlineScript } from "./inline-script";
import { parsePromptStep } from "./prompt";
import { parseMatchExpr } from "./match";
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
      'const value cannot use command substitution "$(...)"; use a script and const name = run ref',
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
 * Parse RHS after `const name = ` (trimmed). `forRule` disallows prompt capture.
 * Returns an `Expr` node — the typed value-form that replaces the legacy `ConstRhs` union.
 */
export function parseConstRhs(
  filePath: string,
  lines: string[],
  lineIdx: number,
  rhs: string,
  lineNo: number,
  col: number,
  forRule: boolean,
  constName: string,
  trivia: Trivia = createTrivia(),
): { value: Expr; nextLineIdx: number } {
  const head = rhs.trimStart();
  if (head.startsWith("prompt ")) {
    if (forRule) {
      fail(filePath, "const ... = prompt is not allowed in rules", lineNo, col);
    }
    const innerRaw = lines[lineIdx];
    const promptCol = innerRaw.indexOf("prompt") + 1;
    const promptArg = rhs.slice(rhs.indexOf("prompt") + "prompt".length).trimStart();
    const result = parsePromptStep(filePath, lines, lineIdx, promptArg, promptCol, constName, trivia);
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
    return { value: promptBody, nextLineIdx: result.nextLineIdx };
  }
  if (head.startsWith("run ")) {
    const rest = head.slice("run ".length).trim();
    // const x = run async ref() — async capture returning a handle
    if (rest.startsWith("async ")) {
      const asyncRest = rest.slice("async ".length).trim();
      if (asyncRest.startsWith("`")) {
        fail(filePath, "run async is not supported with inline scripts", lineNo, col);
      }
      const call = parseCallRef(asyncRest);
      if (!call) {
        fail(filePath, "const ... = run async must target a valid reference", lineNo, col);
      }
      rejectTrailingContent(filePath, lineNo, "run async", call.rest);
      const callee: WorkflowRefDef = { value: call.ref, loc: { line: lineNo, col } };
      return {
        value: { kind: "call", callee, args: call.args, async: true },
        nextLineIdx: lineIdx,
      };
    }
    if (rest.startsWith("`")) {
      const result = parseAnonymousInlineScript(filePath, lines, lineIdx, rest, lineNo, col);
      return {
        value: {
          kind: "inline_script",
          body: result.body,
          ...(result.lang ? { lang: result.lang } : {}),
          args: result.args,
        },
        nextLineIdx: result.nextLineIdx - 1,
      };
    }
    if (rest.startsWith("script(") || rest.startsWith("script (")) {
      fail(filePath, 'inline script syntax has changed: use const name = run `body`(args) instead of run script(args) "body"', lineNo, col);
    }
    const call = parseCallRefMultiline(filePath, lines, lineIdx, rest);
    if (!call) {
      fail(filePath, "const ... = run must target a valid reference", lineNo, col);
    }
    rejectTrailingContent(filePath, lineNo, "run", call.rest);
    const callee: WorkflowRefDef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: { kind: "call", callee, args: call.args },
      nextLineIdx: call.nextLineIdx - 1,
    };
  }
  if (head.startsWith("ensure ")) {
    const rest = head.slice("ensure ".length).trim();
    const call = parseCallRefMultiline(filePath, lines, lineIdx, rest);
    if (!call) {
      fail(filePath, "const ... = ensure must target a valid reference", lineNo, col);
    }
    if (call.rest.trim()) {
      fail(filePath, "const ... = ensure cannot use catch", lineNo, col);
    }
    const callee: RuleRefDef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: { kind: "ensure_call", callee, args: call.args },
      nextLineIdx: call.nextLineIdx - 1,
    };
  }
  // const name = match var { ... }
  const constMatchHead = head.match(/^match\s+(.+?)\s*\{\s*$/);
  if (constMatchHead) {
    const subject = constMatchHead[1].trim();
    const { expr, nextIndex } = parseMatchExpr(filePath, lines, lineIdx, subject, { line: lineNo, col });
    return { value: { kind: "match", match: expr }, nextLineIdx: nextIndex - 1 };
  }
  // const name = """..."""
  if (head.startsWith('"""')) {
    const tqLines = [...lines];
    tqLines[lineIdx] = head;
    const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, lineIdx);
    if (afterClose) fail(filePath, 'unexpected content after closing """', nextIdx);
    const value: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
    trivia.setNode(value, { tripleQuoted: true, rawBody: body });
    return { value, nextLineIdx: nextIdx - 1 };
  }
  const callLike = head.includes("(") ? parseCallRef(head.trimEnd()) : null;
  if (callLike) {
    fail(
      filePath,
      `Script calls in const assignments must use run. Use: const ${constName} = run ${head.trimEnd()}`,
      lineNo,
      col,
    );
  }
  validateConstBashExpr(filePath, head, lineNo, col);
  const isBareDotted = isBareDottedIdentifierReturn(head);
  const isBare = !isBareDotted && isBareIdentifierReturn(head);
  const raw = isBareDotted
    ? dottedReturnToQuotedString(head)
    : isBare
      ? bareIdentifierToQuotedString(head)
      : head;
  return { value: { kind: "literal", raw }, nextLineIdx: lineIdx };
}
