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
      let fiLine = -1;
      const thenSteps: Array<
        | { type: "shell"; command: string; loc: { line: number; col: number } }
        | { type: "run"; workflow: { value: string; loc: { line: number; col: number } }; args?: string }
        | { type: "prompt"; raw: string; loc: { line: number; col: number }; captureName?: string }
      > = [];
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
          continue;
        }
        const promptAssignMatch = lookTrim.match(
          /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
        );
        if (promptAssignMatch) {
          const captureName = promptAssignMatch[1];
          const promptArg = promptAssignMatch[2].trimStart();
          const promptCol = lookRaw.indexOf("prompt") + 1;
          if (!promptArg.startsWith(`"`)) {
            fail(filePath, 'prompt must match: name = prompt "<text>"', lookNo, promptCol);
          }
          thenSteps.push({
            type: "prompt",
            raw: promptArg,
            loc: { line: lookNo, col: promptCol },
            captureName,
          });
          continue;
        }
        if (lookTrim.startsWith("prompt ")) {
          const promptCol = lookRaw.indexOf("prompt") + 1;
          const promptArg = lookRaw.slice(lookRaw.indexOf("prompt") + "prompt".length).trimStart();
          if (!promptArg.startsWith(`"`)) {
            fail(filePath, 'prompt must match: prompt "<text>"', lookNo, promptCol);
          }
          thenSteps.push({
            type: "prompt",
            raw: promptArg,
            loc: { line: lookNo, col: promptCol },
          });
          continue;
        }
        thenSteps.push({
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
      if (
        thenSteps.every((step) => step.type === "run")
      ) {
        workflow.steps.push({
          type: "if_not_ensure_then_run",
          ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
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
          ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
          commands: thenSteps.map((step) => (step as { type: "shell"; command: string; loc: { line: number; col: number } })),
        });
      } else {
        workflow.steps.push({
          type: "if_not_ensure_then",
          ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
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
