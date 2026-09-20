import { dedentCommonLeadingWhitespace } from "./dedent";
import { fail } from "./core";

/** Multiline script / inline-script delimiter. Not a CommonMark fence. */
export const SCRIPT_FENCE = "'''";

/** Removed delimiter. A CommonMark code fence. Always E_PARSE. */
export const REMOVED_SCRIPT_FENCE = "```";

export const REMOVED_SCRIPT_FENCE_MESSAGE =
  "script bodies use triple single quotes: '''...''' (triple backticks are markdown fences)";

export function startsScriptFence(s: string): boolean {
  return s.startsWith(SCRIPT_FENCE);
}

export function startsRemovedScriptFence(s: string): boolean {
  return s.startsWith(REMOVED_SCRIPT_FENCE);
}

/** Removed one-liner delimiter. Always E_PARSE. */
export const REMOVED_SCRIPT_ONELINER = "`";

export const REMOVED_SCRIPT_ONELINER_MESSAGE =
  "script one-liners use single quotes: '...' (backticks are removed)";

export function startsRemovedOnelineBacktick(s: string): boolean {
  return s.startsWith(REMOVED_SCRIPT_ONELINER);
}

/** One-line `'…'` or fenced `'''…'''`. Backticks still match so the parser can reject them. */
export function startsInlineScript(s: string): boolean {
  return s.startsWith("'") || s.startsWith(REMOVED_SCRIPT_ONELINER);
}

export function rejectRemovedOnelineBacktick(
  filePath: string,
  s: string,
  lineNo: number,
  col?: number,
): void {
  if (startsRemovedOnelineBacktick(s)) {
    fail(filePath, REMOVED_SCRIPT_ONELINER_MESSAGE, lineNo, col);
  }
}

export function rejectRemovedScriptFence(
  filePath: string,
  s: string,
  lineNo: number,
  col?: number,
): void {
  if (startsRemovedScriptFence(s)) {
    fail(filePath, REMOVED_SCRIPT_FENCE_MESSAGE, lineNo, col);
  }
}

/**
 * Parse a fenced block (''' ... ''') starting at fenceLineIdx.
 * Returns the body between fences, optional lang token, the trailing text on
 * the closing fence line (after the closing ''', callers parse this for
 * (args) / returns "…" / etc.), and the next line index.
 */
export function parseFencedBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; lang?: string; afterClose: string; nextIdx: number } {
  const lineNo = fenceLineIdx + 1;
  const openLine = lines[fenceLineIdx].trim();

  rejectRemovedScriptFence(filePath, openLine, lineNo);

  // Parse opening fence: must be ''' or '''lang (single token, nothing else)
  if (!openLine.startsWith(SCRIPT_FENCE)) {
    fail(filePath, `expected opening fence ${SCRIPT_FENCE}`, lineNo);
  }
  const afterQuotes = openLine.slice(SCRIPT_FENCE.length);
  let lang: string | undefined;
  if (afterQuotes.length > 0) {
    if (/\s/.test(afterQuotes)) {
      fail(filePath, `invalid opening fence: only a single lang token is allowed after ${SCRIPT_FENCE}`, lineNo);
    }
    lang = afterQuotes;
  }

  // Collect body lines until closing fence
  const bodyLines: string[] = [];
  let i = fenceLineIdx + 1;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(SCRIPT_FENCE)) {
      return {
        body: bodyLines.join("\n"),
        ...(lang ? { lang } : {}),
        afterClose: trimmed.slice(SCRIPT_FENCE.length),
        nextIdx: i + 1,
      };
    }
    bodyLines.push(lines[i]);
  }

  fail(filePath, `unterminated fenced block: no closing ${SCRIPT_FENCE} before end of file`, lineNo);
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
