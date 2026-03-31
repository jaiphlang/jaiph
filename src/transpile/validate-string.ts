/**
 * Validate Jaiph string content (log, logerr, fail, prompt, return, send literal).
 *
 * Enforces canonical interpolation:
 * - ${varName} and ${argN} are the only supported forms.
 * - Bare $varName, $N, and braced numeric ${1} are rejected.
 * - ${var:-fallback} and other shell parameter expansion forms are rejected.
 * - Unescaped backticks are rejected.
 * - $(...) command substitution is rejected in orchestration contexts.
 */

import { jaiphError } from "../errors";
import { parseCallRef } from "../parse/core";

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
 * Find bare $name or $N outside of ${...} blocks.
 * Returns the match or null if none found.
 */
function findBareInterpolation(s: string): { index: number; match: string; hint: string } | null {
  // Walk the string, skipping over ${...} blocks and escaped $
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "$") {
      i += 1; // skip escaped $
      continue;
    }
    if (s[i] === "$") {
      // Check for ${...} — skip valid braced forms
      if (s[i + 1] === "{") continue;
      // Check for $( — handled separately by findCommandSubstitution
      if (s[i + 1] === "(") continue;
      // Bare $N (positional)
      const numMatch = s.slice(i).match(/^\$([1-9][0-9]*)/);
      if (numMatch) {
        return {
          index: i,
          match: numMatch[0],
          hint: `use \${arg${numMatch[1]}} instead of $${numMatch[1]}`,
        };
      }
      // Bare $name
      const nameMatch = s.slice(i).match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (nameMatch) {
        return {
          index: i,
          match: nameMatch[0],
          hint: `use \${${nameMatch[1]}} instead of $${nameMatch[1]}`,
        };
      }
    }
  }
  return null;
}

/**
 * Find braced numeric ${N} forms (should use ${argN} instead).
 */
function findBracedNumeric(s: string): { index: number; match: string; hint: string } | null {
  const re = /\$\{([1-9][0-9]*)\}/g;
  const m = re.exec(s);
  if (m) {
    return {
      index: m.index,
      match: m[0],
      hint: `use \${arg${m[1]}} instead of \${${m[1]}}`,
    };
  }
  return null;
}

const INLINE_CAPTURE_RE = /\$\{(run|ensure)\s+([^}]+)\}/g;

export interface InlineCapture {
  kind: "run" | "ensure";
  ref: string;
  args?: string;
}

/** Extract ${run ref [args]} and ${ensure ref [args]} from string content (unquoted). */
export function extractInlineCaptures(content: string): InlineCapture[] {
  const captures: InlineCapture[] = [];
  const re = new RegExp(INLINE_CAPTURE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const kind = m[1] as "run" | "ensure";
    const body = m[2].trim();
    const call = parseCallRef(body);
    if (!call) continue;
    captures.push({ kind, ref: call.ref, args: call.args });
  }
  return captures;
}

export interface DotFieldRef {
  varName: string;
  fieldName: string;
}

const DOT_FIELD_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

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

  const bracedNum = findBracedNumeric(content);
  if (bracedNum) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_PARSE",
      `${context} cannot use numeric interpolation \${N}; ${bracedNum.hint}`,
    );
  }

  const bare = findBareInterpolation(content);
  if (bare) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_PARSE",
      `${context} cannot use bare interpolation; ${bare.hint}`,
    );
  }

  // Validate inline captures: ${run ref()} / ${ensure ref(args)}
  const inlineRe = new RegExp(INLINE_CAPTURE_RE.source, "g");
  let icm: RegExpExecArray | null;
  while ((icm = inlineRe.exec(content)) !== null) {
    const kind = icm[1];
    const body = icm[2].trim();
    const call = parseCallRef(body);

    if (!call) {
      throw jaiphError(
        filePath, line, col, "E_PARSE",
        `${context} contains invalid inline ${kind} reference "${body}"`,
      );
    }

    if (call.args && /\$\{(?:run|ensure)\s/.test(call.args)) {
      throw jaiphError(
        filePath, line, col, "E_PARSE",
        `${context} cannot contain nested inline captures; extract to a const variable`,
      );
    }
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
