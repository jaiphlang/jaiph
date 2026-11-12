import { fail } from "./core";
import { parseParenArgs } from "./call-args";
import {
  rejectRemovedOnelineBacktick,
  rejectRemovedScriptFence,
  rejectTagWithShebang,
  SCRIPT_FENCE,
  startsScriptFence,
} from "./fence";
import { SliceLexer } from "./slice-lexer";
import type { BodyCursor } from "./body-cursor";

export { startsScript } from "./slice-lexer";
import { readFencedScript } from "./triple-quote";
import { validateScriptBodyNoInterpolation } from "./scripts";
import type { Arg } from "../types";

export interface InlineScriptParsed {
  body: string;
  lang?: string;
  args?: Arg[];
  /** Position to resume parsing at — the line just after the inline script. */
  next: number;
  /** Position of the line holding the closing `)`. */
  closingAt: number;
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
  cursor: BodyCursor,
  at: number,
  afterRun: string,
  lineNo: number,
  col: number,
  allowTrailing = false,
): InlineScriptParsed {
  const filePath = cursor.filePath;
  const trimmed = afterRun.trimStart();

  rejectRemovedScriptFence(filePath, trimmed, lineNo, col);
  rejectRemovedOnelineBacktick(filePath, trimmed, lineNo, col);

  // The opening token: a one-line `'…'` script, or (a lexer stop) a `'''`
  // block opener or an unterminated `'`; an interpreter tag touching the
  // quote is part of it: python3'…' / node'''…'''.
  const head = new SliceLexer(filePath, trimmed, lineNo, col, 0).at(0, { triple: "span" });
  const quote = head?.text.indexOf("'") ?? -1;
  const tag = quote > 0 ? head!.text.slice(0, quote) : "";
  const lang = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(tag) ? tag : undefined;
  const t = trimmed.slice(lang?.length ?? 0);

  // Triple single-quote (fenced block)
  if (startsScriptFence(t)) {
    const { body, afterClose, closeAt, closeLine, next } = readFencedScript(cursor, at, t);
    const argsResult = parseParenArgs(afterClose);
    if (!argsResult) {
      fail(
        filePath,
        `anonymous inline script requires argument list after closing fence: ${SCRIPT_FENCE}(args) or ${SCRIPT_FENCE}()`,
        closeLine,
        col,
      );
    }
    if (!allowTrailing && argsResult.rest.trim()) {
      fail(
        filePath,
        `unexpected content after anonymous inline script: '${argsResult.rest.trim()}'`,
        closeLine,
        col,
      );
    }
    rejectTagWithShebang(filePath, lang, body, lineNo, col);
    return {
      body,
      ...(lang ? { lang } : {}),
      args: argsResult.args,
      next,
      closingAt: closeAt,
      trailing: argsResult.rest,
      fenced: true,
    };
  }

  // One-line single-quote script
  if (t.startsWith("'")) {
    if (head!.kind !== "script_oneline") {
      fail(filePath, "unterminated one-line script — missing closing '", lineNo, col);
    }
    const body = head!.text.slice(quote + 1, -1);
    const argsResult = parseParenArgs(trimmed.slice(head!.text.length));
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
      next: cursor.next(at),
      closingAt: at,
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
