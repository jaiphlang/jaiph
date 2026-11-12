// Call steps in a def body: a managed call `ref(args)` or anonymous inline
// script, each optionally followed by an attached `catch` / `recover` clause.
// Shared by the bare-call, `async`, `stdin` and `const` statement forms.

import type { Expr } from "../types";
import type { Token } from "./lexer";
import { fail, rejectTrailingContent } from "./core";
import { parseCallRef, parseCallRefMultiline } from "./call-args";
import { parseAttachedBlock } from "./attached-block";
import { adjacent, isPunct } from "./body-cursor";
import { execStep, type BlockCtx, type BlockResult } from "./block-ctx";

/**
 * A statement's first token opens an anonymous inline script: `'…'`,
 * `'''…'''`, tagged `python3'…'`, or (after a lexer stop) the rest of the
 * line starting with a quote or a removed backtick, which the inline-script
 * parser then rejects.
 */
export function isScriptHead(tok: Token | undefined): boolean {
  if (!tok) return false;
  if (tok.kind === "script_oneline" || tok.kind === "script_fenced") return true;
  return tok.kind === "other" && /^(?:['`]|[A-Za-z_][A-Za-z0-9_.-]*')/.test(tok.text);
}

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
  const { filePath, innerNo, innerRaw } = c;
  const stepLoc = { line: innerNo, col: hostCol };

  if (/\scatch$/.test(hostBody)) {
    fail(
      filePath,
      'catch requires explicit bindings and a body: catch (<name>) { ... }',
      innerNo,
      innerRaw.indexOf("catch") + 1,
    );
  }
  if (/ recover$/.test(hostBody)) {
    fail(
      filePath,
      'recover requires explicit bindings and a body: recover(<name>) { ... }',
      innerNo,
      innerRaw.indexOf("recover") + 1,
    );
  }

  let attached:
    | { keyword: "catch" | "recover"; left: string; after: string }
    | null = null;
  const m = hostBody.match(/ recover(?=[\s(])/);
  if (m) {
    const pos = m.index!;
    attached = {
      keyword: "recover",
      left: hostBody.slice(0, pos).trim(),
      after: hostBody.slice(pos + " recover".length),
    };
  }
  if (!attached) {
    const ci = hostBody.indexOf(" catch ");
    if (ci !== -1) {
      attached = {
        keyword: "catch",
        left: hostBody.slice(0, ci).trim(),
        after: hostBody.slice(ci + " catch ".length),
      };
    }
  }

  // Fall back to plain parsing when the call before catch/recover has trailing
  // content, preserving the "unexpected content" error shape.
  if (attached) {
    const probe = parseCallRef(attached.left);
    if (!probe || probe.rest.trim()) {
      attached = null;
    }
  }

  const badRef = (): never =>
    fail(
      filePath,
      `${hostName} must target a valid reference: ${hostName} ref() or ${hostName} ref(args) — parentheses are required`,
      innerNo,
    );

  if (!attached) {
    const call = parseCallRefMultiline(filePath, c.lines, c.idx, hostBody) ?? badRef();
    rejectTrailingContent(filePath, innerNo, hostName, call.rest);
    const callee = { value: call.ref, loc: stepLoc };
    const body: Expr = { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };
    return { step: execStep(body, stepLoc, { captureName, stdin }), nextIdx: call.nextLineIdx };
  }

  const call = parseCallRef(attached.left) ?? badRef();
  rejectTrailingContent(filePath, innerNo, hostName, call.rest);
  const callee = { value: call.ref, loc: stepLoc };
  const body: Expr = { kind: "call", callee, args: call.args, ...(isAsync ? { async: true as const } : {}) };

  const result = parseAttachedBlock(c, c.idx, innerNo, innerRaw, attached.keyword, attached.after);
  const extras = attached.keyword === "catch"
    ? { captureName, stdin, catch: result.body }
    : { captureName, stdin, recover: result.body };
  return { step: execStep(body, stepLoc, extras), nextIdx: result.nextIdx };
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
  result: { closingLineIdx: number; trailing: string; nextLineIdx: number },
  body: Expr,
  stepLoc: { line: number; col: number },
  hostCol: number,
  stdin?: Expr,
  captureName?: string,
): BlockResult {
  const closingRaw = c.lines[result.closingLineIdx]!;
  const closingNo = result.closingLineIdx + 1;
  const trimmed = result.trailing.trimStart();
  if (trimmed === "") {
    return { step: execStep(body, stepLoc, { stdin, captureName }), nextIdx: result.nextLineIdx };
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
      result.closingLineIdx + 1,
      hostCol,
    );
  }
  const block = parseAttachedBlock(c, result.closingLineIdx, closingNo, closingRaw, attached.keyword, attached.after);
  const extras = attached.keyword === "catch"
    ? { stdin, captureName, catch: block.body }
    : { stdin, captureName, recover: block.body };
  return { step: execStep(body, stepLoc, extras), nextIdx: block.nextIdx };
}
