import type { Arg } from "../types";
import { fail, isBareDottedIdentifier, isBareIdentifier, isRef } from "./core";
import { lex, type Token } from "./lexer";
import type { BodyCursor } from "./body-cursor";
import { blockBody, dedentTripleQuotedBody, tripleQuoteBodyToRaw } from "./triple-quote";

/** Thrown when an argument list reaches end of input before its closing `)`. */
class UnterminatedArgList extends Error {}

const CALL_HEAD_RE = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(/;

/**
 * The stored form of a `"""` argument: the lines between the opener and the
 * closer, blank lines next to either trimmed, dedented to the common margin,
 * and encoded with `tripleQuoteBodyToRaw` (decoded by `literalText`).
 */
function tripleStringRaw(tok: Token): string {
  return tripleQuoteBodyToRaw(dedentTripleQuotedBody(blockBody(tok)));
}

/** One argument from its tokens: a bare (dotted) identifier is a variable, anything else a literal. */
function argFromTokens(filePath: string, source: string, toks: Token[], out: Arg[]): void {
  if (toks.length === 0) return;
  const triple = toks.findIndex((t) => t.kind === "triple_string");
  if (triple !== -1) {
    if (triple > 0) fail(filePath, "unexpected content before triple-quoted call argument", toks[triple]!.line);
    if (toks.length > 1) fail(filePath, 'unexpected content after closing """', toks[1]!.line, toks[1]!.col);
    out.push({ kind: "literal", raw: tripleStringRaw(toks[0]!) });
    return;
  }
  const last = toks[toks.length - 1]!;
  const text = source.slice(toks[0]!.offset, last.offset + last.text.length);
  if (isBareIdentifier(text) || isBareDottedIdentifier(text)) {
    out.push({ kind: "var", name: text });
    return;
  }
  out.push({ kind: "literal", raw: text });
}

/**
 * Parse a call's argument list from tokens. `start` is the offset just after
 * the opening `(` in `source`; the list ends at the matching `)`. Arguments are
 * split on top-level commas; each keeps its source text (a quoted string keeps
 * its quotes and `\"` escapes, the shared stored form) except a `"""` block,
 * which is stored dedented in the same form. Nested calls and inline scripts
 * (`foo(bar(x))`, `foo('echo $1'(x))`) stay one argument.
 *
 * Returns the arguments and the offset just past the closing `)`. Throws
 * `UnterminatedArgList` when the input ends first; lexer errors (an
 * unterminated string or block) propagate as `E_PARSE`.
 */
function parseCallArgs(source: string, start: number, filePath: string): { args: Arg[]; end: number } {
  const args: Arg[] = [];
  let current: Token[] = [];
  let depth = 1;
  for (const tok of lex(source, filePath, { lenient: true, start })) {
    if (tok.kind === "newline") continue;
    if (tok.kind === "punct" && tok.text === "(") depth += 1;
    if (tok.kind === "punct" && tok.text === ")") {
      depth -= 1;
      if (depth === 0) {
        argFromTokens(filePath, source, current, args);
        return { args, end: tok.offset + 1 };
      }
    }
    if (tok.kind === "punct" && tok.text === "," && depth === 1) {
      argFromTokens(filePath, source, current, args);
      current = [];
      continue;
    }
    current.push(tok);
  }
  throw new UnterminatedArgList();
}

/**
 * Parse `ref(args)` at the start of `s` (leading whitespace allowed) on one
 * line. Returns null when `s` does not start with a call, or the call does not
 * close within `s` (an unterminated string or `"""` counts as not closing).
 */
export function parseCallRef(s: string): { ref: string; args?: Arg[]; rest: string } | null {
  const t = s.trimStart();
  const head = t.match(CALL_HEAD_RE);
  if (!head || !isRef(head[1]!)) return null;
  let parsed: { args: Arg[]; end: number };
  try {
    parsed = parseCallArgs(t, head[0].length, "<call>");
  } catch {
    return null;
  }
  return { ref: head[1]!, ...(parsed.args.length > 0 ? { args: parsed.args } : {}), rest: t.slice(parsed.end) };
}

/**
 * Parse a parenthesized argument list `(args)` / `()` at the start of a string.
 * Returns typed `Arg[]` and the text after `)`, or null if the string does not
 * start with a `(` that closes.
 */
export function parseParenArgs(s: string): { args?: Arg[]; rest: string } | null {
  const t = s.trimStart();
  if (!t.startsWith("(")) return null;
  try {
    const { args, end } = parseCallArgs(t, 1, "<call>");
    return { ...(args.length > 0 ? { args } : {}), rest: t.slice(end) };
  } catch {
    return null;
  }
}

/**
 * Collect call arguments for a managed call whose `(` is on the line at `at`
 * and may span multiple source lines. `textAfterOpenParen` is the text on the
 * opening line after `(`. Returns the arguments, the text after `)` on its
 * line, and the position after that line. A `"""` argument may open on the call line
 * (`foo("""`) or on its own line, and is stored dedented to the common margin.
 *
 * Fails with `E_PARSE` when the matching `)` is missing before end of file, a
 * string or `"""` block does not close, or other text shares an argument with
 * a `"""` block.
 */
export function parseMultilineCallArgList(
  cursor: BodyCursor,
  at: number,
  textAfterOpenParen: string,
): { args: Arg[]; next: number; rest: string } {
  const { source, filePath } = cursor;
  const start = at + cursor.text(at).length - textAfterOpenParen.length;
  let parsed: { args: Arg[]; end: number };
  try {
    parsed = parseCallArgs(source, start, filePath);
  } catch (err) {
    if (err instanceof UnterminatedArgList) {
      fail(filePath, 'unterminated multiline call — missing closing ")"', cursor.lineNo(at));
    }
    throw err;
  }
  const closeAt = cursor.lineStartAt(parsed.end - 1);
  const rest = source.slice(parsed.end, closeAt + cursor.text(closeAt).length);
  return { args: parsed.args, next: cursor.next(closeAt), rest };
}

/**
 * Parse a call reference `ref(args)` that may span multiple source lines.
 *
 * Single-line calls are handled via `parseCallRef` (fast path).
 * When `(` is not closed on the line at `at`, subsequent lines are consumed via
 * `parseMultilineCallArgList` until the matching `)` is found.
 *
 * Returns `null` when `s` does not start with a valid `ref(` pattern (e.g., bare
 * identifier with no `(`). Calls `fail()` (E_PARSE) when `s` starts with `ref(` but
 * the call cannot be completed — this is the guard against incomplete managed-call
 * forms silently becoming shell steps.
 */
export function parseCallRefMultiline(
  cursor: BodyCursor,
  at: number,
  s: string,
): { ref: string; args?: Arg[]; rest: string; next: number } | null {
  const t = s.trimStart();

  const singleLine = parseCallRef(t);
  if (singleLine) {
    return {
      ref: singleLine.ref,
      ...(singleLine.args ? { args: singleLine.args } : {}),
      rest: singleLine.rest,
      next: cursor.next(at),
    };
  }

  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\((.*)/s);
  if (!m || !isRef(m[1]!)) return null;

  const ref = m[1]!;
  const { args, next, rest } = parseMultilineCallArgList(cursor, at, m[2]!);
  return { ref, ...(args.length > 0 ? { args } : {}), rest, next };
}

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

/**
 * Recognize a nested managed call at the start of `text` (leading whitespace
 * allowed). Returns null for anything that is not a call — a quoted string, a
 * `${var}`, a bare word — so the caller keeps it as a literal. A one-line
 * inline script only: a fenced `'''` body cannot sit inside an argument list.
 */
export function parseNestedCallArg(text: string): NestedCallArg | null {
  const t = text.trimStart();
  let first: Token | undefined;
  let second: Token | undefined;
  try {
    const it = lex(t, "<arg>", { lenient: true });
    first = it.next().value as Token | undefined;
    if (first?.kind === "script_oneline") second = it.next().value as Token | undefined;
  } catch {
    return null;
  }
  if (first?.kind === "script_oneline") {
    if (second?.kind !== "punct" || second.text !== "(" || second.offset !== first.text.length) return null;
    const quote = first.text.indexOf("'");
    let parsed: { args: Arg[]; end: number };
    try {
      parsed = parseCallArgs(t, second.offset + 1, "<arg>");
    } catch {
      return null;
    }
    return {
      kind: "inline_script",
      body: first.text.slice(quote + 1, -1),
      ...(quote > 0 ? { lang: first.text.slice(0, quote) } : {}),
      args: parsed.args,
      rest: t.slice(parsed.end),
    };
  }
  const call = parseCallRef(t);
  if (!call || (call.rest.length > 0 && !/^\s/.test(call.rest))) return null;
  return { kind: "call", ref: call.ref, args: call.args ?? [], rest: call.rest };
}
