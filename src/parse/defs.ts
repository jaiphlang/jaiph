import type { Def } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseParamList } from "./core";
import { parseBraceBlockBody } from "./workflow-brace";

export function parseDefBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { def: Def; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const rawDecl = lines[startIndex];
  const lineDecl = rawDecl.trim();

  const parensNoBrace = lineDecl.match(/^(export\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/);
  if (parensNoBrace) {
    fail(
      filePath,
      `def declarations require braces: def ${parensNoBrace[2]}() { … } or def ${parensNoBrace[2]}(params) { … }`,
      lineNo,
    );
  }

  // Match: [export] def name() { OR [export] def name(params) {
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
  const isExported = Boolean(match[1]);
  const params = parseParamList(filePath, match[3], lineNo);
  const def: Def = {
    name: match[2],
    params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  const braceIdx = match[0].length - 1;
  if (lineDecl[braceIdx] !== "{") {
    fail(filePath, "expected '{' after def header", lineNo);
  }
  const afterBrace = lineDecl.slice(braceIdx + 1).trim();
  if (afterBrace !== "") {
    fail(filePath, "expected newline after '{'", lineNo);
  }

  const { steps: bodySteps, nextIdx: afterClose } = parseBraceBlockBody(
    filePath,
    lines,
    startIndex + 1,
    lineNo,
    trivia,
    {
      preserveBlankLines: true,
      onConfigBlock: (metadata, configLineNo) => {
        if (def.metadata !== undefined) {
          fail(filePath, "duplicate config block inside def (only one allowed per def)", configLineNo);
        }
        if (metadata.module) {
          fail(filePath, "module.* keys are not allowed in def-level config (only agent.* and run.* keys)", configLineNo);
        }
        def.metadata = metadata;
      },
    },
  );
  def.steps.push(...bodySteps);
  // Strip trailing blank_line trivia (whitespace before closing brace).
  while (
    def.steps.length > 0 &&
    (() => {
      const last = def.steps[def.steps.length - 1];
      return last.type === "trivia" && last.kind === "blank_line";
    })()
  ) {
    def.steps.pop();
  }
  return { def, nextIndex: afterClose, exported: isExported };
}
