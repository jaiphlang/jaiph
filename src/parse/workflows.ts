import type { WorkflowDef, WorkflowRouteDef } from "../types";
import { braceDepthDelta, colFromRaw, fail, hasUnescapedClosingQuote, indexOfClosingDoubleQuote, isRef } from "./core";

/**
 * Match `-> channel` send operator in a line, only when `->` appears outside quoted strings.
 * Returns { command, channel } if matched, or null.
 */
function matchSendOperator(line: string): { command: string; channel: string } | null {
  // Walk the line tracking quote state; find `->` outside quotes.
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && (inDoubleQuote || inSingleQuote)) {
      i += 1; // skip escaped char
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === "-" && line[i + 1] === ">") {
      // Require whitespace before -> (or start of line) and whitespace after ->
      const before = line.slice(0, i).trimEnd();
      const after = line.slice(i + 2).trimStart();
      // Channel must be a valid identifier
      const channelMatch = after.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (channelMatch) {
        return { command: before, channel: channelMatch[1] };
      }
    }
  }
  return null;
}

/**
 * Split raw prompt literal (opening " to closing ") and optional `returns '...'` / `returns "..."`.
 * Consumes line continuation (trailing \) after the closing quote.
 * Returns promptRaw (including quotes), optional returns schema string, and next line index.
 */
