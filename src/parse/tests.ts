// `test "…" { … }` blocks in `*.test.jh` files. Each step line is read from
// its physical-line tokens (`BodyCursor.lineTokensOf`) and tried against the
// step forms in a fixed order: the mocks here, then the assertions, `const`,
// and runs in `test-steps.ts`, then the removed forms with their migration
// messages.

import type { TestBlockDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseParamList, rejectRemovedEscapes, SINGLE_QUOTE_MESSAGE, stripQuotes } from "./core";
import { parseMatchArms } from "./match";
import { parseCompactMatchArms } from "./match-arms";
import type { MatchArmDef } from "../types";
import type { Token } from "./lexer";
import { adjacent, isPunct, type BodyCursor } from "./body-cursor";
import { parseBraceBlockBody } from "./workflow-brace";
import {
  decodeTestString,
  isWord,
  parseExpect,
  parseTestConst,
  parseTestRun,
  refAt,
  spacedBeforeNext,
  type TestLine,
  type TestStepResult,
} from "./test-steps";

const MOCK_PROMPT_MESSAGE =
  'mock prompt must be: mock prompt "<response>", mock prompt <const_name>, or mock prompt { "pattern" => "response", _ => "default" }';

/**
 * `mock <kind> <more>` with one space after each word: the index of the
 * token after `<kind>`, or -1.
 */
function mockPrefix(t: TestLine, kind: string): number {
  const [mock, kw, more] = t.toks;
  if (!isWord(mock, "mock") || !isWord(kw, kind) || !more) return -1;
  const oneSpace = (tok: Token): boolean => t.raw[tok.col - 1 + tok.text.length] === " ";
  return kw!.col === mock!.col + 5 && oneSpace(mock!) && oneSpace(kw!) ? 2 : -1;
}

/**
 * `mock def|script <ref>(params) {` (or the old `mock def|script <ref> {`,
 * rejected): the ref and parameters. Null when the line is another form.
 */
function parseMockHeader(t: TestLine, kind: "def" | "script"): { ref: string; params: string[] } | null {
  const at = mockPrefix(t, kind);
  const ref = at === -1 ? null : refAt(t.toks, at);
  if (!ref) return null;
  const next = t.toks[ref.next];
  if (isPunct(next, "{") && ref.next === t.toks.length - 1) {
    fail(t.filePath, `mock ${kind} requires parentheses: mock ${kind} ${ref.ref}() { … }`, t.lineNo, t.col);
  }
  if (!isPunct(next, "(")) return null;
  // The parameter list runs to the first `)`; only `{` may follow it.
  const closeAt = t.toks.findIndex((tok, k) => k > ref.next && tok.text.includes(")"));
  if (!isPunct(t.toks[closeAt], ")") || closeAt !== t.toks.length - 2 || !isPunct(t.toks[closeAt + 1], "{")) {
    return null;
  }
  const inner = t.raw.slice(next!.col, t.toks[closeAt]!.col - 1);
  return { ref: ref.ref, params: inner.trim() ? parseParamList(t.filePath, inner, t.lineNo) : [] };
}

/** Finish a `mock prompt { … }` block (multiline or compact): guard arm count, reject removed escapes, build the step. */
function mockPromptBlock(
  t: TestLine,
  arms: MatchArmDef[],
  next: number,
  loc: { line: number; col: number },
  compact: boolean,
): TestStepResult {
  if (arms.length === 0) {
    fail(t.filePath, "mock prompt block must have at least one arm", t.lineNo);
  }
  for (const arm of arms) {
    const body = arm.body.trim();
    if (!arm.tripleQuotedBody && body.startsWith('"') && body.endsWith('"')) {
      rejectRemovedEscapes(t.filePath, body.slice(1, -1), "test", t.lineNo);
    }
  }
  return { step: { type: "test_mock_prompt_block", arms, ...(compact ? { compact: true } : {}), loc }, next };
}

