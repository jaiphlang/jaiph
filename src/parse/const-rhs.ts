import type { ConstRhs, RuleRefDef, WorkflowRefDef } from "../types";
import { fail, isRef } from "./core";
import { parsePromptStep } from "./prompt";

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
      },
      nextLineIdx: result.nextLineIdx,
    };
  }
  if (head.startsWith("run ")) {
    const rest = head.slice("run ".length).trim();
    const runMatch = rest.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
    );
    if (!runMatch || !isRef(runMatch[1])) {
      fail(filePath, "const ... = run must target a workflow or script reference", lineNo, col);
    }
    const ref: WorkflowRefDef = { value: runMatch[1], loc: { line: lineNo, col } };
    return {
      value: { kind: "run_capture", ref, args: runMatch[2]?.trim() },
      nextLineIdx: lineIdx,
    };
  }
  if (head.startsWith("ensure ")) {
    const rest = head.slice("ensure ".length).trim();
    const ensureMatch = rest.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
    );
    if (!ensureMatch || !isRef(ensureMatch[1])) {
      fail(filePath, "const ... = ensure must target a rule reference", lineNo, col);
    }
    if (/\brecover\b/.test(rest)) {
      fail(filePath, "const ... = ensure cannot use recover", lineNo, col);
    }
    const ref: RuleRefDef = { value: ensureMatch[1], loc: { line: lineNo, col } };
    return {
      value: { kind: "ensure_capture", ref, args: ensureMatch[2]?.trim() },
      nextLineIdx: lineIdx,
    };
  }
  const callLike = head.trimEnd().match(
    /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+(.+)$/,
  );
  if (callLike && isRef(callLike[1])) {
    const bare = head.trimEnd();
    fail(
      filePath,
      `Script calls in const assignments must use run. Use: const ${constName} = run ${bare}`,
      lineNo,
      col,
    );
  }
  validateConstBashExpr(filePath, head, lineNo, col);
  return { value: { kind: "expr", bashRhs: head }, nextLineIdx: lineIdx };
}
