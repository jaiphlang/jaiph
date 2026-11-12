// Nested declarations in a def body (`script`, `def`, a def-level `config`
// block; nested `prompt name(…) =` lives with the prompt step in stmt-say.ts),
// and the guards that reject forms
// that are not statements: removed keywords, module-level forms, routes,
// assignments without `const`, and the removed `channel <- payload` send.

import type { Def } from "../types";
import { colFromRaw, fail, matchLegacySendOperator } from "./core";
import { parseScriptBlock } from "./scripts";
import { parseConfigBlock } from "./metadata";
import { parseDefHeader, stripTrailingBlankLines } from "./def-header";
import { startsInlineScript } from "./fence";
import { adjacent, isPunct, keyOf } from "./body-cursor";
import { afterKeyword, isKeywordForm, localDeclStep, type BlockCtx, type BlockResult } from "./block-ctx";

/**
 * `export` on a nested `script` / `def` / `prompt` is rejected: nested
 * declarations are private to the enclosing def. Any other `export` line
 * is not a statement.
 */
export function tryParseExportInDef(c: BlockCtx): BlockResult | null {
  const kind = keyOf(c.tokens[1]);
  if (c.tokens[0]!.kind !== "ident" || (kind !== "script" && kind !== "def" && kind !== "prompt")) return null;
  fail(
    c.filePath,
    `nested ${kind} declarations cannot be exported; drop 'export' (nested declarations are private to the enclosing def)`,
    c.innerNo,
    c.tokens[0]!.col,
  );
}

/** Nested `script name [use …] = …` declaration, local to the enclosing def. */
export function tryParseLocalScript(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "script")) return null;
  const { scriptDef, nextIndex } = parseScriptBlock(c.filePath, c.lines, c.idx, [], c.trivia);
  const loc = { line: c.innerNo, col: c.tokens[0]!.col };
  return { step: localDeclStep(c.filePath, { kind: "script", script: scriptDef }, loc), nextIdx: nextIndex };
}

/** Nested `def name(params) { … }` declaration, local to the enclosing def. */
export function tryParseLocalDef(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "def")) return null;
  const lineNo = c.innerNo;
  const header = parseDefHeader(c.filePath, c.innerRaw, lineNo);
  const loc = { line: lineNo, col: c.tokens[0]!.col };
  const def: Def = { name: header.name, params: header.params, comments: [], steps: [], loc };
  const { steps, nextIdx } = c.parse.body(c, c.idx + 1, lineNo, { preserveBlankLines: true, inNestedDef: true });
  def.steps.push(...steps);
  stripTrailingBlankLines(def.steps);
  return { step: localDeclStep(c.filePath, { kind: "def", def }, loc), nextIdx };
}

export function tryParseWait(c: BlockCtx): BlockResult | null {
  if (c.tokens[0]!.kind !== "ident" || afterKeyword(c) !== "") return null;
  fail(c.filePath, '"wait" has been removed from the language', c.innerNo, c.tokens[0]!.col);
}

export function tryParseEnsureRemoved(c: BlockCtx): BlockResult | null {
  if (!isKeywordForm(c, "ensure")) return null;
  fail(
    c.filePath,
    "'ensure' is not a keyword; call the target directly (e.g. name(args))",
    c.innerNo,
    c.tokens[0]!.col,
  );
}

/**
 * A def-level `config { … }` block (only where `opts.onConfigBlock` allows
 * it, before any step). Returns the line after the block, or null when the
 * line is not a config block.
 */
export function tryConfigBlock(c: BlockCtx, hadNonCommentStep: boolean): number | null {
  const head = c.tokens[0];
  if (!c.opts?.onConfigBlock || head?.kind !== "ident" || head.text !== "config" || !isPunct(c.tokens[1], "{")) {
    return null;
  }
  if (hadNonCommentStep) {
    fail(c.filePath, "config block inside def must appear before any steps", c.innerNo);
  }
  const { metadata, nextIndex } = parseConfigBlock(c.filePath, c.lines, c.idx, c.trivia);
  c.opts.onConfigBlock(metadata, c.innerNo);
  return nextIndex;
}

/**
 * Tombstone: `run` is no longer the invoke keyword. `run(...)` / bare `run`
 * fall through so a symbol literally named `run` can still be called; anything
 * else that begins `run <…>` is the removed keyword form and is `E_PARSE`.
 */
