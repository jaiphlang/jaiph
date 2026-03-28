import type { EnvDeclDef } from "../types";
import { fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote } from "./core";

export function parseEnvDecl(
  filePath: string,
  lines: string[],
  startIndex: number,
): { envDecl: EnvDeclDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  // Match: const NAME = "value" or ... = 'value' or ... = barevalue
  const match = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
  if (!match) {
    fail(filePath, 'invalid declaration — expected: const NAME = VALUE', lineNo);
  }
  const name = match[1];
  let valuePart = match[2].trim();

  // Double-quoted string (may be multi-line)
  if (valuePart.startsWith('"')) {
    let rawValue = valuePart;
    let nextIndex = startIndex + 1;
    if (!hasUnescapedClosingQuote(valuePart, 1)) {
      let closed = false;
      for (let lookahead = startIndex + 1; lookahead < lines.length; lookahead += 1) {
        rawValue += `\n${lines[lookahead]}`;
        if (hasUnescapedClosingQuote(lines[lookahead], 0)) {
          nextIndex = lookahead + 1;
          closed = true;
          break;
        }
      }
      if (!closed) {
        fail(filePath, "unterminated string in const declaration", lineNo);
      }
    }
    const closeIdx = indexOfClosingDoubleQuote(rawValue, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in const declaration", lineNo);
    }
    const afterClose = rawValue.slice(closeIdx + 1).trim();
    if (afterClose.length > 0) {
      fail(filePath, "unexpected content after closing quote in const declaration", lineNo);
    }
    const value = rawValue.slice(1, closeIdx);
    return {
      envDecl: { name, value, loc: { line: lineNo, col: 1 } },
      nextIndex,
    };
  }

  // Single-quoted string (single-line only for now)
  if (valuePart.startsWith("'")) {
    const closeIdx = valuePart.indexOf("'", 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated string in const declaration", lineNo);
    }
    const afterClose = valuePart.slice(closeIdx + 1).trim();
    if (afterClose.length > 0) {
      fail(filePath, "unexpected content after closing quote in const declaration", lineNo);
    }
    const value = valuePart.slice(1, closeIdx);
    return {
      envDecl: { name, value, loc: { line: lineNo, col: 1 } },
      nextIndex: startIndex + 1,
    };
  }

  // Bare value (rest of line)
  return {
    envDecl: { name, value: valuePart, loc: { line: lineNo, col: 1 } },
    nextIndex: startIndex + 1,
  };
}
