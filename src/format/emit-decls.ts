import type { ScriptDef, PromptDef } from "../types";
import type { Trivia } from "../parser";
import {
  decodeTripleQuotedInner,
  emitComments,
  emitFencedScriptBodyLines,
  tn,
} from "./emit-shared";

// Declaration emitters (`script`, named `prompt`) shared by the module-level
// emitter (`emit.ts`) and the nested-declaration emitter (`emit-steps.ts`).
// `ci` is the base indent — "" at module level, the step indent for a nested
// declaration inside a def body. Kept in a leaf that imports only `emit-shared`
// so both callers reach it without an `emit.ts <-> emit-steps.ts` cycle.

/** `use KEY [KEY …]` suffix on a script / prompt declaration; empty when none. */
export function emitUseClause(use: string[] | undefined): string {
  return use?.length ? ` use ${use.join(" ")}` : "";
}

export function emitScriptDecl(
  script: ScriptDef,
  ci: string,
  pad: string,
  exported: boolean,
  trivia: Trivia,
): string[] {
  const lines: string[] = [];
  for (const c of emitComments(script.comments)) lines.push(`${ci}${c}`);
  const prefix = exported ? "export " : "";
  const useClause = emitUseClause(script.use);
  const bodyKind = tn(trivia, script).scriptBodyKind;
  if (bodyKind === "fenced" || script.lang || script.body.includes("\n")) {
    const langTag = script.lang ?? "";
    lines.push(`${ci}${prefix}script ${script.name}${useClause} = \`\`\`${langTag}`);
    lines.push(...emitFencedScriptBodyLines(script.body, `${ci}${pad}`));
    lines.push(`${ci}\`\`\``);
  } else {
    lines.push(`${ci}${prefix}script ${script.name}${useClause} = \`${script.body}\``);
  }
  return lines;
}

export function emitPromptDecl(
  prompt: PromptDef,
  ci: string,
  exported: boolean,
  trivia: Trivia,
): string[] {
  const lines: string[] = [];
  for (const c of emitComments(prompt.comments)) lines.push(`${ci}${c}`);
  const prefix = exported ? "export " : "";
  const useClause = emitUseClause(prompt.use);
  const header = `${ci}${prefix}prompt ${prompt.name}(${prompt.params.join(", ")})${useClause} = `;
  const returns = prompt.returns ? ` returns "${prompt.returns}"` : "";
  if (tn(trivia, prompt).bodyKind === "triple_quoted") {
    const inner = tn(trivia, prompt).rawBody ?? decodeTripleQuotedInner(prompt.raw);
    lines.push(`${header}"""`);
    for (const bl of inner.split("\n")) lines.push(bl);
    lines.push(`${ci}"""`);
    if (prompt.returns) lines.push(`${ci}returns "${prompt.returns}"`);
  } else {
    lines.push(`${header}${prompt.raw}${returns}`);
  }
  return lines;
}