export function tryParseRunKeywordRemoved(c: BlockCtx): BlockResult | null {
  const head = c.tokens[0]!;
  if (head.kind === "ident" && (c.tokens.length === 1 || isPunct(c.tokens[1], "("))) return null;
  fail(
    c.filePath,
    "'run' is not a keyword; call the target directly (e.g. name(args)) instead of 'run name(args)'",
    c.innerNo,
    head.col,
  );
}

/** Reject module-level forms that would otherwise become `sh -c` inside a nested def. */
export function rejectNestedModuleForms(c: BlockCtx): void {
  if (!c.opts?.inNestedDef) return;
  const head = c.tokens[0];
  if (head?.kind === "ident" && head.text === "config" && isPunct(c.tokens[1], "{")) {
    fail(
      c.filePath,
      "config blocks are not allowed inside a nested def; move config to the top of the enclosing def or module",
      c.innerNo,
      head.col,
    );
  }
  if (keyOf(head) === "import") {
    fail(
      c.filePath,
      "import declarations are not allowed inside a nested def; move the import to the top of the file",
      c.innerNo,
      head!.col,
    );
  }
}

/**
 * Reject a route declaration (`name -> target`) in a body: routes belong at
 * the top of the file. `send … -> channel` is a send statement, not a route.
 */
export function rejectRouteDeclaration(c: BlockCtx): void {
  const toks = c.tokens;
  if (toks[0]?.kind !== "ident") return;
  let nameEnd = 0;
  if (isPunct(toks[1], ".") && adjacent(toks[0], toks[1]!) && toks[2]?.kind === "ident" && adjacent(toks[1]!, toks[2])) {
    nameEnd = 2;
  }
  const arrow = toks[nameEnd + 1];
  const target = toks[nameEnd + 2];
  if (!isPunct(arrow, "->") || !target || adjacent(toks[nameEnd]!, arrow!) || adjacent(arrow!, target)) return;
  const name = c.innerRaw.slice(toks[0].col - 1, toks[nameEnd]!.col - 1 + toks[nameEnd]!.text.length);
  if (name === "send") return;
  const rest = c.innerRaw.slice(arrow!.col + 1).trim();
  fail(c.filePath, `route declarations belong at the top level: channel ${name} -> ${rest}`, c.innerNo);
}

/** Error guards for assignment-shape lines. Emit a fail() or no-op; never return a step. */
export function applyAssignmentGuards(c: BlockCtx): void {
  if (c.tokens[0]?.kind !== "ident" || c.tokens[1]?.kind !== "punct" || !c.tokens[1].text.startsWith("=")) return;
  const promptAssign = c.inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s);
  if (promptAssign) {
    fail(
      c.filePath,
      'use "const name = prompt ..." to capture the prompt result (e.g. const answer = prompt "..." )',
      c.innerNo,
      c.innerRaw.indexOf(promptAssign[1]) + 1,
    );
  }
  const generic = c.inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
  if (
    generic &&
    !generic[2].trimStart().startsWith("prompt ") &&
    !generic[2].trimStart().startsWith('"') &&
    !generic[2].trimStart().startsWith("$")
  ) {
    const captureName = generic[1];
    const rest = generic[2].trim();
    if (rest.startsWith("send ") || rest === "send") {
      fail(
        c.filePath,
        "use 'send <payload> -> <channel>'",
        c.innerNo,
        c.innerRaw.indexOf(captureName) + 1,
      );
    }
    const looksInvoke =
      rest.startsWith("run ") ||
      rest.startsWith("ensure ") ||
      rest.startsWith("async ") ||
      rest.startsWith("stdin ") ||
      startsInlineScript(rest) ||
      /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*\(/.test(rest);
    if (looksInvoke) {
      fail(
        c.filePath,
        `assignment without "const" is no longer supported; use "const ${captureName} = ${rest}"`,
        c.innerNo,
        c.innerRaw.indexOf(captureName) + 1,
      );
    }
  }
}

/** The removed `channel <- payload` send form. */
export function tryLegacySend(c: BlockCtx): BlockResult | null {
  if (!matchLegacySendOperator(c.inner)) return null;
  fail(c.filePath, "use 'send <payload> -> <channel>'", c.innerNo);
}

export function rejectNonStatement(c: BlockCtx): never {
  fail(c.filePath, "not a statement; put the command in a script", c.innerNo, colFromRaw(c.innerRaw));
}
