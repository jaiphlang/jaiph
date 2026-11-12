// Token cursor over a module's lines. Def bodies use `tokens(idx)`: one logical
// line, every token from the start of line `idx` up to its newline, so a `"""`
// / `'''` block that opens on the line is one token and the tokens after its
// closer (`""" -> ch`, `'''(args)`) belong to the same line. Top-level
// declarations and test-block steps use `lineTokensOf(idx)`: the tokens of the
// physical line only, where a block opener is a one-token placeholder that
// `tokenAt` / `rawBodyAfter` expand into the whole block.

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

  /** Tokens of physical line `idx` alone (`tokenizeLine`): a block is just its opener. */
  lineTokensOf(idx: number): Token[] {
    let cached = this.physTokens.get(idx);
    if (!cached) {
      cached = tokenizeLine(this.filePath, this.lines[idx]!, idx + 1, this.offset(idx));
      this.physTokens.set(idx, cached);
    }
    return cached;
  }

  /**
   * The raw shell body after a `mock script ref(…) {` line `idx` (its
   * `raw_body` token): the lines up to the first line whose trimmed text is
   * `}`, and that line's index. Null when no such line follows.
   */
  rawBodyAfter(idx: number): { body: string; closeIdx: number } | null {
    let afterNewline = false;
    try {
      for (const tok of lex(this.source, this.filePath, {
        lenient: true,
        start: this.offset(idx),
        startAt: { line: idx + 1, col: 1 },
      })) {
        if (afterNewline) {
          if (tok.kind !== "raw_body") return { body: "", closeIdx: idx + 1 };
          return { body: tok.text.slice(0, -1), closeIdx: BodyCursor.endLineIdx(tok) };
        }
        afterNewline = tok.kind === "newline";
      }
    } catch {
      return null;
    }
    return null;
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
