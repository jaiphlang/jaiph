import type { TestBlockDef } from "../types";
import { colFromRaw, fail, hasUnescapedClosingQuote, isRef, stripQuotes } from "./core";

function parseMockPromptBlock(
  filePath: string,
  lines: string[],
  startLineIndex: number,
  blockStartLineNo: number,
  blockStartCol: number,
): {
  step: {
    type: "test_mock_prompt_block";
    branches: Array<{ pattern: string; response: string }>;
    elseResponse?: string;
    loc: { line: number; col: number };
  };
  nextIndex: number;
} {
  const branches: Array<{ pattern: string; response: string }> = [];
  let elseResponse: string | undefined;
  let i = startLineIndex + 1;
  let seenIf = false;
  let seenFi = false;
  let pendingPattern: string | null = null;
  let inElse = false;

  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i += 1;
      continue;
    }
    if (line === "}") {
      if (!seenFi) {
        fail(filePath, 'mock prompt block must end with fi then }', lineNo);
      }
      return {
        step: {
          type: "test_mock_prompt_block",
          branches,
          elseResponse,
          loc: { line: blockStartLineNo, col: blockStartCol },
        },
        nextIndex: i + 1,
      };
    }
    const ifMatch = line.match(/^if\s+\$\{arg1\}\s+contains\s+"((?:[^"\\]|\\.)*)"\s*;\s*then\s*$/);
    if (ifMatch) {
      if (inElse) {
        fail(filePath, "elif after else not allowed in mock prompt block", lineNo);
      }
      seenIf = true;
      pendingPattern = ifMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      i += 1;
      continue;
    }
    const elifMatch = line.match(/^elif\s+\$\{arg1\}\s+contains\s+"((?:[^"\\]|\\.)*)"\s*;\s*then\s*$/);
    if (elifMatch) {
      if (inElse) {
        fail(filePath, "elif after else not allowed in mock prompt block", lineNo);
      }
      if (pendingPattern !== null) {
        fail(filePath, "respond \"...\" required after if/elif ... then before next elif", lineNo);
      }
      pendingPattern = elifMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      i += 1;
      continue;
    }
    if (line === "else") {
      if (inElse) {
        fail(filePath, "duplicate else in mock prompt block", lineNo);
      }
      if (pendingPattern !== null) {
        fail(filePath, "respond \"...\" required after if/elif ... then before else", lineNo);
      }
      inElse = true;
      i += 1;
      continue;
    }
    const respondMatch = line.match(/^respond\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (respondMatch) {
      const response = respondMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      if (inElse) {
        elseResponse = response;
      } else if (pendingPattern !== null) {
        branches.push({ pattern: pendingPattern, response });
        pendingPattern = null;
      } else {
        fail(filePath, "respond must follow if/elif ... then or else in mock prompt block", lineNo);
      }
      i += 1;
      continue;
    }
    if (line === "fi") {
      if (pendingPattern !== null) {
        fail(filePath, "respond \"...\" required after last elif ... then before fi", lineNo);
      }
      seenFi = true;
      i += 1;
      continue;
    }
    fail(
      filePath,
      'mock prompt block allows only: if ${arg1} contains "..." ; then, elif ..., else, respond "...", fi, }',
      lineNo,
    );
  }

  fail(filePath, "unterminated mock prompt block", blockStartLineNo);
}

/** Reads lines until "}" and returns body (trimmed lines joined) and nextIndex. */
function parseMockSymbolBlock(
  filePath: string,
  lines: string[],
  startLineIndex: number,
): { body: string; nextIndex: number } {
  const bodyLines: string[] = [];
  let i = startLineIndex + 1;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "}") {
      return { body: bodyLines.join("\n"), nextIndex: i + 1 };
    }
    bodyLines.push(raw);
    i += 1;
  }
  fail(filePath, "unterminated mock block", startLineIndex + 2);
}