/** `mock prompt "<response>"`, `mock prompt <const>`, or a `mock prompt { pattern => response }` block. */
function parseMockPrompt(t: TestLine): TestStepResult | null {
  const at = mockPrefix(t, "prompt");
  if (at === -1) return null;
  const arg = t.toks.slice(at);
  const loc = { line: t.lineNo, col: t.col };
  if (arg.length === 1 && isPunct(arg[0], "{")) {
    const { arms, next } = parseMatchArms(t.cursor, t.cursor.next(t.at), t.lineNo);
    return mockPromptBlock(t, arms, next, loc, false);
  }
  // Compact one-line block `mock prompt { "a" => "x", _ => "d" }`: same arm
  // grammar and comma splitter as the compact `match` form.
  const open = arg[0];
  const close = arg[arg.length - 1];
  if (open && close && isPunct(open, "{") && isPunct(close, "}")) {
    const inner = t.raw.slice(open.col, close.col - 1);
    const arms = parseCompactMatchArms(t.filePath, inner, t.lineNo, open.col + 1);
    return mockPromptBlock(t, arms, t.cursor.next(t.at), loc, true);
  }
  // Errors report the 1-based column of the `mock` token, like every other step.
  if (arg[0]?.text.startsWith("'")) {
    fail(t.filePath, SINGLE_QUOTE_MESSAGE, t.lineNo, t.col);
  }
  // `mock prompt <ident>` resolves the ident from a previously declared `const` in this block.
  if (arg[0]?.kind === "ident") {
    if (arg.length > 1) {
      fail(t.filePath, MOCK_PROMPT_MESSAGE, t.lineNo, t.col);
    }
    return { step: { type: "test_mock_prompt", response: "", responseVar: arg[0]!.text, loc }, next: t.cursor.next(t.at) };
  }
  if (arg[0]?.kind !== "string" && arg[0]?.text !== '"""') {
    fail(t.filePath, MOCK_PROMPT_MESSAGE, t.lineNo, t.col);
  }
  // Exactly one `"<response>"` token; any text after it is extra.
  if (arg.length > 1) {
    fail(t.filePath, MOCK_PROMPT_MESSAGE, t.lineNo, t.col);
  }
  const text = stripQuotes(t.raw.slice(arg[0]!.col - 1));
  return {
    step: { type: "test_mock_prompt", response: decodeTestString(t.filePath, text, t.lineNo, t.col), loc },
    next: t.cursor.next(t.at),
  };
}

function parseMockDef(t: TestLine, trivia: Trivia): TestStepResult | null {
  const header = parseMockHeader(t, "def");
  if (!header) return null;
  const { steps, next } = parseBraceBlockBody(t.cursor, t.cursor.next(t.at), t.lineNo, trivia);
  return { step: { type: "test_mock_def", ...header, steps, loc: { line: t.lineNo, col: t.col } }, next };
}

/** `mock script ref(params) {`: the body is raw shell up to a line that is just `}`. */
function parseMockScript(t: TestLine): TestStepResult | null {
  const header = parseMockHeader(t, "script");
  if (!header) return null;
  const raw = t.cursor.rawBodyAfter(t.at);
  if (!raw) {
    fail(t.filePath, "unterminated mock block", t.lineNo + 1);
  }
  return {
    step: { type: "test_mock_script", ...header, body: raw.body, loc: { line: t.lineNo, col: t.col } },
    next: t.cursor.next(raw.closeAt),
  };
}

/** Removed mock forms: `mock workflow|rule …` and `mock function …`. */
function rejectRemovedMocks(t: TestLine): void {
  const [head, kind] = t.toks;
  if (!isWord(head, "mock") || kind?.kind !== "ident" || adjacent(head!, kind) || !spacedBeforeNext(t.toks, 1)) return;
  if (kind.text === "workflow" || kind.text === "rule") {
    fail(t.filePath, `'${kind.text}' is not a keyword; use 'mock def'`, t.lineNo, t.col);
  }
  if (kind.text === "function") {
    fail(t.filePath, '"mock function" is no longer supported; use "mock script"', t.lineNo, t.col);
  }
}

