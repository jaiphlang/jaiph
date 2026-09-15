import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One-fact-one-owner split (design/0003-docs-one-fact-one-owner.md): syntax
// lives on grammar.md, meaning on language.md. grammar.md keeps its EBNF
// productions but must not re-host the semantic tables that language.md owns —
// so the page stays small and the two copies cannot drift. These guards fail
// when grammar.md drifts back toward the pre-split shape.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");

// Same front-matter strip + body-line count as integration/docs-structure.test.ts:
// drop the leading `---\n…\n---` block, then trim leading/trailing blank lines so
// a stray trailing newline does not inflate the count.
function bodyLines(source: string): string[] {
  const normalized = source.replace(/\r\n/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end !== -1) body = lines.slice(end + 1).join("\n");
  }
  const lines = body.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

function grammarBody(): { lines: string[]; text: string } {
  const source = readFileSync(join(DOCS_DIR, "grammar.md"), "utf8");
  const lines = bodyLines(source);
  return { lines, text: lines.join("\n") };
}

// Body-line cap for grammar.md. The pre-split page was ~508 body lines; once the
// semantic tables move to language.md the EBNF-only page fits well under this.
// The cap is what keeps a future edit from pasting a language.md table back.
const GRAMMAR_BODY_CAP = 380;

test("docs-split: grammar.md body is at most 380 lines (semantic tables removed)", () => {
  const { lines } = grammarBody();
  assert.ok(
    lines.length <= GRAMMAR_BODY_CAP,
    `docs/grammar.md body has ${lines.length} lines, over the ${GRAMMAR_BODY_CAP}-line cap — a semantic table has drifted back onto the syntax page; move meaning to language.md and link instead`,
  );
});

test("docs-split: grammar.md still carries the EBNF productions (not just prose)", () => {
  const { text } = grammarBody();
  // Each token must appear inside an ```ebnf fenced block, i.e. as grammar and
  // not only in a sentence. Collect the text of every ebnf fence and search there.
  const ebnf: string[] = [];
  const fenceRe = /```ebnf\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) ebnf.push(m[1]);
  const grammar = ebnf.join("\n");
  for (const token of [
    "run_stmt",
    "run_async_stmt",
    "match_stmt",
    "for_lines_stmt",
    "param_list",
    "return_stmt",
  ]) {
    assert.ok(
      grammar.includes(token),
      `docs/grammar.md must keep the '${token}' EBNF production (found only as prose, or missing)`,
    );
  }
});

test("docs-split: grammar.md points meaning at language.md for match and run async", () => {
  const { text } = grammarBody();
  assert.ok(
    /\]\(language\.md#match-pattern-match\)/.test(text),
    "docs/grammar.md must link `match` meaning to [Language](language.md#match-pattern-match)",
  );
  assert.ok(
    /\]\(language\.md#run-async-concurrent-execution-with-handles\)/.test(text) ||
      /\]\(language\.md#run-execute-a-def-or-script\)/.test(text),
    "docs/grammar.md must link `run async` (or `run`) meaning to its language.md heading",
  );
});

// The other side of the split: language.md must still OWN the meaning. This
// task moves nothing onto grammar.md, so language.md keeps its match and
// run-async semantic tables.
test("docs-split: language.md still owns the match and run async semantic tables", () => {
  const source = readFileSync(join(DOCS_DIR, "language.md"), "utf8");
  // match: arm-delimiter and arm-bodies rows under `## match`.
  assert.ok(
    /^##\s+`match`/m.test(source) && /Arm delimiter/.test(source) && /Arm bodies/.test(source),
    "docs/language.md must keep its `match` semantic table (arm delimiter / arm bodies)",
  );
  // run async: the resolution-trigger row under the run-async heading.
  assert.ok(
    /run-async-concurrent-execution-with-handles/.test(source) &&
      /Resolution trigger/.test(source),
    "docs/language.md must keep its `run async` resolution-trigger table",
  );
});
