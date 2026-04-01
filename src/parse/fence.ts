import { fail } from "./core";

/**
 * Parse a fenced block (``` ... ```) starting at fenceLineIdx.
 * Returns the body between fences, optional lang token, and next line index after closing fence.
 */
export function parseFencedBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; lang?: string; nextIdx: number } {
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
      // Closing fence: must be exactly ```
      if (trimmed !== "```") {
        fail(filePath, "closing fence must be exactly ``` with no other content", i + 1);
      }
      return {
        body: bodyLines.join("\n"),
        ...(lang ? { lang } : {}),
        nextIdx: i + 1,
      };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, "unterminated fenced block: no closing ``` before end of file", lineNo);
}
