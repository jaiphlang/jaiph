// Call steps in a def body: a managed call `ref(args)` or anonymous inline
// script, each optionally followed by an attached `catch` / `recover` clause.
// Shared by the bare-call, `async`, `stdin` and `const` statement forms.

import type { Expr } from "../types";
import type { Token } from "./lexer";
import { fail, rejectTrailingContent } from "./core";
import { parseCallRef, parseCallRefMultiline } from "./call-args";
import { parseAttachedBlock } from "./attached-block";
import { adjacent, isPunct } from "./body-cursor";
import { execStep, firstCol, type BlockCtx, type BlockResult } from "./block-ctx";
import { SliceLexer } from "./slice-lexer";

export { isScriptHead } from "./slice-lexer";

/**
 * Tokens from index `from` start a call: `ident(.ident)*` written without
 * spaces (at most `maxDots` dots), then `(`.
 */
export function isCallShaped(tokens: Token[], from = 0, maxDots = Infinity): boolean {
  let i = from;
  if (tokens[i]?.kind !== "ident") return false;
  while (
    i - from < 2 * maxDots &&
    isPunct(tokens[i + 1], ".") &&
    adjacent(tokens[i]!, tokens[i + 1]!) &&
    tokens[i + 2]?.kind === "ident" &&
    adjacent(tokens[i + 1]!, tokens[i + 2]!)
  ) {
    i += 2;
  }
  return isPunct(tokens[i + 1], "(");
}

type Clause = { keyword: "catch" | "recover"; left: string; after: string };

/**
 * The attached `recover` / `catch` clause on call text `hostBody`, read from
 * its tokens. The first ` recover` (then, when there is none, the first
 * ` catch `) decides, even one written inside a quoted argument or after
 * another clause: the text before it must then be exactly one call, or the
 * statement has no clause and the call's trailing-content check reports it.
 */
