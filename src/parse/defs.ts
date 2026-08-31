import type { Def } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { parseDefHeader, stripTrailingBlankLines } from "./def-header";
import { parseBraceBlockBody } from "./workflow-brace";

export function parseDefBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { def: Def; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const header = parseDefHeader(filePath, lines[startIndex], lineNo);
  const def: Def = {
    name: header.name,
    params: header.params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

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
  stripTrailingBlankLines(def.steps);
  return { def, nextIndex: afterClose, exported: header.exported };
}
