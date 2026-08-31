import type { Diagnostics } from "../diagnostics";
import type { jaiphModule } from "../types";
import { validatePromptReturnsSchema } from "./validate-prompt-schema";
import {
  validatePromptString,
  validateSimpleInterpolationIdentifiers,
  stripDoubleQuotes,
} from "./validate-string";

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
    diag.capture(() => {
      if (p.returns !== undefined) {
        validatePromptReturnsSchema(p.returns, ast.filePath, p.loc.line, p.loc.col);
      }
      validatePromptString(p.raw, ast.filePath, p.loc.line, p.loc.col);
      const knownVars = new Set<string>([...envNames, ...p.params]);
      validateSimpleInterpolationIdentifiers(
        stripDoubleQuotes(p.raw),
        ast.filePath,
        p.loc.line,
        p.loc.col,
        "prompt",
        knownVars,
        "def",
      );
    });
  }
}
