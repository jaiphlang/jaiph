import { dedentCommonLeadingWhitespace } from "./dedent";
import { fail } from "./core";

/**
 * Closing line is either exactly ``` or ``` returns "{ schema }" (prompt typed capture on same line).
 */
function parseClosingFenceLine(
  filePath: string,
  lineNo: number,
  trimmed: string,
): { kind: "bare" } | { kind: "with_returns"; returns: string } {
  if (trimmed === "```") {
    return { kind: "bare" };
  }
  if (!trimmed.startsWith("```")) {
    fail(filePath, "internal: expected closing line to start with ```", lineNo);
  }
  const m = trimmed.match(/^```\s+returns\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (m) {
    const content = m[1].replace(/\\"/g, '"');
    return { kind: "with_returns", returns: content };
  }
  fail(
    filePath,
    'closing fence must be exactly ```, or ``` returns "{ ... }" (same line)',
    lineNo,
  );
}

/**
 * Parse a fenced block (``` ... ```) starting at fenceLineIdx.
 * Returns the body between fences, optional lang token, optional returns schema when the closing
 * line uses ``` returns "…", and next line index after the closing line.
 */
export function parseFencedBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; lang?: string; nextIdx: number; returns?: string } {
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
      const closing = parseClosingFenceLine(filePath, i + 1, trimmed);
      return {
        body: dedentCommonLeadingWhitespace(bodyLines.join("\n")),
        ...(lang ? { lang } : {}),
        ...(closing.kind === "with_returns" ? { returns: closing.returns } : {}),
        nextIdx: i + 1,
      };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, "unterminated fenced block: no closing ``` before end of file", lineNo);
}
