import type { RuleDef } from "../types";
import { braceDepthDelta, colFromRaw, fail, stripQuotes } from "./core";
import { parseBlockStatement } from "./workflow-brace";

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
    const parensMatch = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (parensMatch) {
      fail(
        filePath,
        `definitions must not use parentheses: rule ${parensMatch[2]} { … }`,
        lineNo,
      );
    }
    const loose = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `rule declarations require braces: rule ${loose[2]} { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid rule declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const rule: RuleDef = {
    name: match[2],
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  let i = startIndex + 1;
  let braceDepth = 0;
  let currentCommandLines: string[] = [];
  let accumShellLine = lineNo;
  let accumShellCol = 1;

  const flushCommand = (): void => {
    if (currentCommandLines.length === 0) return;
    const cmd = currentCommandLines.join("\n").trim();
    currentCommandLines = [];
    if (!cmd) return;
    rule.steps.push({
      type: "shell",
      command: stripQuotes(cmd),
      loc: { line: accumShellLine, col: accumShellCol },
    });
  };

  for (; i < lines.length; i += 1) {
    const innerNo = i + 1;
    const innerRaw = lines[i];
    const inner = innerRaw.trim();
    if (!inner) {
      if (braceDepth > 0) {
        if (currentCommandLines.length === 0) {
          accumShellLine = innerNo;
          accumShellCol = colFromRaw(innerRaw);
        }
        currentCommandLines.push(innerRaw);
      } else flushCommand();
      continue;
    }
    if (inner.startsWith("#")) {
      if (braceDepth > 0) {
        if (currentCommandLines.length === 0) {
          accumShellLine = innerNo;
          accumShellCol = colFromRaw(innerRaw);
        }
        currentCommandLines.push(innerRaw.trim());
      } else {
        flushCommand();
        rule.steps.push({
          type: "comment",
          text: innerRaw.trim(),
          loc: { line: innerNo, col: 1 },
        });
      }
      continue;
    }
    if (inner === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
      if (currentCommandLines.length === 0) {
        accumShellLine = innerNo;
        accumShellCol = colFromRaw(innerRaw);
      }
      currentCommandLines.push(innerRaw.trim());
      if (braceDepth === 0) {
        flushCommand();
      }
      continue;
    }
    if (braceDepth > 0) {
      if (currentCommandLines.length === 0) {
        accumShellLine = innerNo;
        accumShellCol = colFromRaw(innerRaw);
      }
      currentCommandLines.push(innerRaw.trim());
      braceDepth += braceDepthDelta(inner);
      if (braceDepth === 0) {
        flushCommand();
      }
      continue;
    }
    const st = parseBlockStatement(filePath, lines, i, { forRule: true });
    if (st.step.type !== "shell") {
      flushCommand();
      rule.steps.push(st.step);
      i = st.nextIdx - 1;
      continue;
    }

    const delta = braceDepthDelta(inner);
    if (delta > 0) {
      accumShellLine = innerNo;
      accumShellCol = colFromRaw(innerRaw);
      currentCommandLines.push(innerRaw.trim());
      braceDepth = delta;
      if (braceDepth === 0) flushCommand();
      continue;
    }

    rule.steps.push(st.step);
    i = st.nextIdx - 1;
  }
  flushCommand();
  if (i >= lines.length) {
    fail(filePath, `unterminated rule block: ${rule.name}`, lineNo);
  }
  return { rule, nextIndex: i + 1, exported: isExported };
}
