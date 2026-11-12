import type { Arg } from "../types";
import { commaArgsToArgList, parseCallRef } from "./core";
import { splitScriptLangPrefix, startsScriptFence } from "./fence";

/**
 * A managed call written as a call argument: `foo(bar(x))` or
 * `foo('echo $1'(x))` / `foo(python3'print(1)'())`. Call arguments are stored
 * as raw literal text (the formatter keeps them as written), so the validator,
 * the script emitter, and the runtime all recognize nested calls with this one
 * function instead of each re-parsing the text its own way.
 */
export type NestedCallArg =
  | { kind: "call"; ref: string; args: Arg[]; rest: string }
  | { kind: "inline_script"; body: string; lang?: string; args: Arg[]; rest: string };

/** Index just past the `)` that closes the `(` at `open`, skipping quoted text; -1 if unbalanced. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = open; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== "\\") inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Recognize a nested managed call at the start of `text` (leading whitespace
 * allowed). Returns null for anything that is not a call — a quoted string, a
 * `${var}`, a bare word — so the caller keeps it as a literal. A one-line
 * inline script only: a fenced `'''` body cannot sit inside an argument list.
 */
export function parseNestedCallArg(text: string): NestedCallArg | null {
  const t = text.trimStart();
  const { lang, rest: afterTag } = splitScriptLangPrefix(t);
  if (afterTag.startsWith("'") && !startsScriptFence(afterTag)) {
    const close = afterTag.indexOf("'", 1);
    if (close === -1 || afterTag[close + 1] !== "(") return null;
    const end = closingParen(afterTag, close + 1);
    if (end === -1) return null;
    return {
      kind: "inline_script",
      body: afterTag.slice(1, close),
      ...(lang ? { lang } : {}),
      args: commaArgsToArgList(afterTag.slice(close + 2, end - 1)),
      rest: afterTag.slice(end),
    };
  }
  if (lang) return null;
  const call = parseCallRef(t);
  if (!call || (call.rest.length > 0 && !/^\s/.test(call.rest))) return null;
  return { kind: "call", ref: call.ref, args: call.args ?? [], rest: call.rest };
}
