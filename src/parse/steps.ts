import type { WorkflowStepDef } from "../types";
import { parseConstRhs } from "./const-rhs";
import { fail, indexOfClosingDoubleQuote, isRef, parseCallRef, parseLogMessageRhs } from "./core";
import { parseAnonymousInlineScript } from "./inline-script";
import { isBareIdentifierReturn, bareIdentifierToQuotedString, isBareDottedIdentifierReturn, dottedReturnToQuotedString } from "./workflow-return-dotted";

/** Reject non-empty trailing content after a call expression (e.g. shell redirection). */
function rejectTrailingContent(
  filePath: string,
  lineNo: number,
  keyword: string,
  rest: string,
): void {
  const trimmed = rest.trim();
  if (!trimmed) return;
  fail(filePath, `unexpected content after ${keyword} call: '${trimmed}'; shell redirection (>, |, &) is not supported — use a script block`, lineNo);
}
import { parsePromptStep } from "./prompt";

/**
 * Split catch block content into statements on `;` or `\n`, but not inside
 * double-quoted strings or triple-quoted `"""…"""` blocks (same idea as
 * `splitStatementsOnSemicolons`).
 */
function splitCatchStatements(blockContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inTripleQuote = false;
  let braceDepth = 0;
  let i = 0;
  while (i < blockContent.length) {
    const ch = blockContent[i];
    const next3 = blockContent.slice(i, i + 3);

    if (inTripleQuote) {
      if (next3 === '"""') {
        current += next3;
        inTripleQuote = false;
        i += 3;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && (i === 0 || blockContent[i - 1] !== "\\")) {
        inDoubleQuote = false;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (next3 === '"""') {
      inTripleQuote = true;
      current += next3;
      i += 3;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "{") {
      braceDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }

    if (braceDepth === 0 && (ch === ";" || ch === "\n")) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

/** Parse a single workflow statement string (e.g. "run foo", "ensure bar", "echo x") into a step. */
function parseCatchStatement(
  filePath: string,
  lineNo: number,
  col: number,
  stmt: string,
): WorkflowStepDef {
  const t = stmt.trim();
  if (!t) {
    fail(filePath, "empty catch statement", lineNo, col);
  }
  if (t.startsWith("#")) {
    return { type: "comment", text: t, loc: { line: lineNo, col } };
  }
  if (t === "wait") {
    fail(filePath, '"wait" has been removed from the language', lineNo, col);
  }
  if (t === "return") {
    return { type: "return", value: '""', loc: { line: lineNo, col } };
  }
  if (t.startsWith("return ")) {
    const retVal = t.slice("return ".length).trim();
    // return run ref(args) — managed run
    if (retVal.startsWith("run ")) {
      const call = parseCallRef(retVal.slice("run ".length).trim());
      if (call && !call.rest.trim()) {
        return {
          type: "return",
          value: `run ${call.ref}(${call.args ?? ""})`,
          loc: { line: lineNo, col },
          managed: {
            kind: "run",
            ref: { value: call.ref, loc: { line: lineNo, col } },
            args: call.args,
            ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
          },
        };
      }
    }
    // return ensure ref(args) — managed ensure
    if (retVal.startsWith("ensure ")) {
      const call = parseCallRef(retVal.slice("ensure ".length).trim());
      if (call && !call.rest.trim()) {
        return {
          type: "return",
          value: `ensure ${call.ref}(${call.args ?? ""})`,
          loc: { line: lineNo, col },
          managed: {
            kind: "ensure",
            ref: { value: call.ref, loc: { line: lineNo, col } },
            args: call.args,
            ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
          },
        };
      }
    }
    const value = isBareDottedIdentifierReturn(retVal)
      ? dottedReturnToQuotedString(retVal)
      : isBareIdentifierReturn(retVal)
        ? bareIdentifierToQuotedString(retVal)
        : retVal;
    return { type: "return", value, loc: { line: lineNo, col } };
  }
  if (/^fail\s+/.test(t)) {
    const arg = t.slice("fail".length).trimStart();
    if (!arg.startsWith('"')) {
      fail(filePath, 'fail must match: fail "<reason>"', lineNo, col);
    }
    const closeIdx = indexOfClosingDoubleQuote(arg, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated fail string", lineNo, col);
    }
    const message = arg.slice(0, closeIdx + 1);
    return { type: "fail", message, loc: { line: lineNo, col } };
  }
  const constMatch = t.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
  if (constMatch) {
    const name = constMatch[1];
    const rhs = constMatch[2].trim();
    const syntheticLines = [t];
    const { value } = parseConstRhs(filePath, syntheticLines, 0, rhs, lineNo, col, false, name);
    return {
      type: "const",
      name,
      value,
      loc: { line: lineNo, col },
    };
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
    if (rest.startsWith("run ") || rest.startsWith("ensure ")) {
      fail(
        filePath,
        `assignment without "const" is no longer supported; use "const ${captureName} = ${rest}"`,
        lineNo,
        col,
      );
    }
  }
  if (t.startsWith("run ")) {
    const runBody = t.slice("run ".length).trim();
    if (runBody.startsWith("`")) {
      const result = parseAnonymousInlineScript(filePath, [], lineNo - 1, runBody, lineNo, col);
      return {
        type: "run_inline_script",
        body: result.body,
        ...(result.lang ? { lang: result.lang } : {}),
        args: result.args,
        ...(result.bareIdentifierArgs ? { bareIdentifierArgs: result.bareIdentifierArgs } : {}),
        loc: { line: lineNo, col },
      };
    }
    // Check for run ... recover inside catch/recover blocks
    const recoverLoopMatch = runBody.match(/ recover(?=[\s(])/);
    if (recoverLoopMatch) {
      const recLoopIdx = recoverLoopMatch.index!;
      const leftPart = runBody.slice(0, recLoopIdx).trim();
      const rightPart = runBody.slice(recLoopIdx + " recover".length).trimStart();
      const callPart = parseCallRef(leftPart);
      if (callPart && !callPart.rest.trim() && rightPart.startsWith("(")) {
        const closeParen = rightPart.indexOf(")");
        if (closeParen !== -1) {
          const bStr = rightPart.slice(1, closeParen).trim();
          const bParts = bStr.split(",").map((s) => s.trim()).filter(Boolean);
          if (bParts.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bParts[0])) {
            const bindings = { failure: bParts[0] };
            const after = rightPart.slice(closeParen + 1).trim();
            if (after.startsWith("{") && after.endsWith("}")) {
              const blockContent = after.slice(1, -1).trim();
              const stmts = splitCatchStatements(blockContent);
              const blockSteps = stmts.map((s) => parseCatchStatement(filePath, lineNo, col, s));
              return {
                type: "run",
                workflow: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recoverLoop: { block: blockSteps, bindings },
              };
            }
            if (!after.startsWith("{") && after) {
              const singleStep = parseCatchStatement(filePath, lineNo, col, after);
              return {
                type: "run",
                workflow: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recoverLoop: { single: singleStep, bindings },
              };
            }
          }
        }
      }
    }
    // Check for run ... catch inside catch blocks
    const recIdx = runBody.indexOf(" catch ");
    if (recIdx !== -1) {
      const leftPart = runBody.slice(0, recIdx).trim();
      const rightPart = runBody.slice(recIdx + " catch ".length).trim();
      const callPart = parseCallRef(leftPart);
      if (callPart && !callPart.rest.trim() && rightPart.startsWith("(")) {
        const closeParen = rightPart.indexOf(")");
        if (closeParen !== -1) {
          const bStr = rightPart.slice(1, closeParen).trim();
          const bParts = bStr.split(",").map((s) => s.trim()).filter(Boolean);
          if (bParts.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bParts[0])) {
            const bindings = { failure: bParts[0] };
            const after = rightPart.slice(closeParen + 1).trim();
            if (after.startsWith("{") && after.endsWith("}")) {
              const blockContent = after.slice(1, -1).trim();
              const stmts = splitCatchStatements(blockContent);
              const blockSteps = stmts.map((s) => parseCatchStatement(filePath, lineNo, col, s));
              return {
                type: "run",
                workflow: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recover: { block: blockSteps, bindings },
              };
            }
            if (!after.startsWith("{") && after) {
              const singleStep = parseCatchStatement(filePath, lineNo, col, after);
              return {
                type: "run",
                workflow: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recover: { single: singleStep, bindings },
              };
            }
          }
        }
      }
    }
    const call = parseCallRef(runBody);
    if (call) {
      rejectTrailingContent(filePath, lineNo, "run", call.rest);
      return {
        type: "run",
        workflow: { value: call.ref, loc: { line: lineNo, col } },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      };
    }
  }
  if (t.startsWith("ensure ")) {
    const ensureBody = t.slice("ensure ".length).trim();
    const ensRecIdx = ensureBody.indexOf(" catch ");
    if (ensRecIdx !== -1) {
      const leftPart = ensureBody.slice(0, ensRecIdx).trim();
      const rightPart = ensureBody.slice(ensRecIdx + " catch ".length).trim();
      const callPart = parseCallRef(leftPart);
      if (callPart && !callPart.rest.trim() && rightPart.startsWith("(")) {
        const closeParen = rightPart.indexOf(")");
        if (closeParen !== -1) {
          const bStr = rightPart.slice(1, closeParen).trim();
          const bParts = bStr.split(",").map((s) => s.trim()).filter(Boolean);
          if (bParts.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bParts[0])) {
            const bindings = { failure: bParts[0] };
            const after = rightPart.slice(closeParen + 1).trim();
            if (after.startsWith("{") && after.endsWith("}")) {
              const blockContent = after.slice(1, -1).trim();
              const stmts = splitCatchStatements(blockContent);
              const blockSteps = stmts.map((s) => parseCatchStatement(filePath, lineNo, col, s));
              return {
                type: "ensure",
                ref: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recover: { block: blockSteps, bindings },
              };
            }
            if (!after.startsWith("{") && after) {
              const singleStep = parseCatchStatement(filePath, lineNo, col, after);
              return {
                type: "ensure",
                ref: { value: callPart.ref, loc: { line: lineNo, col } },
                args: callPart.args,
                ...(callPart.bareIdentifierArgs ? { bareIdentifierArgs: callPart.bareIdentifierArgs } : {}),
                recover: { single: singleStep, bindings },
              };
            }
          }
        }
      }
    }
    const call = parseCallRef(ensureBody);
    if (call) {
      rejectTrailingContent(filePath, lineNo, "ensure", call.rest);
      return {
        type: "ensure",
        ref: { value: call.ref, loc: { line: lineNo, col } },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
      };
    }
  }
  const promptAssignMatch = t.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*prompt\s+(.+)$/s,
  );
  if (promptAssignMatch) {
    fail(
      filePath,
      'use "const name = prompt ..." in catch blocks (e.g. const x = prompt "...")',
      lineNo,
      col + t.indexOf(promptAssignMatch[1]),
    );
  }
  if (t.startsWith("prompt ")) {
    return parsePromptStep(
      filePath, [], lineNo - 1, t.slice("prompt ".length).trimStart(),
      col + t.indexOf("prompt"),
    ).step;
  }
  if (t.startsWith("log ") || t === "log") {
    const logArg = t.slice("log".length).trimStart();
    const logCol = col + Math.max(0, t.indexOf("log"));
    const message = parseLogMessageRhs(filePath, lineNo, logCol, logArg, "log");
    return { type: "log", message, loc: { line: lineNo, col: logCol } };
  }
  if (t.startsWith("logerr ") || t === "logerr") {
    const logerrArg = t.slice("logerr".length).trimStart();
    const logerrCol = col + Math.max(0, t.indexOf("logerr"));
    const message = parseLogMessageRhs(filePath, lineNo, logerrCol, logerrArg, "logerr");
    return { type: "logerr", message, loc: { line: lineNo, col: logerrCol } };
  }
  return { type: "shell", command: t, loc: { line: lineNo, col } };
}

/**
 * Parse an `ensure <ref> [args] [catch ...]` step, with optional captureName.
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
  const catchIdx = ensureBody.indexOf(" catch ");
  const ensureCol = innerRaw.indexOf("ensure") + 1;

  // `catch` at end of line with no block → error
  if (/\scatch$/.test(ensureBody)) {
    const catchCol = innerRaw.indexOf("catch") + 1;
    fail(
      filePath,
      'catch requires explicit bindings and a body: catch (<name>) { ... }',
      innerNo,
      catchCol,
    );
  }

  if (catchIdx === -1) {
    const call = parseCallRef(ensureBody);
    if (!call) {
      fail(filePath, "ensure must target a valid reference: ensure ref() or ensure ref(args) — parentheses are required", innerNo);
    }
    rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
    return {
      step: {
        type: "ensure",
        ref: { value: call.ref, loc: { line: innerNo, col: ensureCol } },
        args: call.args,
        ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
        ...(captureName ? { captureName } : {}),
      },
      nextIdx: idx,
    };
  }
  const left = ensureBody.slice(0, catchIdx).trim();
  const right = ensureBody.slice(catchIdx + " catch ".length).trim();
  const call = parseCallRef(left);
  if (!call) {
    fail(filePath, "ensure must target a valid reference: ensure ref() or ensure ref(args) — parentheses are required", innerNo);
  }
  rejectTrailingContent(filePath, innerNo, "ensure", call.rest);
  const ref = call.ref;
  const args = call.args;
  const catchCol = innerRaw.indexOf("catch") + 1;

  // Catch requires explicit bindings: catch (<name>)
  if (!right.startsWith("(")) {
    fail(
      filePath,
      'catch requires explicit bindings: catch (<name>) { ... }',
      innerNo,
      catchCol,
    );
  }

  const closeParen = right.indexOf(")");
  if (closeParen === -1) {
    fail(filePath, 'unterminated catch bindings: expected ")"', innerNo, catchCol);
  }
  const bindingsStr = right.slice(1, closeParen).trim();
  const bindingParts = bindingsStr.split(",").map((s) => s.trim()).filter(Boolean);
  if (bindingParts.length === 0) {
    fail(filePath, "catch requires exactly one binding: catch (<name>) { ... }", innerNo, catchCol);
  }
  if (bindingParts.length > 1) {
    fail(filePath, 'catch accepts exactly one binding: catch (<name>) — the second binding (attempt) has been removed', innerNo, catchCol);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingParts[0])) {
    fail(filePath, `invalid catch binding name: "${bindingParts[0]}" — must be a valid identifier`, innerNo, catchCol);
  }
  const bindings = { failure: bindingParts[0] };

  const afterBindings = right.slice(closeParen + 1).trim();

  const refLoc = { value: ref, loc: { line: innerNo, col: ensureCol } };
  const base = {
    type: "ensure" as const, ref: refLoc, args,
    ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
    ...(captureName ? { captureName } : {}),
  };

  if (afterBindings === "{") {
    let blockLines: string[] = [];
    let closeLineIdx = -1;
    let braceDepth = 1;
    for (let look = idx + 1; look < lines.length; look += 1) {
      const trimmed = lines[look].trim();
      if (trimmed.endsWith("{")) braceDepth += 1;
      if (trimmed === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) { closeLineIdx = look; break; }
      }
      blockLines.push(trimmed);
    }
    if (closeLineIdx === -1) {
      fail(filePath, 'unterminated catch block, expected "}"', innerNo, catchCol);
    }
    const statements = splitCatchStatements(blockLines.join("\n"));
    if (statements.length === 0) {
      fail(filePath, "catch block must contain at least one statement", innerNo, catchCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, 1, s));
    return { step: { ...base, recover: { block: blockSteps, bindings } }, nextIdx: closeLineIdx };
  }

  if (afterBindings.startsWith("{")) {
    const closeBrace = afterBindings.indexOf("}");
    if (closeBrace === -1) {
      fail(filePath, 'unterminated catch block, expected "}"', innerNo, catchCol);
    }
    const blockContent = afterBindings.slice(1, closeBrace).trim();
    const statements = splitCatchStatements(blockContent);
    if (statements.length === 0) {
      fail(filePath, "catch block must contain at least one statement", innerNo, catchCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, catchCol, s));
    return { step: { ...base, recover: { block: blockSteps, bindings } }, nextIdx: idx };
  }

  if (!afterBindings) {
    fail(filePath, "catch requires a body after bindings", innerNo, catchCol);
  }

  const singleStep = parseCatchStatement(filePath, innerNo, catchCol, afterBindings);
  return { step: { ...base, recover: { single: singleStep, bindings } }, nextIdx: idx };
}

/**
 * Try to parse `run <ref>(args) recover(binding) { ... }` syntax (loop semantics).
 * Returns null if the run body does not contain ` recover `.
 */
export function parseRunRecoverStep(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  runBody: string,
  captureName?: string,
): { step: WorkflowStepDef; nextIdx: number } | null {
  // Match ` recover(`, ` recover `, or ` recover` at end of line
  const recoverMatch = runBody.match(/ recover(?=[\s(]|$)/);
  if (!recoverMatch) return null;
  const recoverIdx = recoverMatch.index!;

  if (/ recover$/.test(runBody)) {
    const recoverCol = innerRaw.indexOf("recover") + 1;
    fail(
      filePath,
      'recover requires explicit bindings and a body: recover(<name>) { ... }',
      innerNo,
      recoverCol,
    );
  }

  const left = runBody.slice(0, recoverIdx).trim();
  const right = runBody.slice(recoverIdx + " recover".length).trimStart();
  const call = parseCallRef(left);
  if (!call || call.rest.trim()) return null;
  const runCol = innerRaw.indexOf("run") + 1;
  const recoverCol = innerRaw.indexOf("recover") + 1;

  if (!right.startsWith("(")) {
    fail(
      filePath,
      'recover requires explicit bindings: recover(<name>) { ... }',
      innerNo,
      recoverCol,
    );
  }

  const closeParen = right.indexOf(")");
  if (closeParen === -1) {
    fail(filePath, 'unterminated recover bindings: expected ")"', innerNo, recoverCol);
  }
  const bindingsStr = right.slice(1, closeParen).trim();
  const bindingParts = bindingsStr.split(",").map((s) => s.trim()).filter(Boolean);
  if (bindingParts.length === 0) {
    fail(filePath, "recover requires exactly one binding: recover(<name>) { ... }", innerNo, recoverCol);
  }
  if (bindingParts.length > 1) {
    fail(filePath, "recover accepts exactly one binding: recover(<name>)", innerNo, recoverCol);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingParts[0])) {
    fail(filePath, `invalid recover binding name: "${bindingParts[0]}" — must be a valid identifier`, innerNo, recoverCol);
  }
  const bindings = { failure: bindingParts[0] };

  const afterBindings = right.slice(closeParen + 1).trim();
  const base = {
    type: "run" as const,
    workflow: { value: call.ref, loc: { line: innerNo, col: runCol } },
    args: call.args,
    ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
    ...(captureName ? { captureName } : {}),
  };

  if (afterBindings === "{") {
    let blockLines: string[] = [];
    let closeLineIdx = -1;
    let braceDepth = 1;
    for (let look = idx + 1; look < lines.length; look += 1) {
      const trimmed = lines[look].trim();
      if (trimmed.endsWith("{")) braceDepth += 1;
      if (trimmed === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) { closeLineIdx = look; break; }
      }
      blockLines.push(trimmed);
    }
    if (closeLineIdx === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const statements = splitCatchStatements(blockLines.join("\n"));
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, 1, s));
    return { step: { ...base, recoverLoop: { block: blockSteps, bindings } }, nextIdx: closeLineIdx };
  }

  if (afterBindings.startsWith("{")) {
    const closeBrace = afterBindings.indexOf("}");
    if (closeBrace === -1) {
      fail(filePath, 'unterminated recover block, expected "}"', innerNo, recoverCol);
    }
    const blockContent = afterBindings.slice(1, closeBrace).trim();
    const statements = splitCatchStatements(blockContent);
    if (statements.length === 0) {
      fail(filePath, "recover block must contain at least one statement", innerNo, recoverCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, recoverCol, s));
    return { step: { ...base, recoverLoop: { block: blockSteps, bindings } }, nextIdx: idx };
  }

  if (!afterBindings) {
    fail(filePath, "recover requires a body after bindings", innerNo, recoverCol);
  }

  const singleStep = parseCatchStatement(filePath, innerNo, recoverCol, afterBindings);
  return { step: { ...base, recoverLoop: { single: singleStep, bindings } }, nextIdx: idx };
}

