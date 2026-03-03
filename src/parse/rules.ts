import type { RuleDef } from "../types";
import { fail, stripQuotes } from "./core";

export function parseRuleBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { rule: RuleDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const match = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  if (!match) {
    fail(filePath, "invalid rule declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const rule: RuleDef = {
    name: match[2],
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
      rule.commands.push(innerRaw.trim());
      continue;
    }
    if (inner.startsWith("run ")) {
      fail(
        filePath,
        "`run` is not allowed inside a `rule` block.\nUse `ensure` to call another rule, or move this call to a `workflow`.",
        innerNo,
        innerRaw.indexOf("run") + 1,
      );
    }
    const cmd = inner;
    if (!cmd) {
      fail(filePath, "rule command is required", innerNo);
    }
    rule.commands.push(stripQuotes(cmd));
  }
  if (i >= lines.length) {
    fail(filePath, `unterminated rule block: ${rule.name}`, lineNo);
  }
  return { rule, nextIndex: i + 1, exported: isExported };
}
