import type { WorkflowDef } from "../types";
import { colFromRaw, fail, hasUnescapedClosingQuote, isRef } from "./core";

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
  for (; idx < lines.length; idx += 1) {
    const innerNo = idx + 1;
    const innerRaw = lines[idx];
    const inner = innerRaw.trim();
    if (!inner) {
      continue;
    }
    if (inner === "}") {
      break;
    }
    if (inner.startsWith("#")) {
      workflow.steps.push({
        type: "shell",
        command: innerRaw.trim(),
        loc: { line: innerNo, col: 1 },
      });
      continue;
    }

    const ifEnsureMatch = inner.match(
      /^if\s+!\s*ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*;\s*then$/,
    );
    if (ifEnsureMatch) {
      const ensureRef = ifEnsureMatch[1];
      let runLine = -1;
      let fiLine = -1;
      const shellCommands: Array<{ command: string; loc: { line: number; col: number } }> = [];
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
        const runMatch = lookTrim.match(
          /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/,
        );
        if (runMatch && shellCommands.length === 0) {
          runLine = lookahead;
          let foundFi = -1;
          for (let f = lookahead + 1; f < lines.length; f += 1) {
            const ft = lines[f].trim();
            if (!ft || ft.startsWith("#")) continue;
            if (ft === "fi") {
              foundFi = f;
              break;
            }
            fail(filePath, 'if-block must end with "fi"', f + 1);
          }
          if (foundFi === -1) {
            fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
          }
          workflow.steps.push({
            type: "if_not_ensure_then_run",
            ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
            runWorkflow: {
              value: lines[runLine].trim().slice("run ".length).trim(),
              loc: { line: runLine + 1, col: lines[runLine].indexOf("run") + 1 },
            },
          });
          idx = foundFi;
          break;
        }
        shellCommands.push({
          command: lookTrim,
          loc: { line: lookNo, col: colFromRaw(lookRaw) },
        });
      }
      if (fiLine === -1 && runLine === -1) {
        fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
      }
      if (runLine === -1 && fiLine >= 0) {
        workflow.steps.push({
          type: "if_not_ensure_then_shell",
          ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
          commands: shellCommands,
        });
        idx = fiLine;
      }
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
      workflow.steps.push({
        type: "prompt",
        raw: rawPrompt,
        loc: { line: innerNo, col: promptCol },
        captureName,
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
      workflow.steps.push({
        type: "prompt",
        raw: rawPrompt,
        loc: { line: innerNo, col: promptCol },
      });
      continue;
    }

    if (inner.startsWith("ensure ")) {
      const ensureBody = inner.slice("ensure ".length).trim();
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

    if (inner.startsWith("run ")) {
      const workflowRef = inner.slice("run ".length).trim();
      if (!isRef(workflowRef)) {
        fail(filePath, "run must target a workflow reference", innerNo);
      }
      workflow.steps.push({
        type: "run",
        workflow: {
          value: workflowRef,
          loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
        },
      });
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
