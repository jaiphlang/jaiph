import type { SendRhsDef, WorkflowRefDef } from "../types";
import { fail, indexOfClosingDoubleQuote, isRef, parseCallRef } from "./core";

/** Reject non-empty trailing content after a call expression (e.g. shell redirection). */
function rejectTrailingContent(
  filePath: string,
  lineNo: number,
  keyword: string,
  rest: string,
): void {
  const trimmed = rest.trim();
  if (!trimmed) return;
  fail(filePath, `unexpected content after ${keyword} call: '${trimmed}'; shell redirection (>, |, &) is not supported — use a script block`, lineNo);
}

const SEND_RHS_HINT =
  'send right-hand side must be a quoted string ("..."), a variable ($name or ${...}), or "run <ref> [args]" — not raw shell; use a script or use const';

/** Parse RHS after `<-` for the send operator. */
export function parseSendRhs(
  filePath: string,
  rhs: string,
  lineNo: number,
  col: number,
): SendRhsDef {
  const t = rhs.trim();
  if (t === "") {
    return { kind: "forward" };
  }
  if (t.startsWith('"')) {
    const close = indexOfClosingDoubleQuote(t, 1);
    if (close === -1) {
      fail(filePath, "unterminated string in send right-hand side", lineNo, col);
    }
    if (t.slice(close + 1).trim() !== "") {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    return { kind: "literal", token: t.slice(0, close + 1) };
  }
  if (t.startsWith("run ")) {
    const call = parseCallRef(t.slice("run ".length).trim());
    if (call) {
      rejectTrailingContent(filePath, lineNo, "run", call.rest);
      const ref: WorkflowRefDef = { value: call.ref, loc: { line: lineNo, col } };
      return { kind: "run", ref, ...(call.args ? { args: call.args } : {}) };
    }
  }
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    return { kind: "var", bash: t };
  }
  if (t.startsWith("${")) {
    let depth = 1;
    let i = 2;
    while (i < t.length && depth > 0) {
      const c = t[i];
      if (c === "$" && t[i + 1] === "{") {
        depth += 1;
        i += 2;
        continue;
      }
      if (c === "}") {
        depth -= 1;
        i += 1;
        continue;
      }
      i += 1;
    }
    if (depth !== 0) {
      fail(filePath, "unterminated ${...} in send right-hand side", lineNo, col);
    }
    const braced = t.slice(0, i);
    if (t.slice(i).trim() !== "") {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    if (braced.includes("$(")) {
      fail(filePath, SEND_RHS_HINT, lineNo, col);
    }
    return { kind: "var", bash: braced };
  }
  const bareWord = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/);
  if (bareWord && isRef(bareWord[1])) {
    return {
      kind: "bare_ref",
      ref: { value: bareWord[1], loc: { line: lineNo, col } },
    };
  }
  return {
    kind: "shell",
    command: t,
    loc: { line: lineNo, col },
  };
}
