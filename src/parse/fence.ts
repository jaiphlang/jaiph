import { dedentCommonLeadingWhitespace } from "./dedent";
import { fail } from "./core";

/**
 * Parse a fenced block (``` ... ```) starting at fenceLineIdx.
 * Returns the body between fences, optional lang token, the trailing text on
 * the closing fence line (after the closing ```, callers parse this for
 * (args) / returns "…" / etc.), and the next line index.
 */
export function parseFencedBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; lang?: string; afterClose: string; nextIdx: number } {
  const lineNo = fenceLineIdx + 1;
  const openLine = lines[fenceLineIdx].trim();

  // Parse opening fence: must be ``` or ```lang (single token, nothing else)
  if (!openLine.startsWith("```")) {
    fail(filePath, "expected opening fence ```", lineNo);
  }
  const afterBackticks = openLine.slice(3);
  let lang: string | undefined;
  if (afterBackticks.length > 0) {
    if (/\s/.test(afterBackticks)) {
      fail(filePath, "invalid opening fence: only a single lang token is allowed after ```", lineNo);
    }
    lang = afterBackticks;
  }

  // Collect body lines until closing fence
  const bodyLines: string[] = [];
  let i = fenceLineIdx + 1;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("```")) {
      return {
        body: bodyLines.join("\n"),
        ...(lang ? { lang } : {}),
        afterClose: trimmed.slice(3),
        nextIdx: i + 1,
      };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, "unterminated fenced block: no closing ``` before end of file", lineNo);
}

/** Remove the block's common leading margin so indented `.jh` script bodies run correctly. */
export function dedentFencedScriptBody(body: string): string {
  return dedentCommonLeadingWhitespace(body);
}

/**
 * Parse a fenced script / inline-script block and return a dedented body suitable
 * for emission and execution (heredoc delimiters, Python module indent, etc.).
 */
export function parseFencedScriptBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; lang?: string; afterClose: string; nextIdx: number } {
  const parsed = parseFencedBlock(filePath, lines, fenceLineIdx);
  return { ...parsed, body: dedentFencedScriptBody(parsed.body) };
}
