// Token reader over one line slice (a match arm, a statement operand). It lexes
// one token at a time, so the caller picks per position whether a `/` opens a
// regex and whether `'` opens a script, and it never fails: where the lexer
// stops, `stop` turns the lexeme into a token the caller can read.

import { lex, type Token } from "./lexer";
import { adjacent, BodyCursor, isPunct } from "./body-cursor";

export type SliceMode = {
  /** A `/` here opens a regex. */
  regex?: boolean;
  /** `false`: `'` is an `other` token (no script tokens). */
  scripts?: boolean;
  /**
   * How a `"""` / `'''` that cannot open a block inside the slice reads:
   * `pair` as an empty `""` / `''` string or script followed by the third
   * quote (two adjacent quoted strings), `span` as one `other` token through
   * the next `"""` in the slice, or to its end.
   */
  triple: "pair" | "span";
};

const SCRIPT_TRIPLE = /^(?:[A-Za-z_][A-Za-z0-9_.-]*)?'''/;

export class SliceLexer {
  /**
   * `text` is a slice of one line (no newline) whose first character sits at
   * line `line`, column `col`, source offset `offset`.
   */
  constructor(
    readonly filePath: string,
    readonly text: string,
    readonly line: number,
    readonly col: number,
    readonly offset: number,
  ) {}

  /** Index in `text` of a token from this slice. */
  rel(tok: Token): number {
    return tok.offset - this.offset;
  }

  /** Index in `text` just past a token from this slice. */
  end(tok: Token): number {
    return tok.offset - this.offset + tok.text.length;
  }

  /** A sub-slice `[from, to)` of this slice. */
  slice(from: number, to: number): SliceLexer {
    return new SliceLexer(this.filePath, this.text.slice(from, to), this.line, this.col + from, this.offset + from);
  }

  /** The first token at or after index `pos`, or undefined at the end of the slice. */
  at(pos: number, mode: SliceMode): Token | undefined {
    let p = pos;
    for (;;) {
      if (p >= this.text.length) return undefined;
      let tok: Token | undefined;
      try {
        tok = lex(this.text, this.filePath, {
          lenient: true,
          start: p,
          startAt: { line: this.line, col: this.col + p },
          regexFirst: mode.regex === true,
          scripts: mode.scripts !== false,
        }).next().value as Token | undefined;
      } catch {
        tok = this.stop(p, mode);
      }
      if (!tok) return undefined;
      if (tok.kind === "other" && /^\s$/.test(tok.text)) {
        p = tok.offset + 1;
        continue;
      }
      return { ...tok, offset: this.offset + tok.offset };
    }
  }

  /** All tokens from `pos` to the end of the slice in one mode. */
  all(pos: number, mode: SliceMode): Token[] {
    const out: Token[] = [];
    for (let tok = this.at(pos, mode); tok; tok = this.at(this.end(tok), mode)) out.push(tok);
    return out;
  }

  /** The token for the lexeme at `pos` where the lexer stopped. */
  private stop(from: number, mode: SliceMode): Token {
    let p = from;
    while (/[ \t\r]/.test(this.text[p]!)) p += 1;
    const make = (kind: Token["kind"], len: number): Token => ({
      kind,
      text: this.text.slice(p, p + len),
      line: this.line,
      col: this.col + p,
      offset: p,
    });
    // The rest of the slice, without trailing whitespace.
    const rest = this.text.trimEnd().length - p;
    const ch = this.text[p];
    if (ch === "`") return make("other", 1);
    if (mode.triple === "pair" && this.text.startsWith('"""', p)) return make("string", 2);
    const script = SCRIPT_TRIPLE.exec(this.text.slice(p));
    if (mode.triple === "pair" && script) return make("script_oneline", script[0].length - 1);
    if (mode.triple === "span" && this.text.startsWith('"""', p)) {
      const close = this.text.indexOf('"""', p + 3);
      return make("other", close === -1 ? rest : close + 3 - p);
    }
    return make("other", rest);
  }
}

/** Brackets the `;` split counts (`${` opens a brace; `[` / `]` are `other` tokens). */
const BRACKETS = new Map<string, ["(" | "{" | "[", number]>([
  ["(", ["(", 1]],
  [")", ["(", -1]],
  ["{", ["{", 1]],
  ["${", ["{", 1]],
  ["}", ["{", -1]],
  ["[", ["[", 1]],
  ["]", ["[", -1]],
]);

/**
 * Split slice `L` into `;`-separated statements (an inline `{ a; b }` body, or
 * the arms on one multiline-match line): `;` splits outside strings, `"""`
 * spans, and brackets; `'` is a plain character. With `armRegex`, a `/` at the
 * start, after `;`, or after `=>` opens a regex that `;` cannot split either.
 * Returns each statement's `[from, to)` in the slice.
 */
export function splitStatements(L: SliceLexer, armRegex: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const depth = { "(": 0, "{": 0, "[": 0 };
  let start: Token | undefined = undefined;
  let last: Token | undefined = undefined;
  let prev: Token | undefined = undefined;
  let prev2: Token | undefined = undefined;
  const flush = (): void => {
    if (start && last) out.push([L.rel(start), L.end(last)]);
    start = last = undefined;
  };
  for (let pos = 0; ; ) {
    const arrowBefore =
      isPunct(prev, "=>") || (prev?.text === ">" && prev2 !== undefined && adjacent(prev2, prev) && prev2.text.endsWith("="));
    const regex = armRegex && (!prev || isPunct(prev, ";") || arrowBefore);
    const tok = L.at(pos, { regex, scripts: false, triple: "span" });
    if (!tok) break;
    pos = L.end(tok);
    prev2 = prev;
    prev = tok;
    if (isPunct(tok, ";") && !depth["("] && !depth["{"] && !depth["["]) {
      flush();
      continue;
    }
    const bracket = tok.kind === "punct" || tok.kind === "other" ? BRACKETS.get(tok.text) : undefined;
    if (bracket) depth[bracket[0]] += bracket[1];
    start ??= tok;
    last = tok;
  }
  flush();
  return out;
}

/**
 * A token that opens an anonymous inline script: `'…'`, `'''…'''`, tagged
 * `python3'…'`, or (after a lexer stop) text starting with a quote or a
 * removed backtick, which the inline-script parser then rejects.
 */
export function isScriptHead(tok: Token | undefined): boolean {
  if (!tok) return false;
  if (tok.kind === "script_oneline" || tok.kind === "script_fenced") return true;
  return tok.kind === "other" && /^(?:['`]|[A-Za-z_][A-Za-z0-9_.-]*')/.test(tok.text);
}

/** `BodyCursor.firstCol` for line `idx` of `lines`. */
export function firstColOnLine(filePath: string, lines: string[], idx: number, text: string): number {
  return BodyCursor.of(filePath, lines).firstCol(idx, text);
}

/** True when one-line `text` starts with an inline script (or a quote / backtick the script parser rejects). */
export function startsScript(filePath: string, text: string): boolean {
  return isScriptHead(firstToken(filePath, text));
}

/** The first token of one-line `text`; quotes pair up the way the old string scanners read them. */
export function firstToken(filePath: string, text: string, line = 1, col = 1): Token | undefined {
  return new SliceLexer(filePath, text, line, col, 0).at(0, { triple: "pair" });
}