function decodeQuotedTestString(arg: string, isDoubleQuoted: boolean): string {
  const inner = stripQuotes(arg);
  if (isDoubleQuoted) {
    return inner.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return inner.replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

export function parseTestBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
): { testBlock: TestBlockDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const testMatch = line.match(/^test\s+"((?:[^"\\]|\\.)*)"\s*\{\s*$/);
  if (!testMatch) {
    fail(filePath, 'test block must match: test "description" {', lineNo);
  }
  const description = testMatch[1].replace(/\\"/g, '"');
  const testBlock: TestBlockDef = {
    description,
    steps: [],
    loc: { line: lineNo, col: raw.indexOf("test") + 1 },
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
      continue;
    }
    const col = colFromRaw(innerRaw);
    const loc = { line: innerNo, col };

    if (inner.startsWith("mock prompt ")) {
      const arg = inner.slice("mock prompt ".length).trim();
      if (arg === "{") {
        const { step, nextIndex } = parseMockPromptBlock(filePath, lines, i, innerNo, colFromRaw(innerRaw));
        testBlock.steps.push(step);
        i = nextIndex - 1;
        continue;
      }
      const isDoubleQuoted = arg.startsWith('"') && hasUnescapedClosingQuote(arg, 1);
      const isSingleQuoted = /^'(?:[^'\\]|\\.)*'$/.test(arg);
      if (!isDoubleQuoted && !isSingleQuoted) {
        fail(filePath, 'mock prompt must be: mock prompt "<response>" or mock prompt { if ${arg1} contains "..." ; then respond "..." ; fi }', innerNo, innerRaw.indexOf("mock"));
      }
      testBlock.steps.push({
        type: "test_mock_prompt",
        response: decodeQuotedTestString(arg, isDoubleQuoted),
        loc,
      });
      continue;
    }
    const mockWorkflowMatch = inner.match(/^mock\s+workflow\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{\s*$/);
    if (mockWorkflowMatch) {
      const ref = mockWorkflowMatch[1];
      if (!isRef(ref)) {
        fail(filePath, "mock workflow ref must be <alias> or <alias>.<name>", innerNo, col);
      }
      const { body, nextIndex } = parseMockSymbolBlock(filePath, lines, i);
      testBlock.steps.push({ type: "test_mock_workflow", ref, body, loc });
      i = nextIndex - 1;
      continue;
    }
    const mockRuleMatch = inner.match(/^mock\s+rule\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{\s*$/);
    if (mockRuleMatch) {
      const ref = mockRuleMatch[1];
      if (!isRef(ref)) {
        fail(filePath, "mock rule ref must be <alias> or <alias>.<name>", innerNo, col);
      }
      const { body, nextIndex } = parseMockSymbolBlock(filePath, lines, i);
      testBlock.steps.push({ type: "test_mock_rule", ref, body, loc });
      i = nextIndex - 1;
      continue;
    }
    const mockScriptMatch = inner.match(/^mock\s+script\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{\s*$/);
    if (mockScriptMatch) {
      const ref = mockScriptMatch[1];
      if (!isRef(ref)) {
        fail(filePath, "mock script ref must be <name> or <alias>.<name>", innerNo, col);
      }
      const { body, nextIndex } = parseMockSymbolBlock(filePath, lines, i);
      testBlock.steps.push({ type: "test_mock_script", ref, body, loc });
      i = nextIndex - 1;
      continue;
    }
    if (/^mock\s+function\s+/.test(inner)) {
      fail(filePath, '"mock function" is no longer supported; use "mock script"', innerNo, col);
    }
    const expectContainMatch = inner.match(/^expectContain\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectContainMatch) {
      testBlock.steps.push({
        type: "test_expect_contain",
        variable: expectContainMatch[1],
        substring: expectContainMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }
    const expectNotContainMatch = inner.match(/^expectNotContain\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectNotContainMatch) {
      testBlock.steps.push({
        type: "test_expect_not_contain",
        variable: expectNotContainMatch[1],
        substring: expectNotContainMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }
    const expectEqualMatch = inner.match(/^expectEqual\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectEqualMatch) {
      testBlock.steps.push({
        type: "test_expect_equal",
        variable: expectEqualMatch[1],
        expected: expectEqualMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }
    const captureWithIgnoreFailureMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*)=\$\(\{\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+2>&1;\s*\}\s*\|\|\s*true\s*\)\s*(?:#.*)?$/,
    );
    if (captureWithIgnoreFailureMatch) {
      const captureName = captureWithIgnoreFailureMatch[1];
      const workflowRef = captureWithIgnoreFailureMatch[2];
      testBlock.steps.push({
        type: "test_run_workflow",
        captureName,
        workflowRef,
        allowFailure: true,
        loc,
      });
      continue;
    }
    const assignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(allow_failure))?\s*$/);
    if (assignMatch) {
      const captureName = assignMatch[1];
      const workflowRef = assignMatch[2];
      const arg1 = assignMatch[3];
      const allowFailure = assignMatch[4] === "allow_failure";
      if (!isRef(workflowRef)) {
        fail(filePath, "assignment in test must be: name = <workflow_ref> or name = <workflow_ref> \"arg\" or name = <workflow_ref> allow_failure", innerNo, col);
      }
      const args: string[] = arg1 !== undefined ? [arg1.replace(/\\"/g, '"').replace(/\\n/g, "\n")] : [];
      testBlock.steps.push({
        type: "test_run_workflow",
        captureName,
        workflowRef,
        args: args.length > 0 ? args : undefined,
        allowFailure: allowFailure || undefined,
        loc,
      });
      continue;
    }
    const runWorkflowMatch = inner.match(
      /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(allow_failure))?\s*$/,
    );
    if (runWorkflowMatch) {
      const workflowRef = runWorkflowMatch[1];
      const arg1 = runWorkflowMatch[2];
      const allowFailure = runWorkflowMatch[3] === "allow_failure";
      if (!isRef(workflowRef)) {
        fail(filePath, "workflow run in test must be <alias>.<workflow>", innerNo, col);
      }
      const args: string[] = arg1 !== undefined ? [arg1.replace(/\\"/g, '"').replace(/\\n/g, "\n")] : [];
      testBlock.steps.push({
        type: "test_run_workflow",
        workflowRef,
        args: args.length > 0 ? args : undefined,
        allowFailure: allowFailure || undefined,
        loc,
      });
      continue;
    }
    testBlock.steps.push({
      type: "test_shell",
      command: innerRaw,
      loc,
    });
  }

  if (i >= lines.length) {
    fail(filePath, `unterminated test block: ${description}`, lineNo);
  }
  return { testBlock, nextIndex: i + 1 };
}
