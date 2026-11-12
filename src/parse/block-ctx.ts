// Shared shapes for def-body statement parsing: the per-statement context the
// `STATEMENT` handlers receive, and small step builders they share. The
// recursive parsers (`parseBraceBlockBody`, one inline statement) reach the
// handlers through `BlockCtx.parse`, so handler modules never import the
// dispatcher in `workflow-brace.ts` and the module graph stays acyclic.

import type { CatchBody, DefMetadata, Expr, LocalDecl, StepDef } from "../types";
import type { Trivia } from "./trivia";
import type { Token } from "./lexer";
import type { BodyCursor } from "./body-cursor";
import type { InlineScriptParsed } from "./inline-script";
import { fail, isReservedBuiltinName } from "./core";
import { consumeTripleQuotedArg, dedentTripleQuotedBody, tripleQuoteBodyToRaw } from "./triple-quote";

export type BlockParseOpts = {
  /** When true, push `blank_line` trivia steps so the formatter can preserve spacing. */
  preserveBlankLines?: boolean;
  /**
   * When set, allow a `config { … }` block as the first non-comment statement.
   * The callback receives the parsed metadata and may throw via `fail()` to
   * reject specific keys (workflows reject `module.*`).
   */
  onConfigBlock?: (metadata: DefMetadata, lineNo: number) => void;
  /**
   * When set (used for `if` bodies), also close the block on a `} else {`
   * line and signal it via `closedWithElse` in the return value. Without
   * this flag, `} else {` is parsed as a normal statement line (and errors).
   */
  allowElseTerminator?: boolean;
  /**
   * When set (nested `def` bodies), reject `import` / `import script` and
   * `config { … }` lines as parse errors instead of letting them fall
   * through to the shell handler — same class as the nested `export`
   * rejection. Top-level def bodies and module level are unaffected.
   */
  inNestedDef?: boolean;
};

export type BraceBodyResult = {
  steps: StepDef[];
  /** Position after the body's closing line. */
  next: number;
  closedWithElse?: boolean;
  closedWithElseIf?: boolean;
};

/** The recursive entry points, supplied by the dispatcher. */
export type BodyParsers = {
  /** Statements from position `start` up to the `}` that closes the block. */
  body(c: BlockCtx, start: number, openerLineNo: number, opts?: BlockParseOpts): BraceBodyResult;
  /**
   * One statement written inline on the line at `hostAt` (a `catch` /
   * `recover` body). It is parsed as its own line, so columns count from its
   * start.
   */
  inline(c: BlockCtx, hostAt: number, stmt: string): StepDef;
};

export type BlockCtx = {
  filePath: string;
  /** Position of the statement's line. */
  at: number;
  /** The line as written. */
  innerRaw: string;
  /** The line, trimmed. */
  inner: string;
  /** 1-based line number. */
  innerNo: number;
  trivia: Trivia;
  opts: BlockParseOpts | undefined;
  cursor: BodyCursor;
  /** Significant tokens of the statement's line (`BodyCursor.tokens`). */
  tokens: Token[];
  parse: BodyParsers;
};
export type BlockResult = { step: StepDef; next: number };
export type BlockHandler = (c: BlockCtx) => BlockResult | null;

/**
 * The line text right after the leading keyword token, up to the trimmed end
 * of the line: `""` for a bare `log`, `' "x"'` for `log "x"`. Only for a
 * statement whose first token is an identifier.
 */
export function afterKeyword(c: BlockCtx): string {
  const head = c.tokens[0]!;
  return c.innerRaw.trimEnd().slice(head.col - 1 + head.text.length);
}

/** `BodyCursor.firstCol` on the statement's line. */
export function firstCol(c: BlockCtx, text: string): number {
  return c.cursor.firstCol(c.at, text);
}

/** First token is the identifier `kw`, alone on the line or followed by a space. */
export function isKeywordForm(c: BlockCtx, kw: string): boolean {
  const head = c.tokens[0];
  if (head?.kind !== "ident" || head.text !== kw) return false;
  const after = afterKeyword(c);
  return after === "" || after.startsWith(" ");
}

/** Build an `exec` step from a value expression and optional capture/catch/recover/stdin. */
export function execStep(
  body: Expr,
  loc: { line: number; col: number },
  extras: { captureName?: string; catch?: CatchBody; recover?: CatchBody; stdin?: Expr } = {},
): StepDef {
  return {
    type: "exec",
    body,
    ...(extras.captureName ? { captureName: extras.captureName } : {}),
    ...(extras.stdin ? { stdin: extras.stdin } : {}),
    ...(extras.catch ? { catch: extras.catch } : {}),
    ...(extras.recover ? { recover: extras.recover } : {}),
    loc,
  };
}

/** Build an `inline_script` Expr from a parsed anonymous-script result. */
export function makeInlineScriptExpr(result: InlineScriptParsed, trivia?: Trivia): Expr {
  const expr: Expr = {
    kind: "inline_script",
    body: result.body,
    ...(result.lang ? { lang: result.lang } : {}),
    args: result.args,
  };
  trivia?.setNode(expr, { scriptBodyKind: result.fenced ? "fenced" : "oneline" });
  return expr;
}

/** Build a triple-quoted literal Expr (stored in the shared quoted form) and record its trivia. */
export function makeTripleQuotedLiteral(trivia: Trivia, body: string): Expr {
  const expr: Expr = { kind: "literal", raw: tripleQuoteBodyToRaw(dedentTripleQuotedBody(body)) };
  trivia.setNode(expr, { tripleQuoted: true, rawBody: body });
  return expr;
}

/** A step argument `arg` on the statement's line that opens a `"""` block, as a literal. */
export function tripleQuotedArg(c: BlockCtx, arg: string): { expr: Expr; next: number } {
  const { body, next } = consumeTripleQuotedArg(c.cursor, c.at, arg);
  return { expr: makeTripleQuotedLiteral(c.trivia, body), next };
}

/** Wrap a nested declaration node in a `local_decl` step. */
export function localDeclStep(filePath: string, decl: LocalDecl, loc: { line: number; col: number }): StepDef {
  const name = decl.kind === "script" ? decl.script.name : decl.kind === "def" ? decl.def.name : decl.prompt.name;
  if (isReservedBuiltinName(name)) {
    fail(filePath, `"${name}" is a reserved builtin record and cannot be used as a ${decl.kind} name`, loc.line, loc.col);
  }
  return { type: "local_decl", decl, loc };
}
