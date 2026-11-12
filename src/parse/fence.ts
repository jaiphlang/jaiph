import { dedentCommonLeadingWhitespace } from "./dedent";
import { fail } from "./core";

/** Multiline script / inline-script delimiter. Not a CommonMark fence. */
export const SCRIPT_FENCE = "'''";

/** Removed delimiter. A CommonMark code fence. Always E_PARSE. */
const REMOVED_SCRIPT_FENCE = "```";

export const REMOVED_SCRIPT_FENCE_MESSAGE =
  "script bodies use triple single quotes: '''...''' (triple backticks are markdown fences)";

export function startsScriptFence(s: string): boolean {
  return s.startsWith(SCRIPT_FENCE);
}

function startsRemovedScriptFence(s: string): boolean {
  return s.startsWith(REMOVED_SCRIPT_FENCE);
}

/** Removed one-liner delimiter. Always E_PARSE. */
const REMOVED_SCRIPT_ONELINER = "`";

export const REMOVED_SCRIPT_ONELINER_MESSAGE =
  "script one-liners use single quotes: '...' (backticks are removed)";

function startsRemovedOnelineBacktick(s: string): boolean {
  return s.startsWith(REMOVED_SCRIPT_ONELINER);
}

/**
 * Interpreter tag written directly before the opening quote: `python3'…'`,
 * `node'''…'''`. Any identifier-like token is accepted (no allowlist); it maps
 * to `#!/usr/bin/env <tag>`. No whitespace between tag and quote.
 */
const LANG_TAG_SRC = "[A-Za-z_][A-Za-z0-9_.-]*";
const LANG_TAG_RE = new RegExp(`^${LANG_TAG_SRC}$`);

/** Removed form: the tag after the opening fence (`'''python3`). Always E_PARSE. */
function removedFenceTagMessage(tag: string): string {
  return `interpreter tags go before the opening quotes: ${tag}${SCRIPT_FENCE}...${SCRIPT_FENCE} (not ${SCRIPT_FENCE}${tag})`;
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

export const UNTERMINATED_FENCE_MESSAGE = `unterminated fenced block: no closing ${SCRIPT_FENCE} before end of file`;

/**
 * Check a fenced block's opening line (trimmed): exactly `'''`, with any
 * interpreter tag already split off.
 */
export function checkFenceOpener(filePath: string, openLine: string, lineNo: number): void {
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
}

/** Remove the block's common leading margin so indented `.jh` script bodies run correctly. */
export function dedentFencedScriptBody(body: string): string {
  return dedentCommonLeadingWhitespace(body);
}
