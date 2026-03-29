import { jaiphError } from "../errors";
import type { StepEmitCtx } from "./emit-steps";

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

type PromptSchemaField = { name: string; type: "string" | "number" | "boolean" };
const SUPPORTED_SCHEMA_TYPES = new Set<string>(["string", "number", "boolean"]);

function parsePromptSchema(
  rawSchema: string,
  filePath: string,
  line: number,
  col: number,
): PromptSchemaField[] {
  const trimmed = rawSchema.trim();
  if (trimmed.length === 0) {
    throw jaiphError(filePath, line, col, "E_SCHEMA", "returns schema cannot be empty");
  }
  if (/[[\]|]/.test(trimmed)) {
    throw jaiphError(
      filePath, line, col, "E_SCHEMA",
      "returns schema must be flat (no arrays or union types); only string, number, boolean allowed",
    );
  }
  const inner = trimmed.replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (inner.length === 0) return [];
  const fields: PromptSchemaField[] = [];
  const parts = inner.split(",");
  for (const part of parts) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)\s*$/);
    if (!m) {
      throw jaiphError(
        filePath, line, col, "E_SCHEMA",
        `invalid returns schema entry: expected "fieldName: type" (got ${part.trim().slice(0, 40)}...)`,
      );
    }
    const [, name, typeStr] = m;
    const typeLower = typeStr.trim().toLowerCase();
    if (!SUPPORTED_SCHEMA_TYPES.has(typeLower)) {
      throw jaiphError(
        filePath, line, col, "E_SCHEMA",
        `unsupported type in returns schema: "${typeStr}" (only string, number, boolean allowed)`,
      );
    }
    fields.push({ name, type: typeLower as "string" | "number" | "boolean" });
  }
  return fields;
}

/** Extract shell variable references ($name, ${name}, $1, etc.) from prompt text for tree display. */
function extractShellVarRefs(promptText: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*|[1-9][0-9]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*|[1-9][0-9]*)/g;
  let match;
  while ((match = regex.exec(promptText)) !== null) {
    const name = match[1] ?? match[2];
    if (!seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
  }
  return refs;
}

function parsePromptText(raw: string): string {
  if (!raw.startsWith(`"`)) throw new Error("invalid prompt literal");
  let closingQuote = -1;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] !== `"`) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && raw[j] === `\\`; j -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    closingQuote = i;
    break;
  }
  if (closingQuote === -1) throw new Error("unterminated prompt string");
  if (raw.slice(closingQuote + 1).trim().length > 0) {
    throw new Error("prompt allows only whitespace after closing quote");
  }
  const quoted = raw.slice(1, closingQuote);
  let out = "";
  for (let i = 0; i < quoted.length; i += 1) {
    const ch = quoted[i];
    if (ch !== `\\`) { out += ch; continue; }
    const next = quoted[i + 1];
    if (next === undefined) { out += `\\`; continue; }
    if (next === "\n") { i += 1; continue; }
    if (next === "$" || next === "`" || next === `"` || next === `\\`) { out += next; i += 1; continue; }
    out += `\\`;
  }
  return out;
}

// Prompt safety (backticks, command substitution, shell fallback) is now
// enforced at compile time by validateJaiphStringContent in validate-string.ts,
// called from validateReferences before emit runs.

function promptDelimiter(content: string, seed: number): string {
  const lines = new Set(content.split("\n"));
  let index = seed;
  while (true) {
    const candidate = `__JAIPH_PROMPT_${index}__`;
    if (!lines.has(candidate)) return candidate;
    index += 1;
  }
}

/** Escape for use inside a Bash single-quoted string; used for JAIPH_PROMPT_PREVIEW. */
function bashSingleQuotedEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

const JAIPH_APOS_VAR = "JAIPH_APOS";

