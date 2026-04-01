import { jaiphError } from "../errors";
import type { WorkflowStepDef } from "../types";

const SUPPORTED_SCHEMA_TYPES = new Set<string>(["string", "number", "boolean"]);

/** Compile-time validation for `prompt ... returns "{ ... }"`. */
export function validatePromptReturnsSchema(
  rawSchema: string,
  filePath: string,
  line: number,
  col: number,
): void {
  const trimmed = rawSchema.trim();
  if (trimmed.length === 0) {
    throw jaiphError(filePath, line, col, "E_SCHEMA", "returns schema cannot be empty");
  }
  if (/[[\]|]/.test(trimmed)) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_SCHEMA",
      "returns schema must be flat (no arrays or union types); only string, number, boolean allowed",
    );
  }
  const inner = trimmed.replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (inner.length === 0) return;
  const parts = inner.split(",");
  for (const part of parts) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)\s*$/);
    if (!m) {
      throw jaiphError(
        filePath,
        line,
        col,
        "E_SCHEMA",
        `invalid returns schema entry: expected "fieldName: type" (got ${part.trim().slice(0, 40)}...)`,
      );
    }
    const [, , typeStr] = m;
    const typeLower = typeStr!.trim().toLowerCase();
    if (!SUPPORTED_SCHEMA_TYPES.has(typeLower)) {
      throw jaiphError(
        filePath,
        line,
        col,
        "E_SCHEMA",
        `unsupported type in returns schema: "${typeStr}" (only string, number, boolean allowed)`,
      );
    }
  }
}

export function validatePromptStepReturns(
  step: Extract<WorkflowStepDef, { type: "prompt" }>,
  filePath: string,
): void {
  if (step.returns !== undefined) {
    if (!step.captureName) {
      throw jaiphError(
        filePath,
        step.loc.line,
        step.loc.col,
        "E_PARSE",
        'prompt with "returns" schema must capture to a variable (e.g. result = prompt "..." returns "{ ... }")',
      );
    }
    validatePromptReturnsSchema(step.returns, filePath, step.loc.line, step.loc.col);
  }
}
