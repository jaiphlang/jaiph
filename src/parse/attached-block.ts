import type { CatchBody } from "../types";
import { fail } from "./core";
import { SliceLexer, splitStatements } from "./slice-lexer";
import type { BlockCtx } from "./block-ctx";

const KEYWORD_EXAMPLE = {
  catch: "catch (<name>) { ... }",
  recover: "recover(<name>) { ... }",
} as const;

/** Parse the `(<name>)` binding list right after `catch` / `recover`. */
function parseBinding(
  filePath: string,
  innerNo: number,
  keyword: "catch" | "recover",
  keywordCol: number,
  right: string,
): { failure: string; afterBindings: string } {
  if (!right.startsWith("(")) {
    fail(
      filePath,
      `${keyword} requires explicit bindings: ${KEYWORD_EXAMPLE[keyword]}`,
      innerNo,
      keywordCol,
    );
  }
  const closeParen = right.indexOf(")");
  if (closeParen === -1) {
    fail(filePath, `unterminated ${keyword} bindings: expected ")"`, innerNo, keywordCol);
  }

  const bindingParts = right
    .slice(1, closeParen)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (bindingParts.length === 0) {
    fail(
      filePath,
      `${keyword} requires exactly one binding: ${KEYWORD_EXAMPLE[keyword]}`,
      innerNo,
      keywordCol,
    );
  }
  if (bindingParts.length > 1) {
    if (keyword === "catch") {
      fail(
        filePath,
        "catch accepts exactly one binding: catch (<name>) — the second binding (attempt) has been removed",
        innerNo,
        keywordCol,
      );
    }
    fail(filePath, "recover accepts exactly one binding: recover(<name>)", innerNo, keywordCol);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingParts[0])) {
    fail(
      filePath,
      `invalid ${keyword} binding name: "${bindingParts[0]}" — must be a valid identifier`,
      innerNo,
      keywordCol,
    );
  }
  return { failure: bindingParts[0], afterBindings: right.slice(closeParen + 1).trim() };
}

/**
 * Parse a `(<binding>) { … } | <single-stmt>` clause attached to a host
 * call step on the line at `at`. The body is parsed by the same statement parser
 * used at the top level (through `c.parse`) — there is no separate mini
 * parser for catch/recover.
 *
 * `textAfterKeyword` is whatever follows `catch` / `recover` on the host line
 * (the leading `(` may be preceded by whitespace). Returns the constructed
 * `CatchBody` plus the position to resume parsing from.
 */
export function parseAttachedBlock(
  c: BlockCtx,
  at: number,
  innerNo: number,
  keyword: "catch" | "recover",
  textAfterKeyword: string,
): { body: CatchBody; next: number } {
  const { filePath, cursor } = c;
  const keywordCol = cursor.firstCol(at, keyword);
  const right = textAfterKeyword.trimStart();
  const { failure, afterBindings } = parseBinding(filePath, innerNo, keyword, keywordCol, right);
  const bindings = { failure };

  // Multi-line block: `{` at end of host line; body lives on subsequent lines.
  if (afterBindings === "{") {
    // Pre-scan the following lines' text for the matching `}` so the
    // unterminated message names the clause.
    let depth = 1;
    let probe = cursor.next(at);
    while (!cursor.atEnd(probe)) {
      const t = cursor.text(probe).trim();
      if (t.endsWith("{")) depth += 1;
      if (t === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      probe = cursor.next(probe);
    }
    if (cursor.atEnd(probe)) {
      fail(filePath, `unterminated ${keyword} block, expected "}"`, innerNo, keywordCol);
    }
    const { steps, next } = c.parse.body(c, cursor.next(at), innerNo, c.opts);
    if (steps.length === 0) {
      fail(filePath, `${keyword} block must contain at least one statement`, innerNo, keywordCol);
    }
    return { body: { block: steps, bindings }, next };
  }

  // Inline block on a single line: `{ stmt[; stmt]* }`.
  if (afterBindings.startsWith("{")) {
    if (!afterBindings.endsWith("}")) {
      fail(filePath, `unterminated ${keyword} block, expected "}"`, innerNo, keywordCol);
    }
    const content = new SliceLexer(filePath, afterBindings.slice(1, -1), innerNo, 1, 0);
    const stmts = splitStatements(content, false).map(([from, to]) => content.text.slice(from, to));
    if (stmts.length === 0) {
      fail(filePath, `${keyword} block must contain at least one statement`, innerNo, keywordCol);
    }
    const blockSteps = stmts.map((stmt) => c.parse.inline(c, at, stmt));
    return { body: { block: blockSteps, bindings }, next: cursor.next(at) };
  }

  if (afterBindings === "") {
    fail(filePath, `${keyword} requires a body after bindings`, innerNo, keywordCol);
  }

  const single = c.parse.inline(c, at, afterBindings);
  return { body: { single, bindings }, next: cursor.next(at) };
}
