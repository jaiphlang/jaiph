// Token cursor over a module's source. A parser holds a position: the source
// offset where a statement's line starts. It reads the statement's tokens from
// there and returns the position after the statement (`next`): the start of
// the line after its last token, so a `"""` / `'''` block, a multi-line call
// or a nested body moves the position past every line it spans. The position
// after the last line is `source.length + 1` (`atEnd`).
//
// Def bodies use `tokens(at)`: one logical line, every token from `at` up to
// its newline, so a `"""` / `'''` block that opens on the line is one token and
// the tokens after its closer (`""" -> ch`, `'''(args)`) belong to the same
// line. Top-level declarations and test-block steps use `lineTokensOf(at)`: the
// tokens of the physical line only, where a block opener is a one-token
// placeholder that `tokenAt` / `rawBodyAfter` expand into the whole block.

import { lex, type Token } from "./lexer";

/** Leading identifier of a token's text: the keyword a statement starts with, if any. */
export function keyOf(tok: Token | undefined): string | undefined {
  if (!tok || tok.kind === "string" || tok.kind === "triple_string") return undefined;
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(tok.text)?.[0];
}

/** True when `tok` is the punctuation `text`. */
export function isPunct(tok: Token | undefined, text: string): boolean {
  return tok?.kind === "punct" && tok.text === text;
}

/** True when `b` starts right where `a` ends (no whitespace between). */
export function adjacent(a: Token, b: Token): boolean {
  return a.offset + a.text.length === b.offset;
}

/**
 * The `[export] <kw> <name>` head of a declaration line: the index of the
 * keyword token (after an optional `export`) and the name token after it, or
 * null when the line does not start that way.
 */
export function declHead(toks: Token[], kw: string): { at: number; name: Token } | null {
  const at = toks[0]?.kind === "ident" && toks[0].text === "export" && !adjacent(toks[0], toks[1] ?? toks[0]) ? 1 : 0;
  const kwTok = toks[at];
  const name = toks[at + 1];
  if (kwTok?.kind !== "ident" || kwTok.text !== kw || !name || adjacent(kwTok, name)) return null;
  return { at, name };
}

/** Keywords a module-level declaration starts with (`export` may precede the last group). */
const SPACED_KEYWORDS = ["import", "channel", "test"];
const EXPORTABLE = ["rule", "workflow", "script", "prompt", "def"];

/**
 * The declaration a module-level line starts with: `config` (`config {`),
 * `import script`, `import`, `channel`, `test`, `const`, or, after an optional
 * `export`, `rule` / `workflow` (removed), `script`, `prompt`, `def`.
 * Undefined for anything else.
 */
export function topLevelKeyword(toks: Token[], raw: string): string | undefined {
  const [first, second] = toks;
  if (first?.kind !== "ident") return undefined;
  const spaced = (tok: Token): boolean => raw[tok.col - 1 + tok.text.length] === " ";
  if (first.text === "config") return isPunct(second, "{") ? "config" : undefined;
  if (first.text === "import" && second?.text === "script" && second.col === first.col + 7 && spaced(first)) {
    if (second.kind === "ident" && spaced(second) && toks.length > 2) return "import script";
  }
  if (SPACED_KEYWORDS.includes(first.text)) return spaced(first) && second ? first.text : undefined;
  if (first.text === "const") {
    return second && !adjacent(first, second) && /^[A-Za-z_]/.test(second.text) ? "const" : undefined;
  }
  const at = first.text === "export" && second && !adjacent(first, second) ? 1 : 0;
  const kw = toks[at];
  const next = toks[at + 1];
  if (kw?.kind !== "ident" || !EXPORTABLE.includes(kw.text) || !next || adjacent(kw, next)) return undefined;
  return kw.text;
}

/** A block opener left on its line by `tokenizeLine`: `"""`, or `'''` with an optional interpreter tag. */
export const BLOCK_OPENER = /^(?:"""|([A-Za-z_][A-Za-z0-9_.-]*)?''')$/;

/**
 * The lexeme where the lexer stopped: a block opener (`"""`, `tag'''`), an
 * unterminated one-line script opener (`tag'`), or one character.
 */
const STOPPED_AT = /^(?:"""|(?:[A-Za-z_][A-Za-z0-9_.-]*)?'''|[A-Za-z_][A-Za-z0-9_.-]*'|[^])/;

/**
 * Lenient tokens of one physical line `text` (no newline), positioned on line
 * `lineNo` with offsets from `base`. Lexing never fails: where the lexer stops
 * (an unterminated string or script, a `"""` / `'''` block that cannot close
 * inside the line, a backtick) the lexeme it stopped at becomes one `other`
 * token and lexing resumes after it, so the tokens after it keep their kinds.
 * Spacing characters the lexer does not skip (a no-break space) are dropped.
 */
export function tokenizeLine(filePath: string, text: string, lineNo: number, base = 0): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (;;) {
    try {
      for (const tok of lex(text, filePath, { lenient: true, start: pos, startAt: { line: lineNo, col: pos + 1 } })) {
        pos = tok.offset + tok.text.length;
        if (tok.kind === "other" && /^\s$/.test(tok.text)) continue;
        out.push({ ...tok, offset: base + tok.offset });
      }
      return out;
    } catch {
      while (pos < text.length && /[ \t\r]/.test(text[pos]!)) pos += 1;
      if (pos >= text.length) return out;
      const lexeme = STOPPED_AT.exec(text.slice(pos))![0];
      out.push({ kind: "other", text: lexeme, line: lineNo, col: pos + 1, offset: base + pos });
      pos += lexeme.length;
    }
  }
}

