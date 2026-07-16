import { fail, parseParenArgs, parseSingleBacktickBody } from "./core";
import { parseFencedScriptBlock } from "./fence";
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
 * Parse an anonymous inline script after `run `.
 * `afterRun` is the remaining text after `run ` and starts with a backtick.
 *
 * Two forms:
 *   1. Single backtick: run `body`(args)
 *   2. Fenced block:    run ```lang\n...\n```(args)
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

  // Triple backtick (fenced block)
  if (t.startsWith("```")) {
    const fenceLines = [...lines];
    fenceLines[lineIdx] = t;
    const { body, lang, afterClose, nextIdx } = parseFencedScriptBlock(filePath, fenceLines, lineIdx);
    const argsResult = parseParenArgs(afterClose);
    if (!argsResult) {
      fail(
        filePath,
        "anonymous inline script requires argument list after closing fence: ```(args) or ```()",
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

  // Single backtick (inline, one line)
  if (t.startsWith("`")) {
    const { body, restAfterClose } = parseSingleBacktickBody(t, filePath, lineNo, col);
    const argsResult = parseParenArgs(restAfterClose);
    if (!argsResult) {
      fail(
        filePath,
        "anonymous inline script requires argument list after closing backtick: `body`(args) or `body`()",
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

  fail(filePath, "expected backtick or triple backtick for inline script body", lineNo, col);
}
