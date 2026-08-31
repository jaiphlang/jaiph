import type { PromptDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { parsePromptStep } from "./prompt";
import { parseUseClauseKeys } from "./scripts";

/**
 * Parse a module-level named prompt definition:
 *
 *   [export] prompt name(params) [use KEY …] = "single line"
 *   [export] prompt name(params) [use KEY …] = """
 *     multi
 *     line
 *   """
 *   returns "{ ... }"
 *
 * The RHS uses the same body forms as a `prompt` step (double-quoted single
 * line or `"""…"""`), reusing `parsePromptStep`. The identifier-as-body form is
 * a step-only sugar and is rejected here — a definition RHS must be a string or
 * triple-quoted block. The optional `use` clause shares the grammar and
 * reserved-key rules with `use` on scripts.
 */
export function parsePromptDefBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { promptDef: PromptDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const match = line.match(
    /^(export\s+)?prompt\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)(?:\s+use\s+([^=]+?))?\s*=\s*(.*)$/s,
  );
  if (!match) {
    if (/^(export\s+)?prompt\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      fail(
        filePath,
        'named prompt definitions require = after the parameter list: prompt name(params) = "..."',
        lineNo,
      );
    }
    fail(
      filePath,
      'invalid named prompt definition: prompt name(params) [use KEY ...] = "..." or """..."""',
      lineNo,
    );
  }

  const isExported = Boolean(match[1]);
  const promptName = match[2];
  const params = match[3]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
      fail(filePath, `invalid prompt parameter name "${p}"`, lineNo);
    }
  }
  const useKeys = match[4] !== undefined ? parseUseClauseKeys(filePath, match[4], lineNo) : undefined;
  const rhs = match[5].trimStart();

  if (!rhs.startsWith('"')) {
    fail(
      filePath,
      `named prompt bodies must be a double-quoted string or triple-quoted block: prompt ${promptName}(...) = "..." or """..."""`,
      lineNo,
    );
  }

  // Reuse the prompt-step body parser: the RHS after `=` is exactly a prompt
  // step body (string or triple-quoted), with optional `returns`.
  const bodyLines = [...lines];
  bodyLines[startIndex] = rhs;
  const promptCol = raw.indexOf("=") + 2;
  const result = parsePromptStep(filePath, bodyLines, startIndex, rhs, promptCol, undefined, trivia);
  const step = result.step;
  if (step.type !== "exec" || step.body.kind !== "prompt") {
    fail(filePath, "internal: named prompt body parse error", lineNo);
  }
  const body = step.body;
  if (body.kind !== "prompt") {
    fail(filePath, "internal: named prompt body parse error", lineNo);
  }

  const promptDef: PromptDef = {
    name: promptName,
    params,
    comments: pendingComments,
    raw: body.raw,
    ...(body.returns !== undefined ? { returns: body.returns } : {}),
    ...(useKeys ? { use: useKeys } : {}),
    loc: { line: lineNo, col: 1 },
  };

  // Carry the body's surface form (bodyKind / rawBody) onto the def node so the
  // formatter round-trips the RHS.
  const bodyTrivia = trivia.getNode(body) ?? trivia.getNode(step);
  if (bodyTrivia) {
    trivia.setNode(promptDef, {
      ...(bodyTrivia.bodyKind ? { bodyKind: bodyTrivia.bodyKind } : {}),
      ...(bodyTrivia.rawBody !== undefined ? { rawBody: bodyTrivia.rawBody } : {}),
    });
  }

  return { promptDef, nextIndex: result.nextLineIdx + 1, exported: isExported };
}
