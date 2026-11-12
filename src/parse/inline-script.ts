import { fail, parseParenArgs, parseSingleQuoteScriptBody } from "./core";
import {
  parseFencedScriptBlock,
  rejectRemovedOnelineBacktick,
  rejectRemovedScriptFence,
  rejectTagWithShebang,
  SCRIPT_FENCE,
  splitScriptLangPrefix,
  startsScriptFence,
} from "./fence";
import { validateScriptBodyNoInterpolation } from "./scripts";
import type { Arg } from "../types";

export { startsInlineScript } from "./fence";

export interface InlineScriptParsed {
  body: string;
  lang?: string;
  args?: Arg[];
  /** Next line to resume parsing at — the line just after the inline script. */
  nextLineIdx: number;
  /** Source line index containing the closing `)`. */
  closingLineIdx: number;
  /** Trailing text after the closing `)` on the closing line (verbatim). */
  trailing: string;
  /** Source used the fenced `'''…'''` form (the formatter keeps it). */
  fenced: boolean;
}

/**
 * Parse an anonymous inline script.
 * `afterRun` is the remaining text and starts with `'` or a removed backtick.
 *
 * Two forms, each with an optional interpreter tag before the opening quote:
 *   1. One-liner:  'body'(args)            / python3'body'(args)
 *   2. Fenced:     '''\n...\n'''(args)     / python3'''\n...\n'''(args)
 *
 * When `allowTrailing` is true the caller is responsible for handling any
 * non-empty `trailing` text (e.g. `catch (...) { ... }`). When false (default)
 * non-empty trailing content is rejected with the existing parse error.
 */
export function parseAnonymousInlineScript(
  filePath: string,
  lines: string[],
  lineIdx: number,
  afterRun: string,
  lineNo: number,
  col: number,
  allowTrailing = false,
): InlineScriptParsed {
  const trimmed = afterRun.trimStart();

  rejectRemovedScriptFence(filePath, trimmed, lineNo, col);
  rejectRemovedOnelineBacktick(filePath, trimmed, lineNo, col);

  // Optional interpreter tag directly before the opening quote: python3'…' / node'''…'''
  const { lang, rest: t } = splitScriptLangPrefix(trimmed);

  // Triple single-quote (fenced block)
  if (startsScriptFence(t)) {
    const fenceLines = [...lines];
    fenceLines[lineIdx] = t;
    const { body, afterClose, nextIdx } = parseFencedScriptBlock(filePath, fenceLines, lineIdx);
    const argsResult = parseParenArgs(afterClose);
    if (!argsResult) {
      fail(
        filePath,
        `anonymous inline script requires argument list after closing fence: ${SCRIPT_FENCE}(args) or ${SCRIPT_FENCE}()`,
        nextIdx,
        col,
      );
    }
    if (!allowTrailing && argsResult.rest.trim()) {
      fail(
        filePath,
        `unexpected content after anonymous inline script: '${argsResult.rest.trim()}'`,
        nextIdx,
        col,
      );
    }
    rejectTagWithShebang(filePath, lang, body, lineNo, col);
    return {
      body,
      ...(lang ? { lang } : {}),
      args: argsResult.args,
      nextLineIdx: nextIdx,
      closingLineIdx: nextIdx - 1,
      trailing: argsResult.rest,
      fenced: true,
    };
  }

  // One-line single-quote script
  if (t.startsWith("'")) {
    const { body, restAfterClose } = parseSingleQuoteScriptBody(t, filePath, lineNo, col);
    const argsResult = parseParenArgs(restAfterClose);
    if (!argsResult) {
      fail(
        filePath,
        "anonymous inline script requires argument list after closing quote: 'body'(args) or 'body'()",
        lineNo,
        col,
      );
    }
    if (!allowTrailing && argsResult.rest.trim()) {
      fail(
        filePath,
        `unexpected content after anonymous inline script: '${argsResult.rest.trim()}'`,
        lineNo,
        col,
      );
    }

    validateScriptBodyNoInterpolation(body, filePath, lineNo, col);
    rejectTagWithShebang(filePath, lang, body, lineNo, col);

    return {
      body,
      ...(lang ? { lang } : {}),
      args: argsResult.args,
      nextLineIdx: lineIdx + 1,
      closingLineIdx: lineIdx,
      trailing: argsResult.rest,
      fenced: false,
    };
  }

  fail(
    filePath,
    lang
      ? `expected ' or ${SCRIPT_FENCE} directly after interpreter tag "${lang}"`
      : `expected '...' or ${SCRIPT_FENCE} for inline script body`,
    lineNo,
    col,
  );
}
