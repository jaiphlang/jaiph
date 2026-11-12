import type { PromptDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { parsePromptStep } from "./prompt";
import { declHead, isPunct, type BodyCursor } from "./body-cursor";
import { parseUseClauseKeys, useClauseAndEquals } from "./scripts";

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
  cursor: BodyCursor,
  at: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { promptDef: PromptDef; next: number; exported: boolean } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const raw = cursor.text(at);
  const toks = cursor.lineTokensOf(at);

  // [export] prompt name (params) [use KEY …] = rhs. The parameter list runs
  // to the first `)` on the line.
  const head = declHead(toks, "prompt");
  const open = head?.name.kind === "ident" ? toks[head.at + 2] : undefined;
  const close = isPunct(open, "(") ? raw.indexOf(")", open!.col) : -1;
  const eq = close === -1 ? null : useClauseAndEquals(raw, close + 1);
  if (!head || !eq) {
    if (isPunct(open, "(")) {
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

  const isExported = head.at === 1;
  const promptName = head.name.text;
  const params = raw
    .slice(open!.col, close)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
      fail(filePath, `invalid prompt parameter name "${p}"`, lineNo);
    }
  }
  const useKeys = eq.use !== undefined ? parseUseClauseKeys(filePath, eq.use, lineNo) : undefined;
  const rhs = raw.slice(eq.afterEq).trim();

  if (!rhs.startsWith('"')) {
    fail(
      filePath,
      `named prompt bodies must be a double-quoted string or triple-quoted block: prompt ${promptName}(...) = "..." or """..."""`,
      lineNo,
    );
  }

  // Reuse the prompt-step body parser: the RHS after `=` is exactly a prompt
  // step body (string or triple-quoted), with optional `returns`.
  const promptCol = eq.afterEq + 1;
  const result = parsePromptStep(cursor, at, rhs, promptCol, undefined, trivia);
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

  return { promptDef, next: result.next, exported: isExported };
}
