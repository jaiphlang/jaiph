import type { WorkflowDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseParamList } from "./core";
import { parseBraceBlockBody } from "./workflow-brace";

export function parseWorkflowBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { workflow: WorkflowDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const rawDecl = lines[startIndex];
  const lineDecl = rawDecl.trim();

  const parensNoBrace = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/);
  if (parensNoBrace) {
    fail(
      filePath,
      `workflow declarations require braces: workflow ${parensNoBrace[2]}() { … } or workflow ${parensNoBrace[2]}(params) { … }`,
      lineNo,
    );
  }

  // Match: [export] workflow name() { OR [export] workflow name(params) {
  const match = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/);
  if (!match) {
    const loose = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `workflow declarations require parentheses: workflow ${loose[2]}() { … } or workflow ${loose[2]}(params) { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid workflow declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const params = parseParamList(filePath, match[3], lineNo);
  const workflow: WorkflowDef = {
    name: match[2],
    params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  const braceIdx = match[0].length - 1;
  if (lineDecl[braceIdx] !== "{") {
    fail(filePath, "expected '{' after workflow header", lineNo);
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
      forRule: false,
      preserveBlankLines: true,
      onConfigBlock: (metadata, configLineNo) => {
        if (workflow.metadata !== undefined) {
          fail(filePath, "duplicate config block inside workflow (only one allowed per workflow)", configLineNo);
        }
        if (metadata.runtime) {
          fail(filePath, "runtime.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", configLineNo);
        }
        if (metadata.module) {
          fail(filePath, "module.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", configLineNo);
        }
        workflow.metadata = metadata;
      },
    },
  );
  workflow.steps.push(...bodySteps);
  // Strip trailing blank_line trivia (whitespace before closing brace).
  while (
    workflow.steps.length > 0 &&
    (() => {
      const last = workflow.steps[workflow.steps.length - 1];
      return last.type === "trivia" && last.kind === "blank_line";
    })()
  ) {
    workflow.steps.pop();
  }
  return { workflow, nextIndex: afterClose, exported: isExported };
}
