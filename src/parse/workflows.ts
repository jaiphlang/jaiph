import type { WorkflowDef, WorkflowRouteDef } from "../types";
import { braceDepthDelta, colFromRaw, fail, indexOfClosingDoubleQuote, isRef } from "./core";
import { parseConfigBlock } from "./metadata";
import { parsePromptStep } from "./prompt";
import { parseEnsureStep } from "./steps";

/**
 * Match `channel <- command` send operator in a line, only when `<-` appears outside quoted strings.
 * The channel identifier must be on the left side of the `<-` operator.
 * Returns { command, channel } if matched, or null.
 */
function matchSendOperator(line: string): { command: string; channel: string } | null {
  // Walk the line tracking quote state; find `<-` outside quotes.
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
    if (!inSingleQuote && !inDoubleQuote && ch === "<" && line[i + 1] === "-") {
      const before = line.slice(0, i).trimEnd();
      const after = line.slice(i + 2).trimStart();
      // Channel must be a valid identifier on the left side
      const channelMatch = before.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/,
      );
      if (channelMatch) {
        return { command: after, channel: channelMatch[1] };
      }
    }
  }
  return null;
}

/**
 * Detect Jaiph value-return syntax vs bash exit-code return.
 * Jaiph value-return: return "..." | return '...' | return $var
 * Bash return (kept as shell): return 0 | return 1 | return $?
 */
