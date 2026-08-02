/**
 * Validate Jaiph string content (log, logerr, fail, prompt, return, send literal).
 *
 * Enforces canonical interpolation:
 * - ${varName} is the only supported form (named parameters, const, captures).
 * - Bare $varName, $N, and braced numeric ${1} are rejected.
 * - ${var:-fallback} and other shell parameter expansion forms are rejected.
 * - Unescaped backticks are rejected.
 * - $(...) command substitution is rejected in orchestration contexts.
 */

import { jaiphError } from "../errors";
// `validateJaiphStringContent` / `extractInlineCaptures` now live in the parse
// layer (they need `parseCallRef`); imported through the parse public entry and
// re-exported so compile-time callers keep importing them from this module.
import { validateJaiphStringContent, extractInlineCaptures } from "../parser";
export { validateJaiphStringContent, extractInlineCaptures };
export type { InlineCapture } from "../parser";

export interface DotFieldRef {
  varName: string;
  fieldName: string;
}

const DOT_FIELD_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const SIMPLE_BRACED_IDENT = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Ensure `${name}` references are defined: named bindings in `knownVars`.
 * Positional `${argN}` access is not supported — use declared parameter names.
 */
export function validateSimpleInterpolationIdentifiers(
  content: string,
  filePath: string,
  line: number,
  col: number,
  context: string,
  knownVars: Set<string>,
  scopeLabel: "workflow" | "rule",
  /** Typed prompt captures: map capture name → returns schema field names (for `${base}` / `${base_field}`). */
  promptFieldSchemas?: Map<string, string[]>,
  /** Extra variable names from `ensure … catch` bindings. */
  recoverBindings?: Set<string>,
  /** Script names in the current module — `${scriptName}` is rejected because scripts cannot be interpolated. */
  localScripts?: Set<string>,
): void {
  const re = new RegExp(SIMPLE_BRACED_IDENT.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!;
    if (recoverBindings?.has(name)) {
      continue;
    }
    if (knownVars.has(name)) {
      continue;
    }
    if (promptFieldSchemas) {
      let okUnderscore = false;
      for (const [captureName, fields] of promptFieldSchemas) {
        const prefix = `${captureName}_`;
        if (name.startsWith(prefix)) {
          const fieldName = name.slice(prefix.length);
          if (fieldName && fields.includes(fieldName)) {
            okUnderscore = true;
            break;
          }
        }
      }
      if (okUnderscore) {
        continue;
      }
    }
    if (localScripts?.has(name)) {
      throw jaiphError(
        filePath,
        line,
        col,
        "E_VALIDATE",
        `scripts cannot be interpolated; "${name}" is a script definition`,
      );
    }
    throw jaiphError(
      filePath,
      line,
      col,
      "E_VALIDATE",
      `unknown identifier "${name}" in ${context}; declare it with \`const\`, use a capture, or add a ${scopeLabel} parameter`,
    );
  }
}

/** Extract ${var.field} dot-notation references from string content (unquoted). */
export function extractDotFieldRefs(content: string): DotFieldRef[] {
  const refs: DotFieldRef[] = [];
  const re = new RegExp(DOT_FIELD_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    refs.push({ varName: m[1], fieldName: m[2] });
  }
  return refs;
}

/**
 * Strip outer double quotes from a string if present.
 */
export function stripDoubleQuotes(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Validate a prompt raw string (with surrounding quotes).
 */
export function validatePromptString(
  raw: string,
  filePath: string,
  line: number,
  col: number,
): void {
  const content = stripDoubleQuotes(raw);
  validateJaiphStringContent(content, filePath, line, col, "prompt");
}

/**
 * Validate a log/logerr message (inner content without quotes). Triple-quoted
 * messages arrive pre-dedented from the parser, so this validator no longer
 * needs to know about that distinction.
 */
export function validateLogString(
  message: string,
  filePath: string,
  line: number,
  col: number,
  keyword: string,
): void {
  validateJaiphStringContent(message, filePath, line, col, keyword);
}

/**
 * Validate a fail message (with surrounding quotes).
 */
export function validateFailString(
  message: string,
  filePath: string,
  line: number,
  col: number,
): void {
  const content = stripDoubleQuotes(message);
  validateJaiphStringContent(content, filePath, line, col, "fail");
}

/**
 * Validate a return value string. Only validates quoted string forms.
 */
export function validateReturnString(
  value: string,
  filePath: string,
  line: number,
  col: number,
): void {
  if (value.startsWith('"')) {
    const content = stripDoubleQuotes(value);
    validateJaiphStringContent(content, filePath, line, col, "return");
  }
}
