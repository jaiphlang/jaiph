// Token cursor over a def body. The top-level parser still splits a module into
// lines; a def body is parsed from tokens of those lines. `tokens(idx)` lexes
// one logical line: every token from the start of line `idx` up to its newline,
// so a `"""` / `'''` block that opens on the line is one token and the tokens
// after its closer (`""" -> ch`, `'''(args)`) belong to the same line.

import { lex, type Token } from "./lexer";

type LineSource = { source: string; starts: number[] };

const SOURCES = new WeakMap<string[], LineSource>();
const CURSORS = new WeakMap<string[], Map<string, BodyCursor>>();

function lineSource(lines: string[]): LineSource {
  let cached = SOURCES.get(lines);
  if (!cached) {
    const starts: number[] = [];
    let at = 0;
    for (const line of lines) {
      starts.push(at);
      at += line.length + 1;
    }
    cached = { source: lines.join("\n"), starts };
    SOURCES.set(lines, cached);
  }
  return cached;
}

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

export class BodyCursor {
  private readonly lineTokens = new Map<number, Token[]>();

  private constructor(
    readonly filePath: string,
    readonly lines: string[],
    private readonly src: LineSource,
  ) {}

  /** The cursor for `lines` (one per array and file, so nested blocks share its token cache). */
  static of(filePath: string, lines: string[]): BodyCursor {
    let byFile = CURSORS.get(lines);
    if (!byFile) {
      byFile = new Map();
      CURSORS.set(lines, byFile);
    }
    let cursor = byFile.get(filePath);
    if (!cursor) {
      cursor = new BodyCursor(filePath, lines, lineSource(lines));
      byFile.set(filePath, cursor);
    }
    return cursor;
  }

  get source(): string {
    return this.src.source;
  }

  /** 0-based source offset of line `idx` (0-based), column `col` (1-based). */
  offset(idx: number, col = 1): number {
    return this.src.starts[idx]! + col - 1;
  }

  /**
   * Significant tokens of line `idx`, up to its newline. Spacing characters
   * the lexer does not skip (a no-break space) are dropped. When the lexer
   * stops on malformed text (an unterminated string or script), the rest of
   * the line becomes one `other` token and statement parsers report the error
   * in their own words.
   */
  tokens(idx: number): Token[] {
    const cached = this.lineTokens.get(idx);
    if (cached) return cached;
    const out: Token[] = [];
    const lineStart = this.offset(idx);
    let end = lineStart;
    try {
      for (const tok of lex(this.source, this.filePath, {
        lenient: true,
        start: lineStart,
        startAt: { line: idx + 1, col: 1 },
      })) {
        if (tok.kind === "newline") break;
        end = tok.offset + tok.text.length;
        if (tok.kind === "other" && /^\s$/.test(tok.text)) continue;
        out.push(tok);
      }
    } catch {
      const src = this.source;
      let at = end;
      while (at < src.length && src[at] !== "\n" && /\s/.test(src[at]!)) at += 1;
      const nl = src.indexOf("\n", at);
      const text = src.slice(at, nl === -1 ? src.length : nl).trimEnd();
      const before = src.slice(lineStart, at);
      const line = idx + 1 + (before.match(/\n/g)?.length ?? 0);
      const col = at - (before.lastIndexOf("\n") === -1 ? lineStart : lineStart + before.lastIndexOf("\n") + 1) + 1;
      if (text) out.push({ kind: "other", text, line, col, offset: at });
    }
    this.lineTokens.set(idx, out);
    return out;
  }

  /**
   * The one token that starts at line `idx`, column `col`: a `"""` string or
   * `'''` script block. Throws the lexer's `E_PARSE` when it does not close.
   */
  tokenAt(idx: number, col: number): Token {
    const it = lex(this.source, this.filePath, {
      lenient: true,
      start: this.offset(idx, col),
      startAt: { line: idx + 1, col },
    });
    return it.next().value as Token;
  }

  /** 0-based index of the line a token ends on. */
  static endLineIdx(tok: Token): number {
    let n = tok.line - 1;
    for (const ch of tok.text) if (ch === "\n") n += 1;
    return n;
  }

  /** Text after a token on the line it ends on (up to the newline). */
  textAfter(tok: Token): string {
    const from = tok.offset + tok.text.length;
    const nl = this.source.indexOf("\n", from);
    return this.source.slice(from, nl === -1 ? this.source.length : nl);
  }
}
