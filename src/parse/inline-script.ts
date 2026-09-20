import { fail, parseParenArgs, parseSingleQuoteScriptBody } from "./core";
import {
  parseFencedScriptBlock,
  rejectRemovedOnelineBacktick,
  rejectRemovedScriptFence,
  SCRIPT_FENCE,
  startsScriptFence,
} from "./fence";
import { validateScriptBodyNoInterpolation } from "./scripts";
import type { Arg } from "../types";

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
}

/**
 * Parse an anonymous inline script.
 * `afterRun` is the remaining text and starts with `'` or a removed backtick.
 *
 * Two forms:
 *   1. One-liner:  'body'(args)
 *   2. Fenced:     '''lang\n...\n'''(args)
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
  const t = afterRun.trimStart();

  rejectRemovedScriptFence(filePath, t, lineNo, col);
  rejectRemovedOnelineBacktick(filePath, t, lineNo, col);

  // Triple single-quote (fenced block)
  if (startsScriptFence(t)) {
    const fenceLines = [...lines];
    fenceLines[lineIdx] = t;
    const { body, lang, afterClose, nextIdx } = parseFencedScriptBlock(filePath, fenceLines, lineIdx);
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
    if (lang && body.trimStart().startsWith("#!")) {
      fail(
        filePath,
        `fence tag "${lang}" already sets the shebang — remove the manual "#!" line`,
        lineNo,
        col,
      );
    }
    return {
      body,
      ...(lang ? { lang } : {}),
      args: argsResult.args,
      nextLineIdx: nextIdx,
      closingLineIdx: nextIdx - 1,
      trailing: argsResult.rest,
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

    return {
      body,
      args: argsResult.args,
      nextLineIdx: lineIdx + 1,
      closingLineIdx: lineIdx,
      trailing: argsResult.rest,
    };
  }

  fail(filePath, `expected '...' or ${SCRIPT_FENCE} for inline script body`, lineNo, col);
}
