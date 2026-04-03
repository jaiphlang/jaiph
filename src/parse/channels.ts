import type { ChannelDef, WorkflowRefDef } from "../types";
import { fail, isRef } from "./core";

export function parseChannelLine(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
): ChannelDef {
  // Match: channel <name> [-> target1, target2, ...]
  const match = line.match(/^channel\s+([A-Za-z_][A-Za-z0-9_]*)(\s+->.*)?$/);
  if (!match) {
    fail(
      filePath,
      'invalid channel declaration; expected: channel <name> or channel <name> -> <workflow>',
      lineNo,
      1,
    );
  }
  const name = match[1];
  const routePart = match[2];

  if (!routePart) {
    return {
      name,
      loc: { line: lineNo, col: raw.indexOf(name) + 1 },
    };
  }

  // Parse -> targets
  const arrowIdx = routePart.indexOf("->");
  const targetsStr = routePart.slice(arrowIdx + 2).trim();
  if (!targetsStr) {
    fail(filePath, "channel route requires at least one target workflow after ->", lineNo, 1);
  }
  const targetNames = targetsStr.split(/\s*,\s*/);
  const routes: WorkflowRefDef[] = targetNames.map((t) => {
    const trimmed = t.trim();
    if (!trimmed || !isRef(trimmed)) {
      fail(filePath, `invalid workflow reference in channel route: "${trimmed}"`, lineNo, 1);
    }
    return { value: trimmed, loc: { line: lineNo, col: raw.indexOf(trimmed) + 1 } };
  });

  return {
    name,
    routes,
    loc: { line: lineNo, col: raw.indexOf(name) + 1 },
  };
}
