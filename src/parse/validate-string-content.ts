/**
 * Validate Jaiph string content (log, logerr, fail, prompt, return, send literal)
 * and extract inline `${greet()}` captures.
 *
 * These live in the parse layer because they need `parseCallRef` (a parse
 * primitive) to interpret inline captures, and because config parsing
 * (`parse/metadata.ts`) validates interpolation at parse time. Compile-time
 * callers reach them through the parse public entry (`src/parser.ts`).
 *
 * Enforces canonical interpolation:
 * - ${varName} is the only supported form (named parameters, const, captures).
 * - Bare $varName, $N, and braced numeric ${1} are rejected.
 * - ${var:-fallback} and other shell parameter expansion forms are rejected.
 * - Unescaped backticks are rejected.
 * - $(...) command substitution is rejected in orchestration contexts.
 */

import { jaiphError } from "../errors";
import { parseCallRef } from "./call-args";
import type { Arg } from "../types";

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

const INLINE_CAPTURE_RE = /\$\{([A-Za-z_][A-Za-z0-9_.]*\s*\([^}]*\))\}/g;

export interface InlineCapture {
  ref: string;
  args?: Arg[];
}

/**
 * One inline `${ref(args)}` capture located in string content, with its span
 * and parsed call. `ref` is null when the body is not a valid call ref (the
 * validator reports it; the runtime skips it).
 */
export interface InlineCaptureMatch {
  /** Offset of the whole `${…}` match in the scanned content. */
  index: number;
  /** Length of the whole `${…}` match. */
  length: number;
  /** The capture body inside `${…}`, trimmed. */
  body: string;
  /** Parsed call ref, or null when `body` is not a valid call. */
  ref: string | null;
  args?: Arg[];
}

/**
 * The single inline-capture scanner: find every `${ref(args)}` in `content` and
 * parse each with `parseCallRef`. One definition behind the compiler validator
 * and the runtime, so both agree on what is a capture and how its call parses.
 */
export function scanInlineCaptures(content: string): InlineCaptureMatch[] {
  const matches: InlineCaptureMatch[] = [];
  const re = new RegExp(INLINE_CAPTURE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1].trim();
    const call = parseCallRef(body);
    matches.push({
      index: m.index,
      length: m[0].length,
      body,
      ref: call ? call.ref : null,
      ...(call?.args ? { args: call.args } : {}),
    });
  }
  return matches;
}

/** Extract inline call captures `${ref(args)}` from string content (unquoted). */
export function extractInlineCaptures(content: string): InlineCapture[] {
  return scanInlineCaptures(content)
    .filter((c) => c.ref !== null)
    .map((c) => ({ ref: c.ref!, args: c.args }));
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
      `${context} cannot contain command substitution ($( ... )); use a script instead`,
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

  // Validate inline call captures: ${ref()} / ${ref(args)}
  for (const cap of scanInlineCaptures(content)) {
    if (cap.ref === null) {
      throw jaiphError(
        filePath, line, col, "E_PARSE",
        `${context} contains invalid inline call reference "${cap.body}"`,
      );
    }

    if (cap.args?.some((a) => a.kind === "literal" && /\$\{[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(a.raw))) {
      throw jaiphError(
        filePath, line, col, "E_PARSE",
        `${context} cannot contain nested inline captures; extract to a const variable`,
      );
    }
  }
}
