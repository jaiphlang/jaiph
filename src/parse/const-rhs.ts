import type { ConstRhs, RuleRefDef, WorkflowRefDef } from "../types";
import { fail, isRef, parseCallRef } from "./core";
import { parseAnonymousInlineScript } from "./inline-script";
import { parsePromptStep } from "./prompt";
import { extractPostfixMatchSubject, parseMatchExpr } from "./match";

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
): { value: ConstRhs; nextLineIdx: number } {
  const head = rhs.trimStart();
  if (head.startsWith("prompt ")) {
    if (forRule) {
      fail(filePath, "const ... = prompt is not allowed in rules", lineNo, col);
    }
    const innerRaw = lines[lineIdx];
    const promptCol = innerRaw.indexOf("prompt") + 1;
    const promptArg = rhs.slice(rhs.indexOf("prompt") + "prompt".length).trimStart();
    const result = parsePromptStep(filePath, lines, lineIdx, promptArg, promptCol, constName);
    const st = result.step;
    if (st.type !== "prompt" || st.captureName !== constName) {
      fail(filePath, "const ... = prompt internal parse error", lineNo, col);
    }
    return {
      value: {
        kind: "prompt_capture",
        raw: st.raw,
        loc: st.loc,
        returns: st.returns,
        ...(st.bodyKind ? { bodyKind: st.bodyKind } : {}),
        ...(st.bodyIdentifier ? { bodyIdentifier: st.bodyIdentifier } : {}),
      },
      nextLineIdx: result.nextLineIdx,
    };
  }
  if (head.startsWith("run ")) {
    const rest = head.slice("run ".length).trim();
    if (rest.startsWith("`")) {
      const result = parseAnonymousInlineScript(filePath, lines, lineIdx, rest, lineNo, col);
      return {
        value: {
          kind: "run_inline_script_capture",
          body: result.body,
          ...(result.lang ? { lang: result.lang } : {}),
          args: result.args,
          ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
        },
        nextLineIdx: result.nextLineIdx - 1,
      };
    }
    if (rest.startsWith("script(") || rest.startsWith("script (")) {
      fail(filePath, 'inline script syntax has changed: use const name = run `body`(args) instead of run script(args) "body"', lineNo, col);
    }
    const call = parseCallRef(rest);
    if (!call) {
      fail(filePath, "calls require parentheses: const name = run ref() or run ref(args)", lineNo, col);
    }
    rejectTrailingContent(filePath, lineNo, "run", call.rest);
    const ref: WorkflowRefDef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: {
        kind: "run_capture", ref, args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      },
      nextLineIdx: lineIdx,
    };
  }
  if (head.startsWith("ensure ")) {
    const rest = head.slice("ensure ".length).trim();
    const call = parseCallRef(rest);
    if (!call) {
      fail(filePath, "calls require parentheses: const name = ensure ref() or ensure ref(args)", lineNo, col);
    }
    if (call.rest.trim()) {
      fail(filePath, "const ... = ensure cannot use recover", lineNo, col);
    }
    const ref: RuleRefDef = { value: call.ref, loc: { line: lineNo, col } };
    return {
      value: {
        kind: "ensure_capture", ref, args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      },
      nextLineIdx: lineIdx,
    };
  }
  // const name = <subject> match { ... }
  const matchSubject = extractPostfixMatchSubject(head);
  if (matchSubject) {
    const { expr, nextIndex } = parseMatchExpr(filePath, lines, lineIdx, matchSubject, { line: lineNo, col });
    return { value: { kind: "match_expr", match: expr }, nextLineIdx: nextIndex - 1 };
  }
  const callLike = parseCallRef(head.trimEnd());
  if (callLike) {
    fail(
      filePath,
      `Script calls in const assignments must use run. Use: const ${constName} = run ${head.trimEnd()}`,
      lineNo,
      col,
    );
  }
  validateConstBashExpr(filePath, head, lineNo, col);
  return { value: { kind: "expr", bashRhs: head }, nextLineIdx: lineIdx };
}
