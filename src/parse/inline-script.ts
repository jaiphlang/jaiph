import { fail, parseParenArgs } from "./core";
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
    const afterOpening = t.slice(3);
    let lang: string | undefined;
    if (afterOpening.length > 0) {
      if (/\s/.test(afterOpening)) {
        fail(filePath, "invalid opening fence: only a single lang token is allowed after ```", lineNo, col);
      }
      lang = afterOpening;
    }

    // Collect body lines until closing ```
    const bodyLines: string[] = [];
    let i = lineIdx + 1;
    for (; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("```")) {
        // Closing line — extract (args) after ```
        const afterClose = trimmed.slice(3);
        const argsResult = parseParenArgs(afterClose);
        if (!argsResult) {
          fail(
            filePath,
            "anonymous inline script requires argument list after closing fence: ```(args) or ```()",
            i + 1,
            col,
          );
        }
        if (argsResult.rest.trim()) {
          fail(
            filePath,
            `unexpected content after anonymous inline script: '${argsResult.rest.trim()}'`,
            i + 1,
            col,
          );
        }

        const body = bodyLines.join("\n");

        // Check for both fence tag and manual shebang
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
          nextLineIdx: i + 1,
        };
      }
      bodyLines.push(lines[i]);
    }
    fail(filePath, "unterminated fenced block: no closing ``` before end of file", lineNo, col);
  }

  // Single backtick (inline, one line)
  if (t.startsWith("`")) {
    const closeIdx = t.indexOf("`", 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated inline script backtick — missing closing `", lineNo, col);
    }
    const body = t.slice(1, closeIdx);
    if (body.includes("\n")) {
      fail(filePath, "single backtick script body must be one line — use triple backtick for multiline", lineNo, col);
    }

    const afterClose = t.slice(closeIdx + 1);
    const argsResult = parseParenArgs(afterClose);
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
