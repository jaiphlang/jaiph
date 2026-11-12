import type { StepDef } from "../types";
import { fail, parseParamList } from "./core";

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

/** Parse a `[export] def name(params) {` header line into name/params/exported. */
export function parseDefHeader(filePath: string, rawDecl: string, lineNo: number): DefHeader {
  const lineDecl = rawDecl.trim();

  const parensNoBrace = lineDecl.match(/^(export\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/);
  if (parensNoBrace) {
    fail(
      filePath,
      `def declarations require braces: def ${parensNoBrace[2]}() { … } or def ${parensNoBrace[2]}(params) { … }`,
      lineNo,
    );
  }

  const match = lineDecl.match(/^(export\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/);
  if (!match) {
    const loose = lineDecl.match(/^(export\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `def declarations require parentheses: def ${loose[2]}() { … } or def ${loose[2]}(params) { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid def declaration", lineNo);
  }

  const braceIdx = match[0].length - 1;
  if (lineDecl[braceIdx] !== "{") {
    fail(filePath, "expected '{' after def header", lineNo);
  }
  const afterBrace = lineDecl.slice(braceIdx + 1).trim();
  if (afterBrace !== "") {
    fail(filePath, "expected newline after '{'", lineNo);
  }

  return {
    name: match[2],
    params: parseParamList(filePath, match[3], lineNo),
    exported: Boolean(match[1]),
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
