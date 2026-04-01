import { fail, indexOfClosingDoubleQuote } from "./core";
import { parseFencedBlock } from "./fence";

export interface InlineScriptParsed {
  body: string;
  lang?: string;
  nextLineIdx: number;
}

/**
 * Parse inline script body after `script(args)`.
 * The `afterParens` is the remaining text after the closing `)`.
 * Supports two body forms:
 *   1. Quoted string: `"body"`
 *   2. Fenced block: ``` ```lang ... ``` ```
 */
export function parseInlineScriptBody(
  filePath: string,
  lines: string[],
  lineIdx: number,
  afterParens: string,
  lineNo: number,
  col: number,
): InlineScriptParsed {
  const t = afterParens.trim();

  // Case 1: Quoted string — single-line, default runtime (shell)
  if (t.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(t, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated inline script body string", lineNo, col);
    }
    const body = t.slice(1, closeIdx).replace(/\\"/g, '"');
    const trailing = t.slice(closeIdx + 1).trim();
    if (trailing) {
      fail(filePath, `unexpected content after inline script body: '${trailing}'`, lineNo, col);
    }
    return { body, nextLineIdx: lineIdx + 1 };
  }

  // Case 2: Fenced block — opening ``` must be on the same line as run script(...)
  if (t.startsWith("```")) {
    const fenceLines = [...lines];
    fenceLines[lineIdx] = t;
    const { body, lang, nextIdx, returns } = parseFencedBlock(filePath, fenceLines, lineIdx);

    if (returns) {
      fail(filePath, 'inline scripts do not support "returns" on the closing fence', lineNo, col);
    }

    // Check for both fence tag and manual shebang
    if (lang && body.trimStart().startsWith("#!")) {
      fail(
        filePath,
        `fence tag "${lang}" already sets the shebang — remove the manual "#!" line`,
        lineNo,
        col,
      );
    }

    return { body, lang, nextLineIdx: nextIdx };
  }

  if (!t) {
    fail(
      filePath,
      'inline script body is required after script(): run script() "body" or run script() ```...```',
      lineNo,
      col,
    );
  }

  fail(
    filePath,
    'inline script body must be a quoted string or fenced block: run script() "body" or run script() ```...```',
    lineNo,
    col,
  );
}