export class BodyCursor {
  private readonly lineTokens = new Map<number, Token[]>();
  private readonly physTokens = new Map<number, Token[]>();
  /** Offsets of the source's newlines, built on the first `lineNo` call. */
  private newlines: number[] | undefined;

  private constructor(
    readonly filePath: string,
    readonly source: string,
  ) {}

  /** A cursor over `source`, whose line endings are already `\n`. */
  static of(filePath: string, source: string): BodyCursor {
    return new BodyCursor(filePath, source);
  }

  /** True when position `at` is past the last line. */
  atEnd(at: number): boolean {
    return !(at <= this.source.length);
  }

  /** Offset of the newline that ends the line at `at`, or the source length. */
  private lineEnd(at: number): number {
    const nl = this.source.indexOf("\n", at);
    return nl === -1 ? this.source.length : nl;
  }

  /** Text of the line that starts at `at`, without its newline ("" past the end). */
  text(at: number): string {
    return this.atEnd(at) ? "" : this.source.slice(at, this.lineEnd(at));
  }

  /** Position of the line after the one that starts at `at`. */
  next(at: number): number {
    return this.lineEnd(at) + 1;
  }

  /** Start of the line that holds source offset `offset`. */
  lineStartAt(offset: number): number {
    return offset <= 0 ? 0 : this.source.lastIndexOf("\n", offset - 1) + 1;
  }

  /** Start of the line a token ends on. */
  closeOf(tok: Token): number {
    return this.lineStartAt(tok.offset + tok.text.length);
  }

  /** 1-based line number of position `at` (one past the last line when `atEnd`). */
  lineNo(at: number): number {
    if (!this.newlines) {
      this.newlines = [];
      for (let nl = this.source.indexOf("\n"); nl !== -1; nl = this.source.indexOf("\n", nl + 1)) this.newlines.push(nl);
    }
    const nls = this.newlines;
    let lo = 0;
    let hi = nls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nls[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1 + (this.atEnd(at) ? 1 : 0);
  }

  /**
   * Significant tokens of the line at `at`, up to its newline. Spacing
   * characters the lexer does not skip (a no-break space) are dropped. When
   * the lexer stops on malformed text (an unterminated string or script), the
   * rest of the line becomes one `other` token and statement parsers report
   * the error in their own words.
   */
  tokens(at: number): Token[] {
    const cached = this.lineTokens.get(at);
    if (cached) return cached;
    const out: Token[] = [];
    const lineNo = this.lineNo(at);
    let end = at;
    try {
      for (const tok of lex(this.source, this.filePath, { lenient: true, start: at, startAt: { line: lineNo, col: 1 } })) {
        if (tok.kind === "newline") break;
        end = tok.offset + tok.text.length;
        if (tok.kind === "other" && /^\s$/.test(tok.text)) continue;
        out.push(tok);
      }
    } catch {
      const src = this.source;
      let from = end;
      while (from < src.length && src[from] !== "\n" && /\s/.test(src[from]!)) from += 1;
      const text = src.slice(from, this.lineEnd(from)).trimEnd();
      const before = src.slice(at, from);
      const line = lineNo + (before.match(/\n/g)?.length ?? 0);
      const col = from - (before.lastIndexOf("\n") === -1 ? at : at + before.lastIndexOf("\n") + 1) + 1;
      if (text) out.push({ kind: "other", text, line, col, offset: from });
    }
    this.lineTokens.set(at, out);
    return out;
  }

  /** Tokens of the physical line at `at` alone (`tokenizeLine`): a block is just its opener. */
  lineTokensOf(at: number): Token[] {
    let cached = this.physTokens.get(at);
    if (!cached) {
      cached = tokenizeLine(this.filePath, this.text(at), this.lineNo(at), at);
      this.physTokens.set(at, cached);
    }
    return cached;
  }

  /**
   * The raw shell body after a `mock script ref(…) {` line at `at` (its
   * `raw_body` token): the lines up to the first line whose trimmed text is
   * `}`, and the position of that line. Null when no such line follows.
   */
  rawBodyAfter(at: number): { body: string; closeAt: number } | null {
    let afterNewline = false;
    try {
      for (const tok of lex(this.source, this.filePath, {
        lenient: true,
        start: at,
        startAt: { line: this.lineNo(at), col: 1 },
      })) {
        if (afterNewline) {
          if (tok.kind !== "raw_body") return { body: "", closeAt: this.next(at) };
          return { body: tok.text.slice(0, -1), closeAt: this.closeOf(tok) };
        }
        afterNewline = tok.kind === "newline";
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * The one token that starts on the line at `at`, column `col`: a `"""`
   * string or `'''` script block. Throws the lexer's `E_PARSE` when it does
   * not close.
   */
  tokenAt(at: number, col: number): Token {
    const it = lex(this.source, this.filePath, {
      lenient: true,
      start: at + col - 1,
      startAt: { line: this.lineNo(at), col },
    });
    return it.next().value as Token;
  }

  /**
   * 1-based column where `text` (no leading whitespace) first occurs on the
   * line at `at`, or 0. An occurrence starts inside a token, so only token
   * positions are tried. Reproduces the columns the line grammar reported when
   * the first occurrence is not the token being reported (`const x = x`).
   */
  firstCol(at: number, text: string): number {
    const raw = this.text(at);
    for (const tok of this.lineTokensOf(at)) {
      const from = tok.col - 1;
      const to = from + tok.text.length;
      for (let i = from; i < to; i += 1) if (raw.startsWith(text, i)) return i + 1;
    }
    return 0;
  }

  /** Text after a token on the line it ends on (up to the newline). */
  textAfter(tok: Token): string {
    const from = tok.offset + tok.text.length;
    return this.source.slice(from, this.lineEnd(from));
  }
}
