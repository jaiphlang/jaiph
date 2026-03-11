import type { FunctionDef } from "../types";
import { braceDepthDelta, fail, stripQuotes } from "./core";

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
  let braceDepth = 0;
  let currentCommandLines: string[] = [];

  const flushCommand = (): void => {
    if (currentCommandLines.length === 0) return;
    const cmd = currentCommandLines.join("\n").trim();
    currentCommandLines = [];
    if (!cmd) return;
    fn.commands.push(stripQuotes(cmd));
  };

  for (; i < lines.length; i += 1) {
    const innerNo = i + 1;
    const innerRaw = lines[i];
    const inner = innerRaw.trim();
    if (!inner) {
      if (braceDepth > 0) currentCommandLines.push(innerRaw);
      else flushCommand();
      continue;
    }
    if (inner.startsWith("#")) {
      if (braceDepth > 0) currentCommandLines.push(innerRaw);
      else {
        flushCommand();
        fn.commands.push(innerRaw.trim());
      }
      continue;
    }
    if (inner === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
      currentCommandLines.push(innerRaw.trim());
      if (braceDepth === 0) flushCommand();
      continue;
    }
    if (braceDepth > 0) {
      currentCommandLines.push(innerRaw.trim());
      braceDepth += braceDepthDelta(inner);
      if (braceDepth === 0) flushCommand();
      continue;
    }
    const delta = braceDepthDelta(inner);
    if (delta > 0) {
      currentCommandLines.push(innerRaw.trim());
      braceDepth = delta;
      if (braceDepth === 0) flushCommand();
      continue;
    }
    const cmd = inner.startsWith("run ") ? inner.slice("run ".length).trim() : inner;
    if (!cmd) {
      fail(filePath, "function command is required", innerNo);
    }
    fn.commands.push(stripQuotes(cmd));
  }
  flushCommand();
  if (i >= lines.length) {
    fail(filePath, `unterminated function block: ${fn.name}`, lineNo);
  }
  return { fn, nextIndex: i + 1 };
}
