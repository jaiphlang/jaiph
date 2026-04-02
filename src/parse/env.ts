import type { EnvDeclDef } from "../types";
import { fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote } from "./core";
import { parseTripleQuoteBlock } from "./triple-quote";

export function parseEnvDecl(
  filePath: string,
  lines: string[],
  startIndex: number,
): { envDecl: EnvDeclDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  // Match: const NAME = "value" or ... = barevalue
  const match = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
  if (!match) {
    fail(filePath, 'invalid declaration — expected: const NAME = VALUE', lineNo);
  }
  const name = match[1];
  let valuePart = match[2].trim();

  // Triple-quoted multiline string
  if (valuePart.startsWith('"""')) {
    const tqLines = [...lines];
    tqLines[startIndex] = valuePart;
    const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, tqLines, startIndex);
    if (afterClose.length > 0) {
      fail(filePath, 'unexpected content after closing """ in const declaration', nextIdx);
    }
    return {
      envDecl: { name, value: body, loc: { line: lineNo, col: 1 } },
      nextIndex: nextIdx,
    };
  }

  // Double-quoted string (single-line only)
  if (valuePart.startsWith('"')) {
    if (!hasUnescapedClosingQuote(valuePart, 1)) {
      fail(filePath, 'multiline strings use triple quotes: const name = """...""""', lineNo);
    }
    const closeIdx = indexOfClosingDoubleQuote(valuePart, 1);
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

  if (valuePart.startsWith("'")) {
    fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo);
  }

  // Bare value (rest of line)
  return {
    envDecl: { name, value: valuePart, loc: { line: lineNo, col: 1 } },
    nextIndex: startIndex + 1,
  };
}
