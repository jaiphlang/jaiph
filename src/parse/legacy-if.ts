import type { WorkflowStepDef } from "../types";
import { colFromRaw, fail, isRef } from "./core";
import { parsePromptStep } from "./prompt";

/** Legacy `if [!] ensure ref [args]; then` … `fi` (optional `else`). */
export function tryParseLegacyIfEnsure(
  filePath: string,
  lines: string[],
  idx: number,
  inner: string,
  innerNo: number,
  innerRaw: string,
): { step: WorkflowStepDef; nextIdx: number } | null {
  const ifNegEnsureMatch = inner.match(/^if\s+!\s*ensure\s+(.+?)\s*;\s*then$/);
  const ifPosEnsureMatch = !ifNegEnsureMatch
    ? inner.match(/^if\s+ensure\s+(.+?)\s*;\s*then$/)
    : null;
  const ifEnsureBody = ifNegEnsureMatch?.[1] ?? ifPosEnsureMatch?.[1];
  const isNegated = !!ifNegEnsureMatch;
  if (!ifEnsureBody) return null;

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
  const thenSteps: WorkflowStepDef[] = [];
  const elseSteps: WorkflowStepDef[] = [];
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
    const promptAssignMatch = lookTrim.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s);
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
  const step: WorkflowStepDef = {
    type: "if",
    negated: isNegated,
    condition: { kind: "ensure", ref: ensureRefDef, args: ensureArgs },
    thenSteps,
    ...(hasElse ? { elseSteps } : {}),
  };
  return { step, nextIdx: fiLine };
}

/** Legacy `if [!] run ref [args]; then` … `fi`. */
export function tryParseLegacyIfRun(
  filePath: string,
  lines: string[],
  idx: number,
  inner: string,
  innerNo: number,
  innerRaw: string,
): { step: WorkflowStepDef; nextIdx: number } | null {
  const ifNegRunMatch = inner.match(/^if\s+!\s*run\s+(.+?)\s*;\s*then$/);
  const ifPosRunMatch = !ifNegRunMatch ? inner.match(/^if\s+run\s+(.+?)\s*;\s*then$/) : null;
  const ifRunBody = ifNegRunMatch?.[1] ?? ifPosRunMatch?.[1];
  const isRunNegated = !!ifNegRunMatch;
  if (!ifRunBody) return null;

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
  const thenSteps: WorkflowStepDef[] = [];
  const elseSteps: WorkflowStepDef[] = [];
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
    const promptAssignMatch = lookTrim.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s);
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
  const step: WorkflowStepDef = {
    type: "if",
    negated: isRunNegated,
    condition: { kind: "run", ref: runRefDef, args: runArgs },
    thenSteps,
    ...(hasElse ? { elseSteps } : {}),
  };
  return { step, nextIdx: fiLine };
}
