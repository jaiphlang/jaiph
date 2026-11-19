/**
 * Completeness check for the EBNF in `docs/grammar.md`: every nonterminal
 * referenced on the right-hand side of a production must be defined by a
 * production somewhere in the grammar's `ebnf` code blocks. A reference that is
 * neither defined nor a known lexical terminal (an UPPERCASE token, a quoted
 * literal, or one of the lexical tokens listed below) fails the test — this is
 * what catches a dangling nonterminal such as the former `bash_value_expr`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Tests run from `dist/src/...`; walk up to repo root.
const repoRoot = resolve(__dirname, "../..");
const grammarPath = join(repoRoot, "docs/grammar.md");

/**
 * Lexical terminals: lowercase symbols the lexer produces rather than the
 * grammar deriving with a production (see `## Lexical rules`). They are allowed
 * to appear on an RHS without a definition; every other lowercase symbol must
 * be a defined nonterminal.
 */
const LEXICAL_TERMINALS = new Set([
  "bare_value",
  "comment_line",
  "config_key",
  "digit",
  "double_quoted_string",
  "identifier",
  "integer",
  "interpolation",
  "letter",
  "newline",
  "regex_source",
  "script_line",
  "script_text",
  "string",
  "triple_quoted_block",
  "shell_fragment",
]);

function ebnfBlocks(md: string): string[] {
  return [...md.matchAll(/```ebnf\n([\s\S]*?)```/g)].map((m) => m[1]);
}

test("every nonterminal referenced in docs/grammar.md EBNF is defined", () => {
  const blocks = ebnfBlocks(readFileSync(grammarPath, "utf8"));
  assert.ok(blocks.length > 0, "no ebnf blocks found in docs/grammar.md");

  const defined = new Set<string>();
  for (const b of blocks) {
    for (const m of b.matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)) defined.add(m[1]);
  }

  const referenced = new Set<string>();
  for (const b of blocks) {
    // Drop `(* comments *)` and quoted terminals before scanning for symbols.
    const body = b.replace(/\(\*[\s\S]*?\*\)/g, "").replace(/"(?:[^"\\]|\\.)*"/g, "");
    // A nonterminal reference is a lowercase-initial snake_case word; UPPERCASE
    // tokens (IDENT, REF, …) are lexical terminals and are skipped by the regex.
    for (const m of body.matchAll(/\b([a-z][a-z0-9_]*)\b/g)) referenced.add(m[1]);
  }

  const undefinedRefs = [...referenced]
    .filter((r) => !defined.has(r) && !LEXICAL_TERMINALS.has(r))
    .sort();

  assert.deepEqual(
    undefinedRefs,
    [],
    `docs/grammar.md references nonterminals with no production: ${undefinedRefs.join(", ")}. ` +
      `Define each (or, if it is a lexical token, add it to LEXICAL_TERMINALS).`,
  );
});
