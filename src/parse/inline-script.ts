import type { SourceLoc } from "../types";
import { fail, indexOfClosingDoubleQuote } from "./core";

export interface InlineScriptParsed {
  body: string;
  shebang?: string;
  args?: string;
}

/**
 * Parse `script("body" [, "arg1", "arg2", ...])` after the `script` keyword.
 * The input `rest` should start with `(`.
 * Returns the parsed body, optional shebang (extracted from body), and optional args string.
 */
export function parseInlineScript(
  filePath: string,
  rest: string,
  lineNo: number,
  col: number,
): InlineScriptParsed {
  const t = rest.trimStart();
  if (!t.startsWith("(")) {
    fail(filePath, 'inline script requires parentheses: run script("body")', lineNo, col);
  }

  // Find matching closing paren, respecting quotes
  let depth = 1;
  let inQuote: string | null = null;
  let i = 1; // skip opening paren
  while (i < t.length && depth > 0) {
    const ch = t[i];
    if (inQuote) {
      if (ch === inQuote && t[i - 1] !== "\\") inQuote = null;
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    i++;
  }
  if (depth !== 0) {
    fail(filePath, "unterminated inline script parentheses", lineNo, col);
  }

  const trailing = t.slice(i).trim();
  if (trailing) {
    fail(filePath, `unexpected content after inline script: '${trailing}'`, lineNo, col);
  }

  const content = t.slice(1, i - 1).trim();
  // Parse comma-separated arguments, respecting quotes
  const parts = splitCommaArgs(content);
  if (parts.length === 0) {
    fail(filePath, 'inline script requires a body string: run script("body")', lineNo, col);
  }

  const bodyRaw = parts[0].trim();
  if (!bodyRaw.startsWith('"')) {
    fail(filePath, 'inline script body must be a double-quoted string: run script("body")', lineNo, col);
  }
  const closeIdx = indexOfClosingDoubleQuote(bodyRaw, 1);
  if (closeIdx === -1 || closeIdx !== bodyRaw.length - 1) {
    fail(filePath, "unterminated inline script body string", lineNo, col);
  }
  const bodyContent = bodyRaw.slice(1, closeIdx);

  // Extract shebang if body starts with #!
  let body = bodyContent;
  let shebang: string | undefined;
  if (body.startsWith("#!")) {
    const nlIdx = body.indexOf("\\n");
    if (nlIdx !== -1) {
      shebang = body.slice(0, nlIdx);
      body = body.slice(nlIdx + 2); // skip \n
    } else {
      // entire body is the shebang with no actual commands
      shebang = body;
      body = "";
    }
  }

  // Remaining parts are arguments
  const argParts = parts.slice(1).map((p) => p.trim());
  const args = argParts.length > 0 ? argParts.join(" ") : undefined;

  return { body, shebang, args };
}

/** Split on commas outside of quotes. */
function splitCommaArgs(content: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let j = 0; j < content.length; j++) {
    const ch = content[j];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && content[j - 1] !== "\\") inQuote = null;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}
