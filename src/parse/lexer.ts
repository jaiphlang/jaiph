// Standalone tokenizer for `.jh` source. Not used by the parser yet: later
// tasks move the line-based parser onto these tokens.
//
// Lossless: every source character belongs to exactly one token, except spaces,
// tabs and carriage returns between tokens. Each token's `text` is the exact
// source slice, so joining tokens and the skipped whitespace reproduces the
// source.

import { fail } from "./core";
import { REMOVED_SCRIPT_FENCE_MESSAGE, REMOVED_SCRIPT_ONELINER_MESSAGE } from "./fence";

export type TokenKind =
  | "ident"
  | "string"
  | "triple_string"
  | "script_oneline"
  | "script_fenced"
  | "number"
  | "regex"
  | "punct"
  | "raw_body"
  | "newline"
  | "comment"
  /** A character no other kind accepts; produced only with `{ lenient: true }`. */
  | "other";

export interface Token {
  kind: TokenKind;
  /** Exact source slice. */
  text: string;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** 0-based index of the first character in the source. */
  offset: number;
}

export interface LexOptions {
  /**
   * Emit a one-character `other` token for a character no other kind accepts
   * (and for `/` outside a regex position, and `#`, which is argument text
   * there, not a comment) instead of failing. Call-argument
   * text uses this: arguments keep their source text, and the validator owns
   * the errors for stray characters in them (shell redirection and the like).
   */
  lenient?: boolean;
  /**
   * Start lexing at this offset. Line, column and offset stay relative to the
   * whole `source`, so errors point at the real file position.
   */
  start?: number;
}

/** Longest first, so `=>` wins over `=` and `${` over `$`. */
const PUNCTS = ["=>", "->", "==", "!=", "=~", "!~", "${", "(", ")", "{", "}", ",", "=", ".", "|", ";", "$"];

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const TAG_CHAR = /[A-Za-z0-9_.-]/;
const DIGIT = /[0-9]/;

/** Brace context: a `match … {` block, a `${` interpolation, or any other `{`. */
type BraceKind = "match" | "interp" | "plain";

export function tokenize(source: string, filePath: string, options: LexOptions = {}): Token[] {
  return [...lex(source, filePath, options)];
}

/**
 * Pull tokens one at a time. A caller that stops early (a call-argument list
 * that ends at its `)`) never scans, or fails on, the text after it.
 */