function heredocLineEscape(s: string, useAposVar: boolean): string {
  if (!useAposVar) return s;
  return s.replace(/'/g, `\${JAIPH_APOS_VAR}`);
}

const PROMPT_PREVIEW_MAX_LEN = 24;

// ---------------------------------------------------------------------------
// Prompt step emitter
// ---------------------------------------------------------------------------

/** Emit a prompt step (untyped or typed with returns). When returns is set, captureName is required. */
export function emitPromptStepToOut(
  out: string[],
  indent: string,
  step: { type: "prompt"; raw: string; loc: { line: number; col: number }; captureName?: string; returns?: string },
  ctx: StepEmitCtx,
): void {
  let promptText: string;
  try {
    promptText = parsePromptText(step.raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid prompt literal";
    throw jaiphError(ctx.filePath, step.loc.line, step.loc.col, "E_PARSE", message);
  }

  const varRefs = extractShellVarRefs(promptText);
  const namedArgsSuffix = varRefs.length > 0
    ? " " + varRefs.map((v) => `"${v}=$${v}"`).join(" ")
    : "";
  const paramKeysLine = varRefs.length > 0
    ? `${indent}export JAIPH_STEP_PARAM_KEYS='__prompt_impl,__preview,${varRefs.join(",")}'`
    : null;

  if (step.returns !== undefined) {
    if (!step.captureName) {
      throw jaiphError(
        ctx.filePath, step.loc.line, step.loc.col, "E_PARSE",
        'prompt with "returns" schema must capture to a variable (e.g. result = prompt "..." returns \'{ ... }\')',
      );
    }
    const schemaFields = parsePromptSchema(step.returns, ctx.filePath, step.loc.line, step.loc.col);
    const schemaPayload = JSON.stringify({ fields: schemaFields });
    const schemaSuffix =
      "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
      JSON.stringify(Object.fromEntries(schemaFields.map((f) => [f.name, f.type])));
    const fullPromptText = promptText + schemaSuffix;
    const delimiter = promptDelimiter(fullPromptText, step.loc.line);
    const schemaEscaped = schemaPayload.replace(/'/g, "'\\''");
    const useAposSchema = fullPromptText.includes("'");
    if (useAposSchema) out.push(`${indent}local ${JAIPH_APOS_VAR}=$'\\''`);
    if (paramKeysLine != null) out.push(paramKeysLine);
    out.push(`${indent}export JAIPH_PROMPT_PREVIEW='${bashSingleQuotedEscape(fullPromptText.slice(0, PROMPT_PREVIEW_MAX_LEN))}'`);
    out.push(`${indent}export JAIPH_PROMPT_SCHEMA='${schemaEscaped}'`);
    out.push(`${indent}export JAIPH_PROMPT_CAPTURE_NAME='${step.captureName}'`);
    out.push(`${indent}jaiph::prompt_capture_with_schema "$JAIPH_PROMPT_PREVIEW"${namedArgsSuffix} <<${delimiter}`);
    for (const line of fullPromptText.split("\n")) out.push(heredocLineEscape(line, useAposSchema));
    out.push(delimiter);
    return;
  }

  const delimiter = promptDelimiter(promptText, step.loc.line);
  const useApos = promptText.includes("'");
  if (useApos) out.push(`${indent}local ${JAIPH_APOS_VAR}=$'\\''`);
  if (paramKeysLine != null) out.push(paramKeysLine);
  out.push(`${indent}export JAIPH_PROMPT_PREVIEW='${bashSingleQuotedEscape(promptText.slice(0, PROMPT_PREVIEW_MAX_LEN))}'`);
  if (step.captureName) {
    out.push(`${indent}${step.captureName}=$(jaiph::prompt_capture "$JAIPH_PROMPT_PREVIEW"${namedArgsSuffix} <<${delimiter}`);
  } else {
    out.push(`${indent}jaiph::prompt "$JAIPH_PROMPT_PREVIEW"${namedArgsSuffix} <<${delimiter}`);
  }
  for (const line of promptText.split("\n")) out.push(heredocLineEscape(line, useApos));
  out.push(delimiter);
  if (step.captureName) out.push(")");
}
