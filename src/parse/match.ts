import type { MatchArmDef, MatchExprDef, MatchPatternDef } from "../types";
import { fail, indexOfClosingDoubleQuote } from "./core";

/**
 * Parse a single match arm pattern: "literal", /regex/, or _
 * Returns the pattern and the rest of the string after the pattern.
 */
function parsePattern(filePath: string, text: string, lineNo: number): { pattern: MatchPatternDef; rest: string } {
  const t = text.trimStart();
  if (t.startsWith("_")) {
    const after = t.slice(1).trimStart();
    return { pattern: { kind: "wildcard" }, rest: after };
  }
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in match pattern", lineNo);
    }
    const value = t.slice(1, closeIdx).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    const rest = t.slice(closeIdx + 1).trimStart();
    return { pattern: { kind: "string_literal", value }, rest };
  }
  if (t.startsWith("'")) {
    fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo);
  }
  if (t.startsWith("/")) {
    // Find closing / (not escaped)
    let closeIdx = -1;
    for (let i = 1; i < t.length; i += 1) {
      if (t[i] === "/" && t[i - 1] !== "\\") {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      fail(filePath, "unterminated regex in match pattern", lineNo);
    }
    const source = t.slice(1, closeIdx);
    if (source.length === 0) {
      fail(filePath, "empty regex in match pattern", lineNo);
    }
    // Validate regex syntax
    try {
      new RegExp(source);
    } catch {
      fail(filePath, `invalid regex in match pattern: /${source}/`, lineNo);
    }
    const rest = t.slice(closeIdx + 1).trimStart();
    return { pattern: { kind: "regex", source }, rest };
  }
  fail(filePath, 'match pattern must be a string literal ("..."), regex (/…/), or wildcard (_)', lineNo);
}

/**
 * Parse the body (value expression) after `=>` in a match arm.
 * Returns the raw value string (with quotes).
 */
function parseArmBody(filePath: string, text: string, lineNo: number): string {
  const t = text.trimStart();
  if (!t) {
    fail(filePath, "match arm body cannot be empty", lineNo);
  }
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in match arm body", lineNo);
    }
    return t.slice(0, closeIdx + 1);
  }
  if (t.startsWith("'")) {
    fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo);
  }
  // Allow $var, ${var}, ${var.field}, or bare words up to end of line
  return t;
}

/**
 * Parse match arms from lines inside `{ ... }`.
 * Each arm is on its own line: `pattern => body`
 * Returns the parsed arms and the index after the closing `}`.
 */
export function parseMatchArms(
  filePath: string,
  lines: string[],
  startIndex: number,
  openerLineNo: number,
): { arms: MatchArmDef[]; nextIndex: number } {
  const arms: MatchArmDef[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      i += 1;
      continue;
    }
    if (line === "}") {
      return { arms, nextIndex: i + 1 };
    }
    const { pattern, rest } = parsePattern(filePath, line, lineNo);
    if (!rest.startsWith("=>")) {
      fail(filePath, 'expected "=>" after match pattern', lineNo);
    }
    const afterArrow = rest.slice(2).trimStart();
    const body = parseArmBody(filePath, afterArrow, lineNo);
    arms.push({ pattern, body });
    i += 1;
  }
  fail(filePath, "unterminated match block", openerLineNo);
}

/**
 * Parse a match expression: `match <subject> { ... }` or `<subject> match { ... }`
 * Given the subject string and the lines starting from the `{` line.
 */
export function parseMatchExpr(
  filePath: string,
  lines: string[],
  braceLineIndex: number,
  subject: string,
  loc: { line: number; col: number },
): { expr: MatchExprDef; nextIndex: number } {
  const { arms, nextIndex } = parseMatchArms(filePath, lines, braceLineIndex + 1, loc.line);
  if (arms.length === 0) {
    fail(filePath, "match must have at least one arm", loc.line);
  }
  return {
    expr: { subject, arms, loc },
    nextIndex,
  };
}

/**
 * Try to detect `<subject> match {` at end of a string.
 * Returns the subject if found, null otherwise.
 */
export function extractPostfixMatchSubject(text: string): string | null {
  const m = text.match(/^(.+?)\s+match\s*\{\s*$/);
  if (!m) return null;
  return m[1].trim();
}
