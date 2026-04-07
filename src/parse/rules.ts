import type { RuleDef } from "../types";
import { braceDepthDelta, colFromRaw, fail, parseParamList, stripQuotes } from "./core";
import { parseBlockStatement } from "./workflow-brace";
import {
  expandBlockLineStatements,
  findClosingBraceIndex,
  shouldApplySemicolonStatementSplit,
  shouldSkipSemicolonSplitForLine,
} from "./statement-split";

export function parseRuleBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { rule: RuleDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const parensNoBrace = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/);
  if (parensNoBrace) {
    fail(
      filePath,
      `rule declarations require braces: rule ${parensNoBrace[2]}() { … } or rule ${parensNoBrace[2]}(params) { … }`,
      lineNo,
    );
  }

  // Match: [export] rule name() { OR [export] rule name(params) {
  const match = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/);
  if (!match) {
    const loose = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `rule declarations require parentheses: rule ${loose[2]}() { … } or rule ${loose[2]}(params) { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid rule declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const params = parseParamList(filePath, match[3], lineNo);
  const rule: RuleDef = {
    name: match[2],
    params,
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  const braceIdx = match[0].length - 1;
  if (line[braceIdx] !== "{") {
    fail(filePath, "expected '{' after rule header", lineNo);
  }
  const closeIdx = findClosingBraceIndex(line, braceIdx);
  const isInlineBody = closeIdx !== -1 && line.slice(closeIdx + 1).trim() === "";

  if (isInlineBody) {
    const bodyInner = line.slice(braceIdx + 1, closeIdx);
    const bodyLines = bodyInner.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const chunks: string[] = [];
    for (const bl of bodyLines) {
      if (shouldSkipSemicolonSplitForLine(bl)) {
        chunks.push(bl);
        continue;
      }
      const ex = expandBlockLineStatements(bl);
      if (shouldApplySemicolonStatementSplit(ex)) {
        chunks.push(...ex);
      } else {
        chunks.push(bl);
      }
    }
    for (const chunk of chunks) {
      const t = chunk.trim();
      if (!t) continue;
      if (t.startsWith("#")) {
        rule.steps.push({
          type: "comment",
          text: t,
          loc: { line: lineNo, col: 1 },
        });
        continue;
      }
      const st = parseBlockStatement(filePath, [t], 0, { forRule: true });
      rule.steps.push(st.step);
    }
    return { rule, nextIndex: startIndex + 1, exported: isExported };
  }

  if (closeIdx === -1) {
    const afterBrace = line.slice(braceIdx + 1).trim();
    if (afterBrace !== "") {
      fail(
        filePath,
        "expected newline after '{' or a complete inline rule body ending with '}' on the same line",
        lineNo,
      );
    }
  }

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
      } else {
        flushCommand();
        const lastStep = rule.steps[rule.steps.length - 1];
        if (lastStep && lastStep.type !== "blank_line") {
          rule.steps.push({ type: "blank_line" });
        }
      }
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
    if (!shouldSkipSemicolonSplitForLine(innerRaw)) {
      const expanded = expandBlockLineStatements(innerRaw);
      if (shouldApplySemicolonStatementSplit(expanded) && expanded.length > 1) {
        flushCommand();
        for (const chunk of expanded) {
          const t = chunk.trim();
          if (!t) continue;
          if (t.startsWith("#")) {
            rule.steps.push({
              type: "comment",
              text: t,
              loc: { line: innerNo, col: 1 },
            });
            continue;
          }
          const st = parseBlockStatement(filePath, [t], 0, { forRule: true });
          rule.steps.push(st.step);
        }
        continue;
      }
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
  while (rule.steps.length > 0 && rule.steps[rule.steps.length - 1].type === "blank_line") {
    rule.steps.pop();
  }
  return { rule, nextIndex: i + 1, exported: isExported };
}
