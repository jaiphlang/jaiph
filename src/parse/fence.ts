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

/**
 * Interpreter tag written directly before the opening quote: `python3'…'`,
 * `node'''…'''`. Any identifier-like token is accepted (no allowlist); it maps
 * to `#!/usr/bin/env <tag>`. No whitespace between tag and quote.
 */
const LANG_TAG_SRC = "[A-Za-z_][A-Za-z0-9_.-]*";
const LANG_PREFIX_RE = new RegExp(`^(${LANG_TAG_SRC})(?=')`);
const LANG_TAG_RE = new RegExp(`^${LANG_TAG_SRC}$`);

/** Split an optional interpreter-tag prefix off a script body opener. */
export function splitScriptLangPrefix(s: string): { lang?: string; rest: string } {
  const m = LANG_PREFIX_RE.exec(s);
  if (!m) return { rest: s };
  return { lang: m[1], rest: s.slice(m[1].length) };
}

/** Removed form: the tag after the opening fence (`'''python3`). Always E_PARSE. */
export function removedFenceTagMessage(tag: string): string {
  return `interpreter tags go before the opening quotes: ${tag}${SCRIPT_FENCE}...${SCRIPT_FENCE} (not ${SCRIPT_FENCE}${tag})`;
}

/** Fenced `'''…'''`, with or without an interpreter-tag prefix. */
export function startsTaggedScriptFence(s: string): boolean {
  return startsScriptFence(splitScriptLangPrefix(s).rest);
}

/**
 * One-line `'…'` or fenced `'''…'''`, optionally prefixed by an interpreter tag
 * (`python3'…'`). Backticks still match so the parser can reject them.
 */
export function startsInlineScript(s: string): boolean {
  return s.startsWith("'") || s.startsWith(REMOVED_SCRIPT_ONELINER) || LANG_PREFIX_RE.test(s);
}

/**
 * Reject a manual `#!` line when an interpreter tag already sets the shebang.
 */
export function rejectTagWithShebang(
  filePath: string,
  lang: string | undefined,
  body: string,
  lineNo: number,
  col?: number,
): void {
  if (lang && body.trimStart().startsWith("#!")) {
    fail(
      filePath,
      `interpreter tag "${lang}" already sets the shebang — remove the manual "#!" line`,
      lineNo,
      col,
    );
  }
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
 * Parse a fenced block (''' ... ''') starting at fenceLineIdx. The opening line
 * must be exactly ''' — callers split any interpreter tag off first
 * (`python3'''`). Returns the body between fences, the trailing text on the
 * closing fence line (after the closing ''', callers parse this for (args) /
 * returns "…" / etc.), and the next line index.
 */
export function parseFencedBlock(
  filePath: string,
  lines: string[],
  fenceLineIdx: number,
): { body: string; afterClose: string; nextIdx: number } {
  const lineNo = fenceLineIdx + 1;
  const openLine = lines[fenceLineIdx].trim();

  rejectRemovedScriptFence(filePath, openLine, lineNo);

  if (!openLine.startsWith(SCRIPT_FENCE)) {
    fail(filePath, `expected opening fence ${SCRIPT_FENCE}`, lineNo);
  }
  const afterQuotes = openLine.slice(SCRIPT_FENCE.length);
  if (afterQuotes.length > 0) {
    if (LANG_TAG_RE.test(afterQuotes)) {
      fail(filePath, removedFenceTagMessage(afterQuotes), lineNo);
    }
    fail(filePath, `invalid opening fence: nothing may follow ${SCRIPT_FENCE} on the opening line`, lineNo);
  }

  // Collect body lines until closing fence
  const bodyLines: string[] = [];
  let i = fenceLineIdx + 1;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(SCRIPT_FENCE)) {
      return {
        body: bodyLines.join("\n"),
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
): { body: string; afterClose: string; nextIdx: number } {
  const parsed = parseFencedBlock(filePath, lines, fenceLineIdx);
  return { ...parsed, body: dedentFencedScriptBody(parsed.body) };
}
