import type { SendRhsDef, WorkflowRefDef } from "../types";
import { fail, indexOfClosingDoubleQuote, isRef } from "./core";

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
  const runM = t.match(
    /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
  );
  if (runM && isRef(runM[1])) {
    let args = runM[2]?.trim();
    if (args?.endsWith(" &")) {
      args = args.slice(0, -2).trimEnd();
    }
    const ref: WorkflowRefDef = { value: runM[1], loc: { line: lineNo, col } };
    return { kind: "run", ref, ...(args ? { args } : {}) };
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
