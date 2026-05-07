import { fail, parseParenArgs, parseSingleBacktickBody } from "./core";
import { parseFencedBlock } from "./fence";
import { validateScriptBodyNoInterpolation } from "./scripts";

export interface InlineScriptParsed {
  body: string;
  lang?: string;
  args?: string;
  bareIdentifierArgs?: string[];
  nextLineIdx: number;
}

/**
 * Parse an anonymous inline script after `run `.
 * `afterRun` is the remaining text after `run ` and starts with a backtick.
 *
 * Two forms:
 *   1. Single backtick: run `body`(args)
 *   2. Fenced block:    run ```lang\n...\n```(args)
 */
export function parseAnonymousInlineScript(
  filePath: string,
  lines: string[],
  lineIdx: number,
  afterRun: string,
  lineNo: number,
  col: number,
): InlineScriptParsed {
  const t = afterRun.trimStart();

  // Triple backtick (fenced block)
  if (t.startsWith("```")) {
    const fenceLines = [...lines];
    fenceLines[lineIdx] = t;
    const { body, lang, afterClose, nextIdx } = parseFencedBlock(filePath, fenceLines, lineIdx);
    const argsResult = parseParenArgs(afterClose);
    if (!argsResult) {
      fail(
        filePath,
        "anonymous inline script requires argument list after closing fence: ```(args) or ```()",
        nextIdx,
        col,
      );
    }
    if (argsResult.rest.trim()) {
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
      ...(argsResult.bareIdentifierArgs ? { bareIdentifierArgs: argsResult.bareIdentifierArgs } : {}),
      nextLineIdx: nextIdx,
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
    if (argsResult.rest.trim()) {
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
      ...(argsResult.bareIdentifierArgs ? { bareIdentifierArgs: argsResult.bareIdentifierArgs } : {}),
      nextLineIdx: lineIdx + 1,
    };
  }

  fail(filePath, "expected backtick or triple backtick for inline script body", lineNo, col);
}
