import type { CatchBody, WorkflowStepDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail } from "./core";
import { splitStatementsOnSemicolons } from "./statement-split";
import { parseBlockStatement, parseBraceBlockBody } from "./workflow-brace";

const KEYWORD_EXAMPLE = {
  catch: "catch (<name>) { ... }",
  recover: "recover(<name>) { ... }",
} as const;

/**
 * Parse a `(<binding>) { … } | <single-stmt>` clause attached to a host
 * `run` / `ensure` step. The body is parsed by the same `parseBlockStatement`
 * used at the top level — there is no separate mini parser for catch/recover.
 *
 * `textAfterKeyword` is whatever follows `catch` / `recover` on the host line
 * (the leading `(` may be preceded by whitespace). Returns the constructed
 * `CatchBody` plus the next line index to resume parsing from.
 */
export function parseAttachedBlock(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  keyword: "catch" | "recover",
  textAfterKeyword: string,
  trivia: Trivia = createTrivia(),
): { body: CatchBody; nextIdx: number } {
  const keywordCol = innerRaw.indexOf(keyword) + 1;
  const right = textAfterKeyword.trimStart();

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
  const bindings = { failure: bindingParts[0] };
  const afterBindings = right.slice(closeParen + 1).trim();

  // Multi-line block: `{` at end of host line; body lives on subsequent lines.
  if (afterBindings === "{") {
    // Pre-scan for the matching `}` so the unterminated message names the clause.
    let depth = 1;
    let probe = idx + 1;
    while (probe < lines.length) {
      const t = lines[probe].trim();
      if (t.endsWith("{")) depth += 1;
      if (t === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      probe += 1;
    }
    if (probe >= lines.length) {
      fail(filePath, `unterminated ${keyword} block, expected "}"`, innerNo, keywordCol);
    }
    const { steps, nextIdx } = parseBraceBlockBody(filePath, lines, idx + 1, innerNo, trivia);
    if (steps.length === 0) {
      fail(filePath, `${keyword} block must contain at least one statement`, innerNo, keywordCol);
    }
    return { body: { block: steps, bindings }, nextIdx };
  }

  // Inline block on a single line: `{ stmt[; stmt]* }`.
  if (afterBindings.startsWith("{")) {
    if (!afterBindings.endsWith("}")) {
      fail(filePath, `unterminated ${keyword} block, expected "}"`, innerNo, keywordCol);
    }
    const content = afterBindings.slice(1, -1).trim();
    const stmts = content === "" ? [] : splitStatementsOnSemicolons(content);
    if (stmts.length === 0) {
      fail(filePath, `${keyword} block must contain at least one statement`, innerNo, keywordCol);
    }
    const blockSteps = stmts.map((stmt) => parseAtHostLine(filePath, idx, stmt, trivia));
    return { body: { block: blockSteps, bindings }, nextIdx: idx + 1 };
  }

  if (afterBindings === "") {
    fail(filePath, `${keyword} requires a body after bindings`, innerNo, keywordCol);
  }

  const single = parseAtHostLine(filePath, idx, afterBindings, trivia);
  return { body: { single, bindings }, nextIdx: idx + 1 };
}

/**
 * Parse a single statement string as if it lived on the host line. Padded
 * lines preserve the source line number in nested error messages.
 */
function parseAtHostLine(
  filePath: string,
  hostIdx: number,
  stmt: string,
  trivia: Trivia,
): WorkflowStepDef {
  const padded = new Array<string>(hostIdx).fill("");
  padded.push(stmt);
  return parseBlockStatement(filePath, padded, hostIdx, trivia).step;
}
