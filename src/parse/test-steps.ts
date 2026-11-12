// Steps inside a `test "…" { … }` block that assert and call: `expect_*`,
// test-scope `const`, and `ref(args)` runs. Each reads the step's physical-line
// tokens (`BodyCursor.lineTokensOf`); the mock steps live in `tests.ts`.

import type { TestStepDef } from "../types";
import type { Token } from "./lexer";
import { decodeQuotedInner, fail, rejectRemovedEscapes } from "./core";
import { adjacent, isPunct, type BodyCursor } from "./body-cursor";
import { dedentTripleQuotedBody, readTripleQuoteBlock } from "./triple-quote";

/** One test-block line: its tokens, text, and position. */
export type TestLine = {
  filePath: string;
  cursor: BodyCursor;
  idx: number;
  raw: string;
  toks: Token[];
  /** 1-based line number. */
  lineNo: number;
  /** Column of the first token. */
  col: number;
};

export type TestStepResult = { step: TestStepDef; nextIdx: number };

/** Decode the inner text of a test-DSL `"…"` string: `\"` is the only escape. */
export function decodeTestString(filePath: string, inner: string, lineNo: number, col: number): string {
  rejectRemovedEscapes(filePath, inner, "test", lineNo, col);
  return decodeQuotedInner(inner);
}

/** True when `tok` is the identifier `text`. */
export function isWord(tok: Token | undefined, text: string): boolean {
  return tok?.kind === "ident" && tok.text === text;
}

/** True when token `i` is followed, after whitespace, by another token. */
export function spacedBeforeNext(toks: Token[], i: number): boolean {
  const next = toks[i + 1];
  return next !== undefined && !adjacent(toks[i]!, next);
}

/** `name` or `alias.name` written without spaces at token `i`: its text and the index after it. */
export function refAt(toks: Token[], i: number): { ref: string; next: number } | null {
  const a = toks[i];
  if (a?.kind !== "ident") return null;
  const [dot, b] = [toks[i + 1], toks[i + 2]];
  if (isPunct(dot, ".") && b?.kind === "ident" && adjacent(a, dot!) && adjacent(dot!, b)) {
    return { ref: `${a.text}.${b.text}`, next: i + 3 };
  }
  return { ref: a.text, next: i + 1 };
}

/**
 * `(args)` at token `i`, ending at the first `)` on the line, then nothing or
 * `allow_failure`: the argument text and whether `allow_failure` was written.
 */
function callTail(t: TestLine, i: number): { argsRaw: string; allowFailure: boolean } | null {
  const open = t.toks[i];
  if (!isPunct(open, "(")) return null;
  const closeAt = t.toks.findIndex((tok, k) => k > i && tok.text.includes(")"));
  const close = t.toks[closeAt];
  if (!isPunct(close, ")")) return null;
  const rest = t.toks.slice(closeAt + 1);
  const allowFailure = rest.length === 1 && isWord(rest[0], "allow_failure") && !adjacent(close!, rest[0]!);
  if (rest.length > 0 && !allowFailure) return null;
  return { argsRaw: t.raw.slice(open!.col, close!.col - 1).trim(), allowFailure };
}

/** `expect_contain` / `expect_not_contain` / `expect_equal <var> "<text>" | <ident>`. */
export function parseExpect(t: TestLine): TestStepResult | null {
  const [kw, variable, value] = t.toks;
  const type = kw?.kind === "ident" && Object.prototype.hasOwnProperty.call(EXPECT, kw.text) ? EXPECT[kw.text] : undefined;
  if (
    !type ||
    t.toks.length !== 3 ||
    variable!.kind !== "ident" ||
    adjacent(kw!, variable!) ||
    adjacent(variable!, value!) ||
    (value!.kind !== "string" && value!.kind !== "ident")
  ) {
    return null;
  }
  const loc = { line: t.lineNo, col: t.col };
  const literal = value!.kind === "string" ? decodeTestString(t.filePath, value!.text.slice(1, -1), t.lineNo, t.col) : "";
  const byVar = value!.kind === "ident" ? value!.text : undefined;
  const step: TestStepDef =
    type === "test_expect_equal"
      ? { type, variable: variable!.text, expected: literal, ...(byVar ? { expectedVar: byVar } : {}), loc }
      : { type, variable: variable!.text, substring: literal, ...(byVar ? { substringVar: byVar } : {}), loc };
  return { step, nextIdx: t.idx + 1 };
}

