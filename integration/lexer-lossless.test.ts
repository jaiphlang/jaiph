import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../src/parser";
import { tokenize, type Token } from "../src/parse/lexer";
import { collectSources } from "./jaiph-corpus";

// Tokenizer property test: for every Jaiph source in the repo that parses
// today, the tokens are lossless. Each token's `text` sits at its reported
// line/col, the only text between tokens is spaces, tabs and carriage returns,
// and joining tokens plus that whitespace gives back the source exactly.

/** Rebuild `source` from tokens; returns a problem description or undefined. */
function rebuild(source: string, tokens: Token[]): { text: string; problem?: string } {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  let out = "";
  let pos = 0;
  for (const tok of tokens) {
    const at = lineStarts[tok.line - 1]! + tok.col - 1;
    const gap = source.slice(pos, at);
    if (at < pos || !/^[ \t\r]*$/.test(gap)) {
      return { text: out, problem: `non-whitespace gap ${JSON.stringify(gap)} before ${tok.kind} at ${tok.line}:${tok.col}` };
    }
    if (source.slice(at, at + tok.text.length) !== tok.text) {
      return { text: out, problem: `${tok.kind} at ${tok.line}:${tok.col} does not match the source slice` };
    }
    out += gap + tok.text;
    pos = at + tok.text.length;
  }
  const tail = source.slice(pos);
  if (!/^[ \t\r]*$/.test(tail)) return { text: out, problem: `untokenized tail ${JSON.stringify(tail.slice(0, 40))}` };
  return { text: out + tail };
}

test("tokenize is lossless over every Jaiph source in the repo that parses", () => {
  const sources = collectSources();
  const failures: string[] = [];
  let checked = 0;
  for (const [name, source] of sources) {
    const filePath = name.includes(".test.jh") ? "x.test.jh" : "x.jh";
    try {
      parsejaiph(source, filePath);
    } catch {
      continue; // not a standalone program today
    }
    checked += 1;
    let tokens: Token[];
    try {
      tokens = tokenize(source, filePath);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      continue;
    }
    const { text, problem } = rebuild(source, tokens);
    if (problem) failures.push(`${name}: ${problem}`);
    else if (text !== source) failures.push(`${name}: rebuilt text differs from the source`);
  }
  assert.ok(checked > 300, `expected a broad corpus, checked ${checked} sources`);
  assert.deepEqual(failures, []);
});