function findClause(filePath: string, line: number, hostBody: string): Clause | null {
  const L = new SliceLexer(filePath, hostBody, line, 1, 0);
  const toks = L.all(0, { triple: "pair" });
  const spaceBefore = (tok: Token): boolean => hostBody[L.rel(tok) - 1] === " ";
  const find = (keyword: Clause["keyword"], after: RegExp, inside: RegExp): Clause | null | undefined => {
    for (const tok of toks) {
      const next = hostBody[L.end(tok)] ?? "";
      if (tok.kind === "ident" && tok.text === keyword && spaceBefore(tok) && after.test(next)) {
        const left = hostBody.slice(0, L.rel(tok) - 1).trim();
        const probe = parseCallRef(left);
        if (!probe || probe.rest.trim()) return null;
        return { keyword, left, after: hostBody.slice(L.end(tok) + (keyword === "catch" ? 1 : 0)) };
      }
      // Inside a quoted token the text before it never closes as a call.
      if (inside.test(tok.text + next)) return null;
    }
    return undefined;
  };
  const recover = find("recover", /^[\s(]/, / recover[\s(]/);
  if (recover !== undefined) return recover;
  return find("catch", /^ /, / catch /) ?? null;
}

/** `hostBody` ends with the clause keyword alone (a space or, for `catch`, any whitespace before it). */
function endsWithBareKeyword(filePath: string, line: number, hostBody: string, keyword: "catch" | "recover"): boolean {
  const L = new SliceLexer(filePath, hostBody, line, 1, 0);
  const toks = L.all(0, { triple: "pair" });
  const last = toks[toks.length - 1];
  if (!last) return false;
  const before = keyword === "catch" ? /\s/ : / /;
  if (last.kind === "ident" && last.text === keyword) return before.test(hostBody[L.rel(last) - 1] ?? "");
  return new RegExp(`${before.source}${keyword}$`).test(last.text);
}

/**
 * Parse a call statement `<ref>(args)` (or `async <ref>(args)`),
 * optionally followed by `catch (binding) { ... }` or `recover(binding) { ... }`.
 *
 * `hostBody` is the invoke text with no leading keyword. `stdin`, when set, is
 * the value already parsed from a leading `stdin <expr> -> ` connect clause and
 * carried onto the resulting exec step. `hostName` / `hostCol` name and locate
 * the form for error messages.
 *
 * The catch/recover clause is parsed via the unified `parseAttachedBlock`, whose
 * body uses the same statement parser as the top-level dispatcher.
 */
export function parseCallStatement(
  c: BlockCtx,
  hostBody: string,
  isAsync: boolean,
  captureName: string | undefined,
  stdin: Expr | undefined,
  hostName: string,
  hostCol: number,
): BlockResult {
  const { filePath, innerNo } = c;
  const stepLoc = { line: innerNo, col: hostCol };

  if (endsWithBareKeyword(filePath, innerNo, hostBody, "catch")) {
    fail(filePath, 'catch requires explicit bindings and a body: catch (<name>) { ... }', innerNo, firstCol(c, "catch"));
  }
  if (endsWithBareKeyword(filePath, innerNo, hostBody, "recover")) {
    fail(filePath, 'recover requires explicit bindings and a body: recover(<name>) { ... }', innerNo, firstCol(c, "recover"));
  }

  // Without a clause (or when the text before it is not one call) the call is
  // parsed alone, so trailing content gets the "unexpected content" error.
  const attached = findClause(filePath, innerNo, hostBody);

  const badRef = (): never =>
    fail(
      filePath,
      `${hostName} must target a valid reference: ${hostName} ref() or ${hostName} ref(args) — parentheses are required`,
      innerNo,
    );

  if (!attached) {
    const call = parseCallRefMultiline(c.cursor, c.at, hostBody) ?? badRef();
    rejectTrailingContent(filePath, innerNo, hostName, call.rest);
    const callee = { value: call.ref, loc: stepLoc };
    const body: Expr = { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };
    return { step: execStep(body, stepLoc, { captureName, stdin }), next: call.next };
  }

  const call = parseCallRef(attached.left) ?? badRef();
  rejectTrailingContent(filePath, innerNo, hostName, call.rest);
  const callee = { value: call.ref, loc: stepLoc };
  const body: Expr = { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };

  const result = parseAttachedBlock(c, c.at, innerNo, attached.keyword, attached.after);
  const extras = attached.keyword === "catch"
    ? { captureName, stdin, catch: result.body }
    : { captureName, stdin, recover: result.body };
  return { step: execStep(body, stepLoc, extras), next: result.next };
}

/**
 * After a bare `` 'body'(args) `` / `'''...'''(args)` inline script,
 * optionally parse an attached `catch (...) { ... }` or `recover(...) { ... }`
 * clause. Same semantics and bindings as a named-ref call. `recover` and
 * `catch` are mutually exclusive — when both appear on the same step the
 * leftover keyword falls through and is rejected with the existing "unexpected
 * content after anonymous inline script" error. `stdin` / `captureName` are
 * carried through from a leading `stdin` connect or `const` binding.
 */
export function parseInlineScriptTail(
  c: BlockCtx,
  result: { closingAt: number; trailing: string; next: number },
  body: Expr,
  stepLoc: { line: number; col: number },
  hostCol: number,
  stdin?: Expr,
  captureName?: string,
): BlockResult {
  const closingNo = c.cursor.lineNo(result.closingAt);
  const trimmed = result.trailing.trimStart();
  if (trimmed === "") {
    return { step: execStep(body, stepLoc, { stdin, captureName }), next: result.next };
  }
  const recoverMatch = trimmed.match(/^recover([\s(].*)$/s);
  const catchMatch = trimmed.match(/^catch(\s.*)$/s);
  const attached =
    recoverMatch !== null
      ? { keyword: "recover" as const, after: recoverMatch[1] }
      : catchMatch !== null
        ? { keyword: "catch" as const, after: catchMatch[1] }
        : null;
  if (!attached) {
    fail(
      c.filePath,
      `unexpected content after anonymous inline script: '${trimmed}'`,
      closingNo,
      hostCol,
    );
  }
  const block = parseAttachedBlock(c, result.closingAt, closingNo, attached.keyword, attached.after);
  const extras = attached.keyword === "catch"
    ? { stdin, captureName, catch: block.body }
    : { stdin, captureName, recover: block.body };
  return { step: execStep(body, stepLoc, extras), next: block.next };
}
