import type { StepDef } from "../types";
import type { Token } from "./lexer";
import { fail, parseParamList } from "./core";
import { declHead, isPunct, keyOf } from "./body-cursor";

// Def-header parsing shared by the module-level def parser (`defs.ts`) and the
// nested-def handler in `stmt-decl.ts`. Kept in a leaf that imports only
// `core` so the def-body statement modules can reuse it without an import
// cycle through `defs.ts` (which pulls the recursive body parser
// `parseBraceBlockBody` from workflow-brace).

export interface DefHeader {
  name: string;
  params: string[];
  exported: boolean;
}

/**
 * Parse a `[export] def name(params) {` header from line `raw` and its tokens
 * (`BodyCursor.lineTokensOf`). The parameter list runs to the first `)`.
 */
export function parseDefHeader(filePath: string, raw: string, lineNo: number, toks: Token[]): DefHeader {
  const head = declHead(toks, "def");
  const open = head?.name.kind === "ident" ? toks[head.at + 2] : undefined;
  const close = isPunct(open, "(") ? raw.indexOf(")", open!.col) : -1;
  const after = close === -1 ? "" : raw.slice(close + 1);
  const name = head?.name.text;

  if (close !== -1 && after.trim() === "") {
    fail(
      filePath,
      `def declarations require braces: def ${name}() { … } or def ${name}(params) { … }`,
      lineNo,
    );
  }

  const brace = close === -1 ? null : /^\s*\{/.exec(after);
  if (!head || !brace) {
    const loose = keyOf(head?.name);
    if (loose !== undefined) {
      fail(
        filePath,
        `def declarations require parentheses: def ${loose}() { … } or def ${loose}(params) { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid def declaration", lineNo);
  }

  if (after.slice(brace[0].length).trim() !== "") {
    fail(filePath, "expected newline after '{'", lineNo);
  }

  return {
    name: head.name.text,
    params: parseParamList(filePath, raw.slice(open!.col, close), lineNo),
    exported: head.at === 1,
  };
}

/** Drop trailing `blank_line` trivia steps (whitespace before the closing brace). */
export function stripTrailingBlankLines(steps: StepDef[]): void {
  while (steps.length > 0) {
    const last = steps[steps.length - 1];
    if (last.type === "trivia" && last.kind === "blank_line") {
      steps.pop();
    } else {
      break;
    }
  }
}