/**
 * Try to parse `run <ref>(args) catch (bindings) { ... }` syntax.
 * Returns null if the run body does not contain ` catch `.
 */
export function parseRunCatchStep(
  filePath: string,
  lines: string[],
  idx: number,
  innerNo: number,
  innerRaw: string,
  runBody: string,
  captureName?: string,
): { step: WorkflowStepDef; nextIdx: number } | null {
  const catchIdx = runBody.indexOf(" catch ");
  if (catchIdx === -1) return null;

  // `catch` at end of line with no block → error
  if (/\scatch$/.test(runBody)) {
    const catchCol = innerRaw.indexOf("catch") + 1;
    fail(
      filePath,
      'catch requires explicit bindings and a body: catch (<name>) { ... }',
      innerNo,
      catchCol,
    );
  }

  const left = runBody.slice(0, catchIdx).trim();
  const right = runBody.slice(catchIdx + " catch ".length).trim();
  const call = parseCallRef(left);
  if (!call || call.rest.trim()) return null;
  const runCol = innerRaw.indexOf("run") + 1;
  const catchCol = innerRaw.indexOf("catch") + 1;

  if (!right.startsWith("(")) {
    fail(
      filePath,
      'catch requires explicit bindings: catch (<name>) { ... }',
      innerNo,
      catchCol,
    );
  }

  const closeParen = right.indexOf(")");
  if (closeParen === -1) {
    fail(filePath, 'unterminated catch bindings: expected ")"', innerNo, catchCol);
  }
  const bindingsStr = right.slice(1, closeParen).trim();
  const bindingParts = bindingsStr.split(",").map((s) => s.trim()).filter(Boolean);
  if (bindingParts.length === 0) {
    fail(filePath, "catch requires exactly one binding: catch (<name>) { ... }", innerNo, catchCol);
  }
  if (bindingParts.length > 1) {
    fail(filePath, 'catch accepts exactly one binding: catch (<name>) — the second binding (attempt) has been removed', innerNo, catchCol);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingParts[0])) {
    fail(filePath, `invalid catch binding name: "${bindingParts[0]}" — must be a valid identifier`, innerNo, catchCol);
  }
  const bindings = { failure: bindingParts[0] };

  const afterBindings = right.slice(closeParen + 1).trim();
  const base = {
    type: "run" as const,
    workflow: { value: call.ref, loc: { line: innerNo, col: runCol } },
    args: call.args,
    ...(call.bareIdentifierArgs ? { bareIdentifierArgs: call.bareIdentifierArgs } : {}),
    ...(captureName ? { captureName } : {}),
  };

  if (afterBindings === "{") {
    let blockLines: string[] = [];
    let closeLineIdx = -1;
    let braceDepth = 1;
    for (let look = idx + 1; look < lines.length; look += 1) {
      const trimmed = lines[look].trim();
      if (trimmed.endsWith("{")) braceDepth += 1;
      if (trimmed === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) { closeLineIdx = look; break; }
      }
      blockLines.push(trimmed);
    }
    if (closeLineIdx === -1) {
      fail(filePath, 'unterminated catch block, expected "}"', innerNo, catchCol);
    }
    const statements = splitCatchStatements(blockLines.join("\n"));
    if (statements.length === 0) {
      fail(filePath, "catch block must contain at least one statement", innerNo, catchCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, 1, s));
    return { step: { ...base, recover: { block: blockSteps, bindings } }, nextIdx: closeLineIdx };
  }

  if (afterBindings.startsWith("{")) {
    const closeBrace = afterBindings.indexOf("}");
    if (closeBrace === -1) {
      fail(filePath, 'unterminated catch block, expected "}"', innerNo, catchCol);
    }
    const blockContent = afterBindings.slice(1, closeBrace).trim();
    const statements = splitCatchStatements(blockContent);
    if (statements.length === 0) {
      fail(filePath, "catch block must contain at least one statement", innerNo, catchCol);
    }
    const blockSteps = statements.map((s) => parseCatchStatement(filePath, innerNo, catchCol, s));
    return { step: { ...base, recover: { block: blockSteps, bindings } }, nextIdx: idx };
  }

  if (!afterBindings) {
    fail(filePath, "catch requires a body after bindings", innerNo, catchCol);
  }

  const singleStep = parseCatchStatement(filePath, innerNo, catchCol, afterBindings);
  return { step: { ...base, recover: { single: singleStep, bindings } }, nextIdx: idx };
}
