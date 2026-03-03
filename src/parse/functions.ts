import type { FunctionDef } from "../types";
import { fail, stripQuotes } from "./core";

export function parseFunctionBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { fn: FunctionDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const match = line.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?\s*\{$/);
  if (!match) {
    fail(filePath, "invalid function declaration", lineNo);
  }
  const fn: FunctionDef = {
    name: match[1],
    comments: pendingComments,
    commands: [],
    loc: { line: lineNo, col: 1 },
  };

  let i = startIndex + 1;
  for (; i < lines.length; i += 1) {
    const innerNo = i + 1;
    const innerRaw = lines[i];
    const inner = innerRaw.trim();
    if (!inner) {
      continue;
    }
    if (inner === "}") {
      break;
    }
    if (inner.startsWith("#")) {
      fn.commands.push(innerRaw.trim());
      continue;
    }
    const cmd = inner.startsWith("run ") ? inner.slice("run ".length).trim() : inner;
    if (!cmd) {
      fail(filePath, "function command is required", innerNo);
    }
    fn.commands.push(stripQuotes(cmd));
  }
  if (i >= lines.length) {
    fail(filePath, `unterminated function block: ${fn.name}`, lineNo);
  }
  return { fn, nextIndex: i + 1 };
}
