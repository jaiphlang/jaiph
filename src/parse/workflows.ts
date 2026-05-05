import type { WorkflowDef } from "../types";
import { fail, parseParamList } from "./core";
import { parseConfigBlock } from "./metadata";
import { parseBraceBlockBody, parseBlockStatement } from "./workflow-brace";
import {
  expandBlockLineStatements,
  findClosingBraceIndex,
  shouldApplySemicolonStatementSplit,
  shouldSkipSemicolonSplitForLine,
} from "./statement-split";

export function parseWorkflowBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
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
  const closeIdx = findClosingBraceIndex(lineDecl, braceIdx);
  const isInlineBody = closeIdx !== -1 && lineDecl.slice(closeIdx + 1).trim() === "";

  if (isInlineBody) {
    const bodyInner = lineDecl.slice(braceIdx + 1, closeIdx);
    const bodyLines = bodyInner.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const chunks: string[] = [];
    for (const bl of bodyLines) {
      if (shouldSkipSemicolonSplitForLine(bl)) {
        chunks.push(bl);
        continue;
      }
      const ex = expandBlockLineStatements(bl);
      if (shouldApplySemicolonStatementSplit(ex)) {
        chunks.push(...ex);
      } else {
        chunks.push(bl);
      }
    }
    let hadNonCommentStepInline = false;
    for (const chunk of chunks) {
      const t = chunk.trim();
      if (!t) continue;
      if (t.startsWith("#")) {
        workflow.steps.push({
          type: "comment",
          text: t,
          loc: { line: lineNo, col: 1 },
        });
        continue;
      }
      if (/^config\s*\{/.test(t)) {
        if (workflow.metadata !== undefined) {
          fail(filePath, "duplicate config block inside workflow (only one allowed per workflow)", lineNo);
        }
        if (hadNonCommentStepInline) {
          fail(filePath, "config block inside workflow must appear before any steps", lineNo);
        }
        const { metadata, nextIndex } = parseConfigBlock(filePath, [t], 0);
        if (nextIndex !== 1) {
          fail(filePath, "internal parse error: inline config expected on one line", lineNo);
        }
        if (metadata.runtime) {
          fail(filePath, "runtime.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", lineNo);
        }
        if (metadata.module) {
          fail(filePath, "module.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", lineNo);
        }
        workflow.metadata = metadata;
        continue;
      }
      hadNonCommentStepInline = true;
      const st = parseBlockStatement(filePath, [t], 0, { forRule: false });
      workflow.steps.push(st.step);
    }
    return { workflow, nextIndex: startIndex + 1, exported: isExported };
  }

  if (closeIdx === -1) {
    const afterBrace = lineDecl.slice(braceIdx + 1).trim();
    if (afterBrace !== "") {
      fail(
        filePath,
        "expected newline after '{' or a complete inline workflow body ending with '}' on the same line",
        lineNo,
      );
    }
  }

  const { steps: bodySteps, nextIdx: afterClose } = parseBraceBlockBody(
    filePath,
    lines,
    startIndex + 1,
    lineNo,
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
  // Strip trailing blank_line (whitespace before closing brace).
  while (workflow.steps.length > 0 && workflow.steps[workflow.steps.length - 1].type === "blank_line") {
    workflow.steps.pop();
  }
  return { workflow, nextIndex: afterClose, exported: isExported };
}
