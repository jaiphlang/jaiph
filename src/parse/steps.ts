import type { WorkflowStepDef } from "../types";
import { fail, isRef } from "./core";
import { parsePromptStep } from "./prompt";

/** Split recover block content into statements on `;` or `\n`, but not inside double-quoted strings. */
function splitRecoverStatements(blockContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  for (let i = 0; i < blockContent.length; i += 1) {
    const ch = blockContent[i];
    if (ch === '"' && (i === 0 || blockContent[i - 1] !== "\\")) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (!inDoubleQuote && (ch === ";" || ch === "\n")) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

/** Parse a single workflow statement string (e.g. "run foo", "ensure bar", "echo x") into a step. */
function parseRecoverStatement(
  filePath: string,
  lineNo: number,
  col: number,
  stmt: string,
): WorkflowStepDef {
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
    return parsePromptStep(
      filePath, [], lineNo - 1, promptAssignMatch[2].trimStart(),
      col + t.indexOf("prompt"), promptAssignMatch[1],
    ).step;
  }
  if (t.startsWith("prompt ")) {
    return parsePromptStep(
      filePath, [], lineNo - 1, t.slice("prompt ".length).trimStart(),
      col + t.indexOf("prompt"),
    ).step;
  }
  return {
    type: "shell",
    command: t,
    loc: { line: lineNo, col },
  };
}

/**
 * Parse an `ensure <ref> [args] [recover ...]` step, with optional captureName.
 * Returns the step and the updated 0-based line index.
 */
export function parseEnsureStep(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  ensureBody: string,
  captureName?: string,
): { step: WorkflowStepDef; nextIdx: number } {
  const recoverIdx = ensureBody.indexOf(" recover ");
  const ensureCol = innerRaw.indexOf("ensure") + 1;
  if (recoverIdx === -1) {
    const ensureMatch = ensureBody.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
    );
    if (!ensureMatch || !isRef(ensureMatch[1])) {
      fail(filePath, "invalid ensure statement", innerNo);
    }
    return {
      step: {
        type: "ensure",
        ref: { value: ensureMatch[1], loc: { line: innerNo, col: ensureCol } },
        args: ensureMatch[2]?.trim(),
        ...(captureName ? { captureName } : {}),
      },
      nextIdx: idx,
    };
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
  const refLoc = { value: ref, loc: { line: innerNo, col: ensureCol } };
  const base = { type: "ensure" as const, ref: refLoc, args, ...(captureName ? { captureName } : {}) };

  if (right === "{") {
    let blockLines: string[] = [];
    let closeLineIdx = -1;
    for (let look = idx + 1; look < lines.length; look += 1) {
      if (lines[look].trim() === "}") { closeLineIdx = look; break; }
      blockLines.push(lines[look].trim());
    }
    if (closeLineIdx === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const statements = splitRecoverStatements(blockLines.join("\n"));
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseRecoverStatement(filePath, innerNo, 1, s));
    return { step: { ...base, recover: { block: blockSteps } }, nextIdx: closeLineIdx };
  }

  if (right.startsWith("{")) {
    const closeBrace = right.indexOf("}");
    if (closeBrace === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const blockContent = right.slice(1, closeBrace).trim();
    const statements = splitRecoverStatements(blockContent);
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseRecoverStatement(filePath, innerNo, recoverCol, s));
    return { step: { ...base, recover: { block: blockSteps } }, nextIdx: idx };
  }

  const singleStep = parseRecoverStatement(filePath, innerNo, recoverCol, right);
  return { step: { ...base, recover: { single: singleStep } }, nextIdx: idx };
}