export function* lex(source: string, filePath: string, options: LexOptions = {}): Generator<Token> {
  const tokens: Token[] = [];
  let emitted = 0;
  const braces: BraceKind[] = [];
  let pos = options.start ?? 0;
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }

  const col = (at: number): number => at - lineStart + 1;
  const lineEnd = (from: number): number => {
    const nl = source.indexOf("\n", from);
    return nl === -1 ? source.length : nl;
  };
  /** Push a token spanning `[start, end)`; advance line bookkeeping past it. */
  const push = (kind: TokenKind, start: number, end: number, startLine: number, startCol: number): void => {
    const text = source.slice(start, end);
    tokens.push({ kind, text, line: startLine, col: startCol, offset: start });
    for (let i = start; i < end; i += 1) {
      if (source[i] === "\n") {
        line += 1;
        lineStart = i + 1;
      }
    }
    pos = end;
  };

  /** Previous significant token (not a comment). */
  const prev = (): Token | undefined => {
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (tokens[i]!.kind !== "comment") return tokens[i];
    }
    return undefined;
  };

  /**
   * A `/` starts a regex in match-pattern position (first token of an arm in a
   * `match` block, or after the pattern-alternation bar) and as the right-hand
   * operand of `=~` / `!~`.
   */
  const regexAllowed = (): boolean => {
    const p = prev();
    if (!p) return false;
    if (p.kind === "punct" && (p.text === "=~" || p.text === "!~")) return true;
    if (braces[braces.length - 1] !== "match") return false;
    return p.kind === "newline" || (p.kind === "punct" && ["{", ",", ";", "|"].includes(p.text));
  };

  /**
   * `match subject {`, `match a.b {`, or `mock prompt {` (arms with the same
   * pattern grammar): the tokens before this `{`.
   */
  const opensMatch = (): boolean => {
    const sig = tokens.filter((t) => t.kind !== "comment");
    const n = sig.length;
    const isMatch = (t: Token | undefined): boolean => t?.kind === "ident" && t.text === "match";
    if (sig[n - 2]?.text === "mock" && sig[n - 1]?.text === "prompt") return true;
    if (isMatch(sig[n - 2]) && sig[n - 1]?.kind === "ident") return true;
    return (
      isMatch(sig[n - 4]) &&
      sig[n - 3]?.kind === "ident" &&
      sig[n - 2]?.text === "." &&
      sig[n - 1]?.kind === "ident"
    );
  };

  /**
   * `"""` or `'''` block starting at `open`: the token runs through the first
   * later line whose trimmed text starts with the same three quotes. The
   * opening quotes end their line.
   */
  const scanBlock = (start: number, open: number, quote: string, what: string): number => {
    const startLine = line;
    const startCol = col(start);
    const afterOpen = open + 3;
    const firstLineEnd = lineEnd(afterOpen);
    if (source.slice(afterOpen, firstLineEnd).trim() !== "") {
      fail(filePath, `opening ${quote} must end its line`, startLine, col(afterOpen));
    }
    let cursor = firstLineEnd;
    while (cursor < source.length) {
      const lineFrom = cursor + 1;
      const end = lineEnd(lineFrom);
      const text = source.slice(lineFrom, end);
      const indent = text.length - text.trimStart().length;
      if (text.trimStart().startsWith(quote)) return lineFrom + indent + 3;
      cursor = end;
    }
    fail(filePath, `unterminated ${what}: no closing ${quote}`, startLine, startCol);
  };

  /** Set by `mock script ref(…) {`: the following lines are a raw shell body. */
  let rawBodyPending = false;
  const MOCK_SCRIPT_OPENER = /^\s*mock\s+script\s.*\)\s*\{\s*$/;

  /**
   * Raw body after a `mock script … {` line: every line up to the first line
   * whose trimmed text is `}`. The token runs from the start of the first body
   * line to the start of the closing line (newlines included).
   */
  const scanRawBody = (from: number): number => {
    let cursor = from;
    while (cursor < source.length) {
      const end = lineEnd(cursor);
      if (source.slice(cursor, end).trim() === "}") return cursor;
      cursor = end + 1;
    }
    fail(filePath, "unterminated mock block", line, 1);
  };

  while (pos < source.length) {
    while (emitted < tokens.length) yield tokens[emitted++]!;
    const ch = source[pos]!;
    const startLine = line;
    const startCol = col(pos);

    if (ch === " " || ch === "\t" || ch === "\r") {
      pos += 1;
      continue;
    }
    if (ch === "\n") {
      push("newline", pos, pos + 1, startLine, startCol);
      if (rawBodyPending) {
        rawBodyPending = false;
        const end = scanRawBody(pos);
        if (end > pos) push("raw_body", pos, end, line, 1);
      }
      continue;
    }
    if (ch === "\\" && source.slice(pos + 1, lineEnd(pos)).trim() === "") {
      // Line continuation: `prompt "…" \` + newline + `returns "…"`.
      push("punct", pos, pos + 1, startLine, startCol);
      continue;
    }
    if (ch === "#" && !options.lenient) {
      push("comment", pos, lineEnd(pos), startLine, startCol);
      continue;
    }
    if (source.startsWith("```", pos)) {
      fail(filePath, REMOVED_SCRIPT_FENCE_MESSAGE, startLine, startCol);
    }
    if (ch === "`") {
      fail(filePath, REMOVED_SCRIPT_ONELINER_MESSAGE, startLine, startCol);
    }
    if (source.startsWith('"""', pos)) {
      push("triple_string", pos, scanBlock(pos, pos, '"""', 'triple-quoted string'), startLine, startCol);
      continue;
    }
    if (ch === '"') {
      const end = lineEnd(pos);
      let i = pos + 1;
      while (i < end && source[i] !== '"') i += source[i] === "\\" && source[i + 1] === '"' ? 2 : 1;
      if (i >= end) fail(filePath, "unterminated string", startLine, startCol);
      push("string", pos, i + 1, startLine, startCol);
      continue;
    }
    if (IDENT_START.test(ch) || ch === "'") {
      // An interpreter tag touches the opening quote: `python3'…'`, `node.v-2'''`.
      let tagEnd = pos;
      if (ch !== "'") {
        while (tagEnd < source.length && TAG_CHAR.test(source[tagEnd]!)) tagEnd += 1;
      }
      if (source[tagEnd] === "'") {
        if (source.startsWith("'''", tagEnd)) {
          push("script_fenced", pos, scanBlock(pos, tagEnd, "'''", "fenced script"), startLine, startCol);
          continue;
        }
        const close = source.indexOf("'", tagEnd + 1);
        if (close === -1 || close > lineEnd(tagEnd)) {
          fail(filePath, "unterminated one-line script: no closing '", startLine, startCol);
        }
        push("script_oneline", pos, close + 1, startLine, startCol);
        continue;
      }
      let end = pos + 1;
      while (end < source.length && IDENT_CHAR.test(source[end]!)) end += 1;
      push("ident", pos, end, startLine, startCol);
      continue;
    }
    if (DIGIT.test(ch)) {
      let end = pos + 1;
      while (end < source.length && DIGIT.test(source[end]!)) end += 1;
      push("number", pos, end, startLine, startCol);
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      const end = lineEnd(pos);
      let i = pos + 1;
      while (i < end && !(source[i] === "/" && source[i - 1] !== "\\")) i += 1;
      if (i >= end) fail(filePath, "unterminated regex", startLine, startCol);
      push("regex", pos, i + 1, startLine, startCol);
      continue;
    }
    const punct = PUNCTS.find((p) => source.startsWith(p, pos));
    if (punct) {
      if (punct === "{") {
        braces.push(opensMatch() ? "match" : "plain");
        const lineText = source.slice(lineStart, lineEnd(pos));
        if (MOCK_SCRIPT_OPENER.test(lineText)) rawBodyPending = true;
      }
      if (punct === "${") braces.push("interp");
      if (punct === "}") braces.pop();
      push("punct", pos, pos + punct.length, startLine, startCol);
      continue;
    }
    if (options.lenient) {
      push("other", pos, pos + 1, startLine, startCol);
      continue;
    }
    fail(filePath, `unexpected character ${JSON.stringify(ch)}`, startLine, startCol);
  }
  while (emitted < tokens.length) yield tokens[emitted++]!;
}
