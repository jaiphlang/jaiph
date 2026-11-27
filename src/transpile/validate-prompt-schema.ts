import { jaiphError } from "../errors";
import { parseReturnsSchema } from "../prompt-schema";

/**
 * Compile-time validation for `prompt ... returns "{ ... }"`. The schema grammar
 * lives in the shared leaf `src/prompt-schema.ts`; a parse failure carries the
 * Jaiph error code to raise (legacy flat-schema failures keep `E_SCHEMA`; the
 * enum / array grammar failures are `E_PARSE`) and a message that says what to
 * change.
 */
export function validatePromptReturnsSchema(
  rawSchema: string,
  filePath: string,
  line: number,
  col: number,
): void {
  const parsed = parseReturnsSchema(rawSchema);
  if (!parsed.ok) {
    throw jaiphError(filePath, line, col, parsed.code, parsed.message);
  }
}

/** Validate that a prompt's optional returns schema is well-formed and bound to a capture. */
export function validatePromptStepReturns(
  prompt: { returns?: string; loc: { line: number; col: number } },
  captureName: string | undefined,
  filePath: string,
): void {
  if (prompt.returns !== undefined) {
    if (!captureName) {
      throw jaiphError(
        filePath,
        prompt.loc.line,
        prompt.loc.col,
        "E_PARSE",
        'prompt with "returns" schema must capture to a variable (e.g. const result = prompt "..." returns "{ ... }")',
      );
    }
    validatePromptReturnsSchema(prompt.returns, filePath, prompt.loc.line, prompt.loc.col);
  }
}
