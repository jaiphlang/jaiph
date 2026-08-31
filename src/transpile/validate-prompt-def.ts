import type { Diagnostics } from "../diagnostics";
import type { jaiphModule, PromptDef } from "../types";
import { validatePromptReturnsSchema } from "./validate-prompt-schema";
import {
  validatePromptString,
  validateSimpleInterpolationIdentifiers,
  stripDoubleQuotes,
} from "./validate-string";

/**
 * Validate one named prompt definition's returns schema + body interpolation
 * refs. `baseKnownVars` is the definition-site scope the body may interpolate:
 * module `const`s at module level, or the enclosing def's params + `const`s for
 * a nested prompt. The prompt's own params are always added.
 */
export function validatePromptDefBody(
  diag: Diagnostics,
  filePath: string,
  prompt: PromptDef,
  baseKnownVars: Set<string>,
): void {
  diag.capture(() => {
    if (prompt.returns !== undefined) {
      validatePromptReturnsSchema(prompt.returns, filePath, prompt.loc.line, prompt.loc.col);
    }
    validatePromptString(prompt.raw, filePath, prompt.loc.line, prompt.loc.col);
    const knownVars = new Set<string>([...baseKnownVars, ...prompt.params]);
    validateSimpleInterpolationIdentifiers(
      stripDoubleQuotes(prompt.raw),
      filePath,
      prompt.loc.line,
      prompt.loc.col,
      "prompt",
      knownVars,
      "def",
    );
  });
}

/**
 * Validate module-level named prompt definitions: a well-formed returns schema
 * and body interpolation refs resolvable against the prompt's own parameters and
 * module-level `const`s (its definition-site scope — caller locals are not
 * visible inside a named prompt body). Lives in a sibling file so `validate.ts`
 * stays under the import fan-out cap.
 */
export function validatePromptDefs(diag: Diagnostics, ast: jaiphModule): void {
  const envNames = new Set((ast.envDecls ?? []).map((e) => e.name));
  for (const p of ast.prompts ?? []) {
    validatePromptDefBody(diag, ast.filePath, p, envNames);
  }
}
