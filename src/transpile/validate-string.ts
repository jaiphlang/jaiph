/**
 * Validate Jaiph string content (log, logerr, fail, prompt, return, send literal).
 *
 * Enforces JS template literal semantics:
 * - ${varName} and $varName are supported for variable interpolation.
 * - ${var:-fallback} and other shell parameter expansion forms are rejected.
 * - Unescaped backticks are rejected.
 * - $(...) command substitution is rejected in orchestration contexts.
 */

import { jaiphError } from "../errors";

/**
 * Check for shell fallback/expansion syntax inside ${...} blocks.
 * Rejects: ${var:-default}, ${var:+alt}, ${var:=assign}, ${var:?err},
 *          ${var%%pat}, ${var//pat}, ${#var}
 */
function findShellExpansion(s: string): { index: number; match: string } | null {
  // ${var:-...}, ${var:+...}, ${var:=...}, ${var:?...}
  const fallback = /\$\{[a-zA-Z_][a-zA-Z0-9_]*:[-+=?]/;
  const m1 = fallback.exec(s);
  if (m1) return { index: m1.index, match: m1[0] };
  return null;
}

/**
 * Check for unescaped backticks in string content.
 * Content is the string AFTER quote removal (inner content).
 */
function findUnescapedBacktick(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`" && (i === 0 || s[i - 1] !== "\\")) {
      return i;
    }
  }
  return -1;
}

/**
 * Check for $(...) command substitution in string content.
 */
function findCommandSubstitution(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "(" && (i === 0 || s[i - 1] !== "\\")) {
      return i;
    }
  }
  return -1;
}

/**
 * Strip outer double quotes from a string if present.
 */
function stripDoubleQuotes(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Validate a Jaiph string (content between quotes) for disallowed patterns.
 * `content` is the raw inner string (without surrounding quotes).
 */
export function validateJaiphStringContent(
  content: string,
  filePath: string,
  line: number,
  col: number,
  context: string,
): void {
  const backtickIdx = findUnescapedBacktick(content);
  if (backtickIdx >= 0) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_PARSE",
      `${context} cannot contain backticks (\`...\`); escape with \\\` or use variable expansion`,
    );
  }

  const shellExp = findShellExpansion(content);
  if (shellExp) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_PARSE",
      `${context} cannot use shell fallback syntax (e.g. \${var:-default}); use conditional logic or named params instead`,
    );
  }

  const cmdSubIdx = findCommandSubstitution(content);
  if (cmdSubIdx >= 0) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_PARSE",
      `${context} cannot contain command substitution ($( ... )); use a script and run instead`,
    );
  }
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
 * Validate a log/logerr message (inner content without quotes).
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