function isJaiphValueReturn(expr: string): boolean {
  const arg = expr.trim();
  if (/^[0-9]+$/.test(arg)) return false;
  if (arg === "$?") return false;
  return arg.startsWith('"') || arg.startsWith("'") || arg.startsWith("$");
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
  /** Track whether a non-comment step has been seen (config must come first). */
  let hadNonCommentStep = false;

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
    // Workflow-scoped config block (must appear before any non-comment steps).
    if (/^config\s*\{/.test(inner)) {
      flushShellAccumulator();
      if (workflow.metadata !== undefined) {
        fail(filePath, "duplicate config block inside workflow (only one allowed per workflow)", innerNo);
      }
      if (hadNonCommentStep) {
        fail(filePath, "config block inside workflow must appear before any steps", innerNo);
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, idx);
      if (metadata.runtime) {
        fail(filePath, "runtime.* keys are not allowed in workflow-level config (only agent.* and run.* keys)", innerNo);
      }
      workflow.metadata = metadata;
      idx = nextIndex - 1; // for loop will increment
      continue;
    }
    if (braceDepth > 0) {
      shellAccumulator.push(innerRaw.trim());
      braceDepth += braceDepthDelta(inner);
      if (braceDepth === 0) flushShellAccumulator();
      continue;
    }

    hadNonCommentStep = true;

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
      let fiLine = -1;
      let inElse = false;
      const thenSteps: import("../types").WorkflowStepDef[] = [];
      const elseSteps: import("../types").WorkflowStepDef[] = [];
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
          const promptCol = lookRaw.indexOf("prompt") + 1;
          const result = parsePromptStep(
            filePath, lines, lookahead, promptAssignMatch[2].trimStart(),
            promptCol, promptAssignMatch[1],
          );
          lookahead = result.nextLineIdx;
          target.push(result.step);
          continue;
        }
        if (lookTrim.startsWith("prompt ")) {
          const promptCol = lookRaw.indexOf("prompt") + 1;
          const promptArg = lookRaw.slice(lookRaw.indexOf("prompt") + "prompt".length).trimStart();
          const result = parsePromptStep(filePath, lines, lookahead, promptArg, promptCol);
          lookahead = result.nextLineIdx;
          target.push(result.step);
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
      workflow.steps.push({
        type: "if",
        negated: isNegated,
        condition: { kind: "ensure", ref: ensureRefDef, args: ensureArgs },
        thenSteps,
        ...(hasElse ? { elseSteps } : {}),
      });
      idx = fiLine;
      continue;
    }

    const ifNegRunMatch = inner.match(
      /^if\s+!\s*run\s+(.+?)\s*;\s*then$/,
    );
    const ifPosRunMatch = !ifNegRunMatch
      ? inner.match(/^if\s+run\s+(.+?)\s*;\s*then$/)
      : null;
    const ifRunBody = ifNegRunMatch?.[1] ?? ifPosRunMatch?.[1];
    const isRunNegated = !!ifNegRunMatch;
    if (ifRunBody) {
      const runBodyMatch = ifRunBody.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
      );
      if (!runBodyMatch || !isRef(runBodyMatch[1])) {
        fail(filePath, "invalid workflow reference in if-run statement", innerNo);
      }
      const runRef = runBodyMatch[1];
      const runArgs = runBodyMatch[2]?.trim();
      let fiLine = -1;
      let inElse = false;
      const thenSteps: import("../types").WorkflowStepDef[] = [];
      const elseSteps: import("../types").WorkflowStepDef[] = [];
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
            fail(filePath, "duplicate else in if-run block", lookNo);
          }
          inElse = true;
          continue;
        }
        const target = inElse ? elseSteps : thenSteps;
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
          const promptCol = lookRaw.indexOf("prompt") + 1;
          const result = parsePromptStep(
            filePath, lines, lookahead, promptAssignMatch[2].trimStart(),
            promptCol, promptAssignMatch[1],
          );
          lookahead = result.nextLineIdx;
          target.push(result.step);
          continue;
        }
        if (lookTrim.startsWith("prompt ")) {
          const promptCol = lookRaw.indexOf("prompt") + 1;
          const promptArg = lookRaw.slice(lookRaw.indexOf("prompt") + "prompt".length).trimStart();
          const result = parsePromptStep(filePath, lines, lookahead, promptArg, promptCol);
          lookahead = result.nextLineIdx;
          target.push(result.step);
          continue;
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
      const runRefDef = { value: runRef, loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 } };
      const hasElse = elseSteps.length > 0;
      workflow.steps.push({
        type: "if",
        negated: isRunNegated,
        condition: { kind: "run", ref: runRefDef, args: runArgs },
        thenSteps,
        ...(hasElse ? { elseSteps } : {}),
      });
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
        type: "if",
        negated: true,
        condition: { kind: "shell", command: condition },
        thenSteps: thenSteps as import("../types").WorkflowStepDef[],
      });
      idx = foundFi;
      continue;
    }

    const promptAssignMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
    );
    if (promptAssignMatch) {
      const promptCol = innerRaw.indexOf("prompt") + 1;
      const result = parsePromptStep(
        filePath, lines, idx, promptAssignMatch[2].trimStart(),
        promptCol, promptAssignMatch[1],
      );
      idx = result.nextLineIdx;
      workflow.steps.push(result.step);
      continue;
    }

    if (inner.startsWith("prompt ")) {
      const promptCol = innerRaw.indexOf("prompt") + 1;
      const promptArg = innerRaw.slice(innerRaw.indexOf("prompt") + "prompt".length).trimStart();
      const result = parsePromptStep(filePath, lines, idx, promptArg, promptCol);
      idx = result.nextLineIdx;
      workflow.steps.push(result.step);
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
        const result = parseEnsureStep(
          filePath, lines, idx, innerNo, innerRaw,
          rest.slice("ensure ".length).trim(), captureName,
        );
        idx = result.nextIdx;
        workflow.steps.push(result.step);
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
      const result = parseEnsureStep(
        filePath, lines, idx, innerNo, innerRaw,
        inner.slice("ensure ".length).trim(),
      );
      idx = result.nextIdx;
      workflow.steps.push(result.step);
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

    if (inner.startsWith("logerr ") || inner === "logerr") {
      const logerrArg = inner.slice("logerr".length).trimStart();
      const logerrCol = innerRaw.indexOf("logerr") + 1;
      if (!logerrArg.startsWith('"')) {
        fail(filePath, 'logerr must match: logerr "<message>"', innerNo, logerrCol);
      }
      const closeIdx = indexOfClosingDoubleQuote(logerrArg, 1);
      if (closeIdx === -1) {
        fail(filePath, "unterminated logerr string", innerNo, logerrCol);
      }
      const message = logerrArg.slice(0, closeIdx + 1);
      workflow.steps.push({
        type: "logerr",
        message,
        loc: { line: innerNo, col: logerrCol },
      });
      continue;
    }

    const returnMatch = inner.match(/^return\s+(.+)$/s);
    if (returnMatch) {
      const returnValue = returnMatch[1].trim();
      if (isJaiphValueReturn(returnValue)) {
        workflow.steps.push({
          type: "return",
          value: returnValue,
          loc: { line: innerNo, col: innerRaw.indexOf("return") + 1 },
        });
        continue;
      }
    }

    if (/^if\s+(?:!\s*)?ensure\b/.test(inner)) {
      fail(filePath, 'malformed if-ensure statement; expected "if [!] ensure <rule_ref> [args]; then"', innerNo);
    }

    // `<channel> -> <workflow>[, <workflow>...]` route declaration.
    const routeMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+->\s+(.+)$/,
    );
    if (routeMatch) {
      const channel = routeMatch[1];
      const targetsStr = routeMatch[2].trim();
      const targetNames = targetsStr.split(/\s*,\s*/);
      const workflows = targetNames.map((name) => {
        const trimmedName = name.trim();
        if (!isRef(trimmedName)) {
          fail(filePath, `invalid workflow reference in route: "${trimmedName}"`, innerNo);
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

    // `<channel> <- [cmd]` send operator (detected before shell fallback).
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