const EXPECT: Record<string, "test_expect_contain" | "test_expect_not_contain" | "test_expect_equal"> = {
  expect_contain: "test_expect_contain",
  expect_not_contain: "test_expect_not_contain",
  expect_equal: "test_expect_equal",
};

/**
 * Test-scope `const`: `const NAME = """…"""`, `const NAME = "literal"`, or
 * `const capture = ref(args) [allow_failure]`.
 */
export function parseTestConst(t: TestLine): TestStepResult | null {
  const [kw, name, eq, value] = t.toks;
  if (!isWord(kw, "const") || name?.kind !== "ident" || adjacent(kw!, name) || !isPunct(eq, "=")) return null;
  const loc = { line: t.lineNo, col: t.col };
  if (t.toks.length === 4 && value!.kind === "other" && value!.text === '"""') {
    const { body, nextIdx, afterClose } = readTripleQuoteBlock(t.filePath, t.cursor.lines, t.idx, '"""');
    if (afterClose.trim()) {
      fail(t.filePath, `unexpected content after closing """: '${afterClose.trim()}'`, nextIdx, t.col);
    }
    return { step: { type: "test_const", name: name.text, value: dedentTripleQuotedBody(body), loc }, nextIdx };
  }
  if (t.toks.length === 4 && value!.kind === "string") {
    const text = decodeTestString(t.filePath, value!.text.slice(1, -1), t.lineNo, t.col);
    return { step: { type: "test_const", name: name.text, value: text, loc }, nextIdx: t.idx + 1 };
  }
  const call = refAt(t.toks, 3);
  const tail = call ? callTail(t, call.next) : null;
  if (!call || !tail) return null;
  return { step: runStep(t, call.ref, tail, name.text), nextIdx: t.idx + 1 };
}

/** `ref(args) [allow_failure]` with no capture. */
export function parseTestRun(t: TestLine): TestStepResult | null {
  const call = refAt(t.toks, 0);
  const tail = call ? callTail(t, call.next) : null;
  if (!call || !tail) return null;
  return { step: runStep(t, call.ref, tail), nextIdx: t.idx + 1 };
}

function runStep(
  t: TestLine,
  defRef: string,
  tail: { argsRaw: string; allowFailure: boolean },
  captureName?: string,
): TestStepDef {
  const args = tail.argsRaw ? parseTestCallArgs(t.filePath, tail.argsRaw, t.lineNo, t.col) : [];
  return {
    type: "test_run_def",
    ...(captureName !== undefined ? { captureName } : {}),
    defRef,
    args: args.length > 0 ? args : undefined,
    allowFailure: tail.allowFailure || undefined,
    loc: { line: t.lineNo, col: t.col },
  };
}

/** Parse comma-separated args from inside parentheses: "arg1", "arg2" */
function parseTestCallArgs(filePath: string, argsRaw: string, lineNo: number, col: number): string[] {
  const decodeTestArg = (token: string): string =>
    token.startsWith('"') && token.endsWith('"') ? decodeTestString(filePath, token.slice(1, -1), lineNo, col) : token;
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  for (let j = 0; j < argsRaw.length; j += 1) {
    const ch = argsRaw[j];
    if (ch === '"' && (j === 0 || argsRaw[j - 1] !== "\\")) {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      const trimmed = current.trim();
      if (trimmed) args.push(decodeTestArg(trimmed));
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) args.push(decodeTestArg(trimmed));
  return args;
}