const CAMEL_CASE: Record<string, string> = {
  expectContain: "expect_contain",
  expectNotContain: "expect_not_contain",
  expectEqual: "expect_equal",
};

function rejectCamelCase(t: TestLine): void {
  const head = t.toks[0]!;
  const snake = head.kind === "ident" && Object.prototype.hasOwnProperty.call(CAMEL_CASE, head.text) ? CAMEL_CASE[head.text] : undefined;
  if (snake && spacedBeforeNext(t.toks, 0)) {
    fail(t.filePath, `camelCase assertions are no longer supported; use "${snake}"`, t.lineNo, t.col);
  }
}

/** Old forms with a migration message (`x = ref`, a bare `a.b`); anything else is not a step. */
function rejectNonStep(t: TestLine): never {
  const [head, second] = t.toks;
  const endsHere = (next: number): boolean => next === t.toks.length || spacedBeforeNext(t.toks, next - 1);
  const assigned = head!.kind === "ident" && isPunct(second, "=") ? refAt(t.toks, 2) : null;
  if (assigned && endsHere(assigned.next)) {
    fail(t.filePath, `use "const ${head!.text} = ${assigned.ref}(…)" to capture def output`, t.lineNo, t.col);
  }
  const bare = refAt(t.toks, 0);
  if (bare && bare.ref.includes(".") && endsHere(bare.next)) {
    fail(t.filePath, `use "${bare.ref}(…)" to call a def in tests`, t.lineNo, t.col);
  }
  fail(t.filePath, `unrecognized test step: ${t.raw.trim()}`, t.lineNo, t.col);
}

/** One step line inside a test block; forms are tried in this order. */
function parseTestStep(t: TestLine, trivia: Trivia): TestStepResult {
  const step = parseMockPrompt(t) ?? parseMockDef(t, trivia) ?? parseMockScript(t) ?? parseExpect(t);
  if (step) return step;
  rejectRemovedMocks(t);
  rejectCamelCase(t);
  return parseTestConst(t) ?? parseTestRun(t) ?? rejectNonStep(t);
}

/** `test "…" { … }` opening on the line at `at`: the block and the position after its `}` line. */
export function parseTestBlock(
  cursor: BodyCursor,
  at: number,
  trivia: Trivia = createTrivia(),
): { testBlock: TestBlockDef; next: number } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const [kw, desc, open, extra] = cursor.lineTokensOf(at);
  if (kw?.text !== "test" || desc?.kind !== "string" || adjacent(kw, desc) || !isPunct(open, "{") || extra) {
    fail(filePath, 'test block must match: test "description" {', lineNo);
  }
  const description = desc.text.slice(1, -1).replace(/\\"/g, '"');
  const testBlock: TestBlockDef = {
    description,
    steps: [],
    loc: { line: lineNo, col: kw.col },
  };

  let pos = cursor.next(at);
  while (!cursor.atEnd(pos)) {
    const toks = cursor.lineTokensOf(pos);
    const head = toks[0];
    if (!head) {
      const last = testBlock.steps[testBlock.steps.length - 1];
      if (last && last.type !== "blank_line") {
        testBlock.steps.push({ type: "blank_line" });
      }
      pos = cursor.next(pos);
      continue;
    }
    if (toks.length === 1 && isPunct(head, "}")) {
      return { testBlock, next: cursor.next(pos) };
    }
    const raw = cursor.text(pos);
    const stepNo = cursor.lineNo(pos);
    if (head.kind === "other" && head.text === "#") {
      testBlock.steps.push({ type: "comment", text: raw.trim(), loc: { line: stepNo, col: head.col } });
      pos = cursor.next(pos);
      continue;
    }
    const t: TestLine = { filePath, cursor, at: pos, raw, toks, lineNo: stepNo, col: head.col };
    const { step, next } = parseTestStep(t, trivia);
    testBlock.steps.push(step);
    pos = next;
  }
  fail(filePath, `unterminated test block: ${description}`, lineNo);
}
