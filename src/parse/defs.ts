import type { Def } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { parseDefHeader, stripTrailingBlankLines } from "./def-header";
import { parseBraceBlockBody } from "./workflow-brace";
import type { BodyCursor } from "./body-cursor";

export function parseDefBlock(
  cursor: BodyCursor,
  at: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { def: Def; next: number; exported: boolean } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const header = parseDefHeader(filePath, cursor.text(at), lineNo, cursor.lineTokensOf(at));
  const def: Def = {
    name: header.name,
    params: header.params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  const { steps: bodySteps, next } = parseBraceBlockBody(
    cursor,
    cursor.next(at),
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
  stripTrailingBlankLines(def.steps);
  return { def, next, exported: header.exported };
}