function splitPromptAndReturns(
  filePath: string,
  lineNo: number,
  rawPrompt: string,
  lines: string[],
  lineIndexAfterPrompt: number,
): { promptRaw: string; returns?: string; nextIndex: number } {
  const openIdx = rawPrompt.indexOf('"');
  if (openIdx === -1) {
    fail(filePath, "unterminated prompt string", lineNo, 1);
  }
  const closeIdx = indexOfClosingDoubleQuote(rawPrompt, openIdx + 1);
  if (closeIdx === -1) {
    fail(filePath, "unterminated prompt string", lineNo, 1);
  }
  const promptRaw = rawPrompt.slice(0, closeIdx + 1);
  let rest = rawPrompt.slice(closeIdx + 1);
  let nextIdx = lineIndexAfterPrompt;
  while (nextIdx + 1 < lines.length && /\\\s*$/.test(rest.trimEnd())) {
    rest += "\n" + lines[nextIdx + 1].replace(/\\\s*$/, "").trimStart();
    nextIdx += 1;
  }
  let trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { promptRaw, nextIndex: nextIdx + 1 };
  }
  const returnsMatch = trimmed.match(/^returns\s+([\'"])/);
  if (!returnsMatch) {
    fail(
      filePath,
      'after prompt string expected keyword "returns" with quoted schema (e.g. returns \'{ type: string }\') or end of line',
      lineNo,
      1,
    );
  }
  const quoteChar = returnsMatch[1];
  let contentStart = trimmed.indexOf(quoteChar) + 1;
  let contentEnd = -1;
  while (true) {
    for (let i = contentStart; i < trimmed.length; i += 1) {
      if (trimmed[i] === quoteChar && trimmed[i - 1] !== "\\") {
        contentEnd = i;
        break;
      }
    }
    if (contentEnd >= 0) break;
    if (nextIdx + 1 >= lines.length) break;
    rest += "\n" + lines[nextIdx + 1];
    nextIdx += 1;
    trimmed = rest.trim();
    contentStart = trimmed.indexOf(quoteChar) + 1;
  }
  if (contentEnd === -1) {
    fail(filePath, "unterminated returns schema string", lineNo, 1);
  }
  const returnsContent = trimmed.slice(contentStart, contentEnd).replace(/\\'/g, "'").replace(/\\"/g, '"');
  return { promptRaw, returns: returnsContent, nextIndex: nextIdx + 1 };
}

/** Parse a single workflow statement string (e.g. "run foo", "ensure bar", "echo x") into a step. */
function parseRecoverStatement(
  filePath: string,
  lineNo: number,
  col: number,
  stmt: string,
): import("../types").WorkflowStepDef {
  const t = stmt.trim();
  if (!t) {
    fail(filePath, "empty recover statement", lineNo, col);
  }
  const genericAssignMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
  if (
    genericAssignMatch &&
    !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
    !genericAssignMatch[2].trimStart().startsWith('"') &&
    !genericAssignMatch[2].trimStart().startsWith("'") &&
    !genericAssignMatch[2].trimStart().startsWith("$")
  ) {
    const captureName = genericAssignMatch[1];
    const rest = genericAssignMatch[2].trim();
    const runMatch = rest.match(
      /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
    );
    if (runMatch && isRef(runMatch[1])) {
      return {
        type: "run",
        workflow: { value: runMatch[1], loc: { line: lineNo, col } },
        args: runMatch[2]?.trim(),
        captureName,
      };
    }
    const ensureMatch = rest.match(
      /^ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
    );
    if (ensureMatch && isRef(ensureMatch[1])) {
      return {
        type: "ensure",
        ref: { value: ensureMatch[1], loc: { line: lineNo, col } },
        args: ensureMatch[2]?.trim(),
        captureName,
      };
    }
    return {
      type: "shell",
      command: rest,
      loc: { line: lineNo, col },
      captureName,
    };
  }
  const runMatch = t.match(
    /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
  );
  if (runMatch && isRef(runMatch[1])) {
    return {
      type: "run",
      workflow: { value: runMatch[1], loc: { line: lineNo, col } },
      args: runMatch[2]?.trim(),
    };
  }
  const ensureMatch = t.match(
    /^ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
  );
  if (ensureMatch && isRef(ensureMatch[1])) {
    return {
      type: "ensure",
      ref: { value: ensureMatch[1], loc: { line: lineNo, col } },
      args: ensureMatch[2]?.trim(),
    };
  }
  const promptAssignMatch = t.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
  );
  if (promptAssignMatch) {
    const captureName = promptAssignMatch[1];
    const promptArg = promptAssignMatch[2].trimStart();
    const promptCol = col + t.indexOf("prompt");
    if (!promptArg.startsWith(`"`)) {
      fail(filePath, 'prompt must match: name = prompt "<text>"', lineNo, promptCol);
    }
    const { promptRaw, returns: returnsSchema } = splitPromptAndReturns(
      filePath,
      lineNo,
      promptArg,
      [],
      lineNo - 1,
    );
    return {
      type: "prompt",
      raw: promptRaw,
      loc: { line: lineNo, col: promptCol },
      captureName,
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
  }
  if (t.startsWith("prompt ")) {
    const promptArg = t.slice("prompt ".length).trimStart();
    const promptCol = col + t.indexOf("prompt");
    if (!promptArg.startsWith(`"`)) {
      fail(filePath, 'prompt must match: prompt "<text>"', lineNo, promptCol);
    }
    const { promptRaw, returns: returnsSchema } = splitPromptAndReturns(
      filePath,
      lineNo,
      promptArg,
      [],
      lineNo - 1,
    );
    return {
      type: "prompt",
      raw: promptRaw,
      loc: { line: lineNo, col: promptCol },
      ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
    };
  }
  return {
    type: "shell",
    command: t,
    loc: { line: lineNo, col },
  };
}

export function parseWorkflowBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { workflow: WorkflowDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const rawDecl = lines[startIndex];
  const lineDecl = rawDecl.trim();

  const match = lineDecl.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  if (!match) {
    fail(filePath, "invalid workflow declaration", lineNo);
  }
  const isExported = Boolean(match[1]);
  const workflow: WorkflowDef = {
    name: match[2],
    comments: pendingComments,
    steps: [],
    loc: { line: lineNo, col: 1 },
  };

  let idx = startIndex + 1;
  let braceDepth = 0;
  let shellAccumulator: string[] = [];
  let shellAccumulatorStartLine = 0;

  const flushShellAccumulator = (): void => {
    if (shellAccumulator.length === 0) return;
    const command = shellAccumulator.join("\n").trim();
    shellAccumulator = [];
    // Check for send operator on accumulated multiline shell command.
    const sendMatch = matchSendOperator(command);
    if (sendMatch) {
      workflow.steps.push({
        type: "send",
        command: sendMatch.command,
        channel: sendMatch.channel,
        loc: { line: shellAccumulatorStartLine, col: 1 },
      });
      return;
    }
    workflow.steps.push({
      type: "shell",
      command,
      loc: { line: shellAccumulatorStartLine, col: 1 },
    });
  };

  for (; idx < lines.length; idx += 1) {
    const innerNo = idx + 1;
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    if (!inner) {
      if (braceDepth > 0) shellAccumulator.push(innerRaw.trim());
      else flushShellAccumulator();
      continue;
    }
    if (inner === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
      shellAccumulator.push(innerRaw.trim());
      if (braceDepth === 0) flushShellAccumulator();
      continue;
    }
    if (inner.startsWith("#")) {
      if (braceDepth > 0) shellAccumulator.push(innerRaw.trim());
      else {
        flushShellAccumulator();
        workflow.steps.push({
          type: "shell",
          command: innerRaw.trim(),
          loc: { line: innerNo, col: 1 },
        });
      }
      continue;
    }
    if (braceDepth > 0) {
      shellAccumulator.push(innerRaw.trim());
      braceDepth += braceDepthDelta(inner);
      if (braceDepth === 0) flushShellAccumulator();
      continue;
    }

    const ifNegEnsureMatch = inner.match(
      /^if\s+!\s*ensure\s+(.+?)\s*;\s*then$/,
    );
    const ifPosEnsureMatch = !ifNegEnsureMatch
      ? inner.match(/^if\s+ensure\s+(.+?)\s*;\s*then$/)
      : null;
    const ifEnsureBody = ifNegEnsureMatch?.[1] ?? ifPosEnsureMatch?.[1];
    const isNegated = !!ifNegEnsureMatch;
    if (ifEnsureBody) {
      const ensureBodyMatch = ifEnsureBody.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
      );
      if (!ensureBodyMatch || !isRef(ensureBodyMatch[1])) {
        fail(filePath, "invalid ensure reference in if-ensure statement", innerNo);
      }
      const ensureRef = ensureBodyMatch[1];
      const ensureArgs = ensureBodyMatch[2]?.trim();
      type IfEnsureStep =
        | { type: "shell"; command: string; loc: { line: number; col: number }; captureName?: string }
        | { type: "run"; workflow: { value: string; loc: { line: number; col: number } }; args?: string; captureName?: string }
        | { type: "prompt"; raw: string; loc: { line: number; col: number }; captureName?: string; returns?: string };
      let fiLine = -1;
      let inElse = false;
      const thenSteps: IfEnsureStep[] = [];
      const elseSteps: IfEnsureStep[] = [];
      for (let lookahead = idx + 1; lookahead < lines.length; lookahead += 1) {
        const lookNo = lookahead + 1;
        const lookRaw = lines[lookahead];
        const lookTrim = lookRaw.trim();
        if (!lookTrim || lookTrim.startsWith("#")) {
          continue;
        }
        if (lookTrim === "fi") {
          fiLine = lookahead;
          break;
        }
        if (lookTrim === "else") {
          if (inElse) {
            fail(filePath, "duplicate else in if-ensure block", lookNo);
          }
          inElse = true;
          continue;
        }
        const target = inElse ? elseSteps : thenSteps;
        const genericAssignMatch = lookTrim.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
        if (
          genericAssignMatch &&
          !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
          !genericAssignMatch[2].trimStart().startsWith('"') &&
          !genericAssignMatch[2].trimStart().startsWith("'") &&
          !genericAssignMatch[2].trimStart().startsWith("$")
        ) {
          const captureName = genericAssignMatch[1];
          const rest = genericAssignMatch[2].trim();
          const runMatch = rest.match(
            /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
          );
          if (runMatch && isRef(runMatch[1])) {
            target.push({
              type: "run",
              workflow: { value: runMatch[1], loc: { line: lookNo, col: lookRaw.indexOf("run") + 1 } },
              args: runMatch[2]?.trim(),
              captureName,
            });
            continue;
          }
          target.push({
            type: "shell",
            command: rest,
            loc: { line: lookNo, col: colFromRaw(lookRaw) },
            captureName,
          });
          continue;
        }
        const runMatch = lookTrim.match(
          /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (runMatch) {
          target.push({
            type: "run",
            workflow: {
              value: runMatch[1],
              loc: { line: lookNo, col: lines[lookahead].indexOf("run") + 1 },
            },
            args: runMatch[2]?.trim(),
          });
          continue;
        }
        const promptAssignMatch = lookTrim.match(
          /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
        );
        if (promptAssignMatch) {
          const captureName = promptAssignMatch[1];
          let promptArg = promptAssignMatch[2].trimStart();
          const promptCol = lookRaw.indexOf("prompt") + 1;
          if (!promptArg.startsWith(`"`)) {
            fail(filePath, 'prompt must match: name = prompt "<text>"', lookNo, promptCol);
          }
          let rawPrompt = promptArg;
          if (!hasUnescapedClosingQuote(promptArg, 1)) {
            let closed = false;
            for (let la = lookahead + 1; la < lines.length; la += 1) {
              rawPrompt += `\n${lines[la]}`;
              if (hasUnescapedClosingQuote(lines[la], 0)) {
                lookahead = la;
                closed = true;
                break;
              }
            }
            if (!closed) {
              fail(filePath, "unterminated prompt string", lookNo, promptCol);
            }
          }
          const { promptRaw, returns: returnsSchema, nextIndex: nextIdx } = splitPromptAndReturns(
            filePath,
            lookNo,
            rawPrompt,
            lines,
            lookahead,
          );
          lookahead = nextIdx - 1;
          target.push({
            type: "prompt",
            raw: promptRaw,
            loc: { line: lookNo, col: promptCol },
            captureName,
            ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
          });
          continue;
        }
        if (lookTrim.startsWith("prompt ")) {
          const promptCol = lookRaw.indexOf("prompt") + 1;
          let promptArg = lookRaw.slice(lookRaw.indexOf("prompt") + "prompt".length).trimStart();
          if (!promptArg.startsWith(`"`)) {
            fail(filePath, 'prompt must match: prompt "<text>"', lookNo, promptCol);
          }
          let rawPrompt = promptArg;
          if (!hasUnescapedClosingQuote(promptArg, 1)) {
            let closed = false;
            for (let la = lookahead + 1; la < lines.length; la += 1) {
              rawPrompt += `\n${lines[la]}`;
              if (hasUnescapedClosingQuote(lines[la], 0)) {
                lookahead = la;
                closed = true;
                break;
              }
            }
            if (!closed) {
              fail(filePath, "unterminated prompt string", lookNo, promptCol);
            }
          }
          const { promptRaw, returns: returnsSchema, nextIndex: nextIdx } = splitPromptAndReturns(
            filePath,
            lookNo,
            rawPrompt,
            lines,
            lookahead,
          );
          lookahead = nextIdx - 1;
          target.push({
            type: "prompt",
            raw: promptRaw,
            loc: { line: lookNo, col: promptCol },
            ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
          });
          continue;
        }
        if (/^\s*ensure\b/.test(lookTrim)) {
          fail(filePath, 'E_PARSE "ensure" is not allowed inside an if-ensure then/else branch', lookNo);
        }
        target.push({
          type: "shell",
          command: lookTrim,
          loc: { line: lookNo, col: colFromRaw(lookRaw) },
        });
      }
      if (fiLine === -1) {
        fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
      }
      if (thenSteps.length === 0) {
        fail(filePath, "if-block then-branch must contain at least one run or shell command", innerNo);
      }
      const ensureRefDef = { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } };
      const hasElse = elseSteps.length > 0;
      if (!isNegated) {
        workflow.steps.push({
          type: "if_ensure_then",
          ensureRef: ensureRefDef,
          args: ensureArgs,
          thenSteps,
          ...(hasElse ? { elseSteps } : {}),
        });
      } else if (hasElse) {
        workflow.steps.push({
          type: "if_not_ensure_then",
          ensureRef: ensureRefDef,
          args: ensureArgs,
          thenSteps,
          elseSteps,
        });
      } else if (
        thenSteps.every((step) => step.type === "run")
      ) {
        workflow.steps.push({
          type: "if_not_ensure_then_run",
          ensureRef: ensureRefDef,
          args: ensureArgs,
          runWorkflows: thenSteps.map((step) => {
            const runStep = step as {
              type: "run";
              workflow: { value: string; loc: { line: number; col: number } };
              args?: string;
            };
            return { workflow: runStep.workflow, args: runStep.args };
          }),
        });
      } else if (
        thenSteps.every((step) => step.type === "shell")
      ) {
        workflow.steps.push({
          type: "if_not_ensure_then_shell",
          ensureRef: ensureRefDef,
          args: ensureArgs,
          commands: thenSteps.map((step) => (step as { type: "shell"; command: string; loc: { line: number; col: number } })),
        });
      } else {
        workflow.steps.push({
          type: "if_not_ensure_then",
          ensureRef: ensureRefDef,
          args: ensureArgs,
          thenSteps,
        });
      }
      idx = fiLine;
      continue;
    }

    const ifShellMatch = inner.match(/^if\s+!\s+(.+?)\s*;\s*then$/);
    if (ifShellMatch) {
      const condition = ifShellMatch[1].trim();
      const thenSteps: Array<
        | { type: "shell"; command: string; loc: { line: number; col: number } }
        | { type: "run"; workflow: { value: string; loc: { line: number; col: number } }; args?: string }
      > = [];
      let foundFi = -1;
      for (let lookahead = idx + 1; lookahead < lines.length; lookahead += 1) {
        const lookNo = lookahead + 1;
        const lookRaw = lines[lookahead];
        const lookTrim = lookRaw.trim();
        if (!lookTrim || lookTrim.startsWith("#")) {
          continue;
        }
        if (lookTrim === "fi") {
          foundFi = lookahead;
          break;
        }
        const runMatch = lookTrim.match(
          /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (runMatch) {
          thenSteps.push({
            type: "run",
            workflow: {
              value: runMatch[1],
              loc: { line: lookNo, col: lines[lookahead].indexOf("run") + 1 },
            },
            args: runMatch[2]?.trim(),
          });
        } else {
          thenSteps.push({
            type: "shell",
            command: lookRaw.trim(),
            loc: { line: lookNo, col: colFromRaw(lookRaw) },
          });
        }
      }
      if (foundFi === -1) {
        fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
      }
      if (thenSteps.length === 0) {
        fail(filePath, "if-block then-branch must contain at least one command or run", innerNo);
      }
      workflow.steps.push({
        type: "if_not_shell_then",
        condition,
        thenSteps,
      });
      idx = foundFi;
      continue;
    }

    const promptAssignMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
    );
    if (promptAssignMatch) {
      const captureName = promptAssignMatch[1];
      const promptArg = promptAssignMatch[2].trimStart();
      const promptCol = innerRaw.indexOf("prompt") + 1;
      if (!promptArg.startsWith(`"`)) {
        fail(filePath, 'prompt must match: name = prompt "<text>"', innerNo, promptCol);
      }
      let rawPrompt = promptArg;
      if (!hasUnescapedClosingQuote(promptArg, 1)) {
        let closed = false;
        for (let lookahead = idx + 1; lookahead < lines.length; lookahead += 1) {
          rawPrompt += `\n${lines[lookahead]}`;
          if (hasUnescapedClosingQuote(lines[lookahead], 0)) {
            idx = lookahead;
            closed = true;
            break;
          }
        }
        if (!closed) {
          fail(filePath, "unterminated prompt string", innerNo, promptCol);
        }
      }
      const { promptRaw, returns: returnsSchema, nextIndex: nextIdx } = splitPromptAndReturns(
        filePath,
        innerNo,
        rawPrompt,
        lines,
        idx,
      );
      idx = nextIdx - 1;
      workflow.steps.push({
        type: "prompt",
        raw: promptRaw,
        loc: { line: innerNo, col: promptCol },
        captureName,
        ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
      });
      continue;
    }

    if (inner.startsWith("prompt ")) {
      const promptCol = innerRaw.indexOf("prompt") + 1;
      const promptArg = innerRaw.slice(innerRaw.indexOf("prompt") + "prompt".length).trimStart();
      if (!promptArg.startsWith(`"`)) {
        fail(filePath, 'prompt must match: prompt "<text>"', innerNo, promptCol);
      }
      let rawPrompt = promptArg;
      if (!hasUnescapedClosingQuote(promptArg, 1)) {
        let closed = false;
        for (let lookahead = idx + 1; lookahead < lines.length; lookahead += 1) {
          rawPrompt += `\n${lines[lookahead]}`;
          if (hasUnescapedClosingQuote(lines[lookahead], 0)) {
            idx = lookahead;
            closed = true;
            break;
          }
        }
        if (!closed) {
          fail(filePath, "unterminated prompt string", innerNo, promptCol);
        }
      }
      const { promptRaw, returns: returnsSchema, nextIndex: nextIdx } = splitPromptAndReturns(
        filePath,
        innerNo,
        rawPrompt,
        lines,
        idx,
      );
      idx = nextIdx - 1;
      workflow.steps.push({
        type: "prompt",
        raw: promptRaw,
        loc: { line: innerNo, col: promptCol },
        ...(returnsSchema !== undefined ? { returns: returnsSchema } : {}),
      });
      continue;
    }

    const genericAssignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+=\s*(.+)$/s);
    if (
      genericAssignMatch &&
      !genericAssignMatch[2].trimStart().startsWith("prompt ") &&
      !genericAssignMatch[2].trimStart().startsWith('"') &&
      !genericAssignMatch[2].trimStart().startsWith("'") &&
      !genericAssignMatch[2].trimStart().startsWith("$")
    ) {
      const captureName = genericAssignMatch[1];
      const rest = genericAssignMatch[2].trim();
      // Capture + send is a parse error.
      if (matchSendOperator(rest)) {
        fail(filePath, "E_PARSE capture and send cannot be combined; use separate steps", innerNo);
      }
      if (rest.startsWith("ensure ")) {
        const ensureBody = rest.slice("ensure ".length).trim();
        const recoverIdx = ensureBody.indexOf(" recover ");
        if (recoverIdx === -1) {
          const ensureMatch = ensureBody.match(
            /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
          );
          if (!ensureMatch || !isRef(ensureMatch[1])) {
            fail(filePath, "invalid ensure statement", innerNo);
          }
          workflow.steps.push({
            type: "ensure",
            ref: {
              value: ensureMatch[1],
              loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
            },
            args: ensureMatch[2]?.trim(),
            captureName,
          });
          continue;
        }
        const left = ensureBody.slice(0, recoverIdx).trim();
        const right = ensureBody.slice(recoverIdx + " recover ".length).trim();
        const ensureMatch = left.match(
          /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (!ensureMatch || !isRef(ensureMatch[1])) {
          fail(filePath, "invalid ensure statement", innerNo);
        }
        const ref = ensureMatch[1];
        const args = ensureMatch[2]?.trim();
        const recoverCol = innerRaw.indexOf("recover") + 1;

        if (right === "{") {
          const blockStartLine = innerNo;
          let blockLines: string[] = [];
          let closeLineIdx = -1;
          for (let look = idx + 1; look < lines.length; look += 1) {
            const lookTrim = lines[look].trim();
            if (lookTrim === "}") {
              closeLineIdx = look;
              break;
            }
            blockLines.push(lines[look].trim());
          }
          if (closeLineIdx === -1) {
            fail(filePath, 'unterminated recover block, expected "}"', blockStartLine, recoverCol);
          }
          const blockContent = blockLines.join("\n");
          const statements = blockContent
            .split(/[;\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (statements.length === 0) {
            fail(filePath, "recover block must contain at least one statement", blockStartLine, recoverCol);
          }
          const blockSteps = statements.map((s) =>
            parseRecoverStatement(filePath, blockStartLine, 1, s),
          );
          workflow.steps.push({
            type: "ensure",
            ref: { value: ref, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
            args,
            recover: { block: blockSteps },
            captureName,
          });
          idx = closeLineIdx;
          continue;
        }

        if (right.startsWith("{")) {
          const closeBrace = right.indexOf("}");
          if (closeBrace === -1) {
            fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
          }
          const blockContent = right.slice(1, closeBrace).trim();
          const statements = blockContent
            .split(/[;\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (statements.length === 0) {
            fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
          }
          const blockSteps = statements.map((s) =>
            parseRecoverStatement(filePath, innerNo, recoverCol, s),
          );
          workflow.steps.push({
            type: "ensure",
            ref: { value: ref, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
            args,
            recover: { block: blockSteps },
            captureName,
          });
          continue;
        }

        const singleStep = parseRecoverStatement(filePath, innerNo, recoverCol, right);
        workflow.steps.push({
          type: "ensure",
          ref: { value: ref, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
          args,
          recover: { single: singleStep },
          captureName,
        });
        continue;
      }
      if (rest.startsWith("run ")) {
        const runBody = rest.slice("run ".length).trim();
        const runMatch = runBody.match(
          /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (!runMatch || !isRef(runMatch[1])) {
          fail(filePath, "run must target a workflow reference", innerNo);
        }
        workflow.steps.push({
          type: "run",
          workflow: {
            value: runMatch[1],
            loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
          },
          args: runMatch[2]?.trim(),
          captureName,
        });
        continue;
      }
      if (rest.trimStart().startsWith("(")) {
        workflow.steps.push({
          type: "shell",
          command: inner,
          loc: { line: innerNo, col: innerRaw.indexOf(rest) + 1 },
        });
        continue;
      }
      workflow.steps.push({
        type: "shell",
        command: rest,
        loc: { line: innerNo, col: innerRaw.indexOf(rest) + 1 },
        captureName,
      });
      continue;
    }

    if (inner.startsWith("ensure ")) {
      const ensureBody = inner.slice("ensure ".length).trim();
      const recoverIdx = ensureBody.indexOf(" recover ");
      if (recoverIdx === -1) {
        const ensureMatch = ensureBody.match(
          /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (!ensureMatch || !isRef(ensureMatch[1])) {
          fail(filePath, "invalid ensure statement", innerNo);
        }
        const ref = ensureMatch[1];
        const args = ensureMatch[2]?.trim();
        workflow.steps.push({
          type: "ensure",
          ref: {
            value: ref,
            loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
          },
          args,
        });
        continue;
      }
      const left = ensureBody.slice(0, recoverIdx).trim();
      const right = ensureBody.slice(recoverIdx + " recover ".length).trim();
      const ensureMatch = left.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
      );
      if (!ensureMatch || !isRef(ensureMatch[1])) {
        fail(filePath, "invalid ensure statement", innerNo);
      }
      const ref = ensureMatch[1];
      const args = ensureMatch[2]?.trim();
      const recoverCol = innerRaw.indexOf("recover") + 1;

      if (right === "{") {
        const blockStartLine = innerNo;
        let blockLines: string[] = [];
        let closeLineIdx = -1;
        for (let look = idx + 1; look < lines.length; look += 1) {
          const lookTrim = lines[look].trim();
          if (lookTrim === "}") {
            closeLineIdx = look;
            break;
          }
          blockLines.push(lines[look].trim());
        }
        if (closeLineIdx === -1) {
          fail(filePath, 'unterminated recover block, expected "}"', blockStartLine, recoverCol);
        }
        const blockContent = blockLines.join("\n");
        const statements = blockContent
          .split(/[;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (statements.length === 0) {
          fail(filePath, "recover block must contain at least one statement", blockStartLine, recoverCol);
        }
        const blockSteps = statements.map((s) =>
          parseRecoverStatement(filePath, blockStartLine, 1, s),
        );
        workflow.steps.push({
          type: "ensure",
          ref: {
            value: ref,
            loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
          },
          args,
          recover: { block: blockSteps },
        });
        idx = closeLineIdx;
        continue;
      }

      if (right.startsWith("{")) {
        const closeBrace = right.indexOf("}");
        if (closeBrace === -1) {
          fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
        }
        const blockContent = right.slice(1, closeBrace).trim();
        const statements = blockContent
          .split(/[;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (statements.length === 0) {
          fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
        }
        const blockSteps = statements.map((s) =>
          parseRecoverStatement(filePath, innerNo, recoverCol, s),
        );
        workflow.steps.push({
          type: "ensure",
          ref: {
            value: ref,
            loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
          },
          args,
          recover: { block: blockSteps },
        });
        continue;
      }

      const singleStep = parseRecoverStatement(filePath, innerNo, recoverCol, right);
      workflow.steps.push({
        type: "ensure",
        ref: {
          value: ref,
          loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
        },
        args,
        recover: { single: singleStep },
      });
      continue;
    }

    if (inner.startsWith("run ")) {
      const runBody = inner.slice("run ".length).trim();
      const runMatch = runBody.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
      );
      if (!runMatch || !isRef(runMatch[1])) {
        fail(filePath, "run must target a workflow reference", innerNo);
      }
      workflow.steps.push({
        type: "run",
        workflow: {
          value: runMatch[1],
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
        args: runMatch[2]?.trim(),
      });
      continue;
    }

    if (inner.startsWith("log ") || inner === "log") {
      const logArg = inner.slice("log".length).trimStart();
      const logCol = innerRaw.indexOf("log") + 1;
      if (!logArg.startsWith('"')) {
        fail(filePath, 'log must match: log "<message>"', innerNo, logCol);
      }
      const closeIdx = indexOfClosingDoubleQuote(logArg, 1);
      if (closeIdx === -1) {
        fail(filePath, "unterminated log string", innerNo, logCol);
      }
      const message = logArg.slice(0, closeIdx + 1);
      workflow.steps.push({
        type: "log",
        message,
        loc: { line: innerNo, col: logCol },
      });
      continue;
    }

    if (/^if\s+(?:!\s*)?ensure\b/.test(inner)) {
      fail(filePath, 'malformed if-ensure statement; expected "if [!] ensure <rule_ref> [args]; then"', innerNo);
    }

    // `on <channel> -> <workflow>[, <workflow>...]` route declaration.
    const onRouteMatch = inner.match(
      /^on\s+([A-Za-z_][A-Za-z0-9_]*)\s+->\s+(.+)$/,
    );
    if (onRouteMatch) {
      const channel = onRouteMatch[1];
      const targetsStr = onRouteMatch[2].trim();
      const targetNames = targetsStr.split(/\s*,\s*/);
      const workflows = targetNames.map((name) => {
        const trimmedName = name.trim();
        if (!isRef(trimmedName)) {
          fail(filePath, `invalid workflow reference in on route: "${trimmedName}"`, innerNo);
        }
        return { value: trimmedName, loc: { line: innerNo, col: innerRaw.indexOf(trimmedName) + 1 } };
      });
      if (!workflow.routes) {
        workflow.routes = [];
      }
      workflow.routes.push({
        channel,
        workflows,
        loc: { line: innerNo, col: 1 },
      });
      continue;
    }

    // `[cmd] -> <channel>` send operator (detected before shell fallback).
    const sendMatch = matchSendOperator(inner);
    if (sendMatch) {
      workflow.steps.push({
        type: "send",
        command: sendMatch.command,
        channel: sendMatch.channel,
        loc: { line: innerNo, col: 1 },
      });
      continue;
    }

    const shellDelta = braceDepthDelta(inner);
    if (shellDelta > 0) {
      shellAccumulator = [innerRaw.trim()];
      shellAccumulatorStartLine = innerNo;
      braceDepth = shellDelta;
      continue;
    }
    workflow.steps.push({
      type: "shell",
      command: inner,
      loc: { line: innerNo, col: 1 },
    });
  }

  if (idx >= lines.length) {
    fail(filePath, `unterminated workflow block: ${workflow.name}`, lineNo);
  }
  return { workflow, nextIndex: idx + 1, exported: isExported };
}
