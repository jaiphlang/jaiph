import type { MatchArmDef, TestBlockDef, WorkflowStepDef } from "../types";
import { colFromRaw, fail, hasUnescapedClosingQuote, isRef, parseParamList, stripQuotes } from "./core";
import { parseMatchArms } from "./match";
import { parseBraceBlockBody } from "./workflow-brace";

function parseMockPromptBlock(
  filePath: string,
  lines: string[],
  startLineIndex: number,
  blockStartLineNo: number,
  blockStartCol: number,
): {
  step: {
    type: "test_mock_prompt_block";
    arms: MatchArmDef[];
    loc: { line: number; col: number };
  };
  nextIndex: number;
} {
  const { arms, nextIndex } = parseMatchArms(filePath, lines, startLineIndex + 1, blockStartLineNo);
  if (arms.length === 0) {
    fail(filePath, "mock prompt block must have at least one arm", blockStartLineNo);
  }
  return {
    step: {
      type: "test_mock_prompt_block",
      arms,
      loc: { line: blockStartLineNo, col: blockStartCol },
    },
    nextIndex,
  };
}

/** Reads lines until "}" and returns body (trimmed lines joined) and nextIndex. */
function parseMockScriptBlock(
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

function decodeQuotedTestString(arg: string): string {
  const inner = stripQuotes(arg);
  return inner.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/** Parse mock params: "()" or "(a, b)" from a string like "alias.name(a, b) {" */
function parseMockHeader(
  filePath: string,
  inner: string,
  prefix: string,
  lineNo: number,
  col: number,
): { ref: string; params: string[]; hasBlock: boolean } | null {
  if (!inner.startsWith(prefix)) return null;
  const after = inner.slice(prefix.length).trim();
  // Match: ref(params) { or ref() {
  const m = after.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(([^)]*)\)\s*\{\s*$/);
  if (!m) return null;
  const ref = m[1];
  if (!isRef(ref)) {
    fail(filePath, `mock ${prefix.split(/\s+/).pop()} ref must be <alias> or <alias>.<name>`, lineNo, col);
  }
  const params = m[2].trim() ? parseParamList(filePath, m[2], lineNo) : [];
  return { ref, params, hasBlock: true };
}

/** Reject old mock syntax without parens: `mock workflow ref {` */
function rejectOldMockSyntax(
  filePath: string,
  inner: string,
  keyword: string,
  lineNo: number,
  col: number,
): void {
  const prefix = `mock ${keyword} `;
  if (!inner.startsWith(prefix)) return;
  const after = inner.slice(prefix.length).trim();
  // Old syntax: ref { (no parens)
  const oldMatch = after.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{\s*$/);
  if (oldMatch) {
    fail(filePath, `mock ${keyword} requires parentheses: mock ${keyword} ${oldMatch[1]}() { … }`, lineNo, col);
  }
}

export function parseTestBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  leadingComments?: string[],
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
  if (leadingComments && leadingComments.length > 0) {
    testBlock.leadingComments = [...leadingComments];
  }

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

    // --- mock prompt ---
    if (inner.startsWith("mock prompt ")) {
      const arg = inner.slice("mock prompt ".length).trim();
      if (arg === "{") {
        const { step, nextIndex } = parseMockPromptBlock(filePath, lines, i, innerNo, colFromRaw(innerRaw));
        testBlock.steps.push(step);
        i = nextIndex - 1;
        continue;
      }
      if (arg.startsWith("'")) {
        fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', innerNo, innerRaw.indexOf("mock"));
      }
      const isDoubleQuoted = arg.startsWith('"') && hasUnescapedClosingQuote(arg, 1);
      if (!isDoubleQuoted) {
        fail(filePath, 'mock prompt must be: mock prompt "<response>" or mock prompt { "pattern" => "response", _ => "default" }', innerNo, innerRaw.indexOf("mock"));
      }
      testBlock.steps.push({
        type: "test_mock_prompt",
        response: decodeQuotedTestString(arg),
        loc,
      });
      continue;
    }

    // --- mock workflow (new: requires parens, body is Jaiph steps) ---
    rejectOldMockSyntax(filePath, inner, "workflow", innerNo, col);
    const mockWfHeader = parseMockHeader(filePath, inner, "mock workflow ", innerNo, col);
    if (mockWfHeader) {
      const { steps, nextIdx } = parseBraceBlockBody(filePath, lines, i + 1, innerNo, { forRule: false });
      testBlock.steps.push({ type: "test_mock_workflow", ref: mockWfHeader.ref, params: mockWfHeader.params, steps, loc });
      i = nextIdx - 1;
      continue;
    }

    // --- mock rule (new: requires parens, body is Jaiph steps) ---
    rejectOldMockSyntax(filePath, inner, "rule", innerNo, col);
    const mockRuleHeader = parseMockHeader(filePath, inner, "mock rule ", innerNo, col);
    if (mockRuleHeader) {
      const { steps, nextIdx } = parseBraceBlockBody(filePath, lines, i + 1, innerNo, { forRule: true });
      testBlock.steps.push({ type: "test_mock_rule", ref: mockRuleHeader.ref, params: mockRuleHeader.params, steps, loc });
      i = nextIdx - 1;
      continue;
    }

    // --- mock script (new: requires parens, body stays shell) ---
    rejectOldMockSyntax(filePath, inner, "script", innerNo, col);
    const mockScriptHeader = parseMockHeader(filePath, inner, "mock script ", innerNo, col);
    if (mockScriptHeader) {
      const { body, nextIndex } = parseMockScriptBlock(filePath, lines, i);
      testBlock.steps.push({ type: "test_mock_script", ref: mockScriptHeader.ref, params: mockScriptHeader.params, body, loc });
      i = nextIndex - 1;
      continue;
    }

    // --- mock function (deprecated) ---
    if (/^mock\s+function\s+/.test(inner)) {
      fail(filePath, '"mock function" is no longer supported; use "mock script"', innerNo, col);
    }

    // --- expect_contain (snake_case) ---
    const expectContainMatch = inner.match(/^expect_contain\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectContainMatch) {
      testBlock.steps.push({
        type: "test_expect_contain",
        variable: expectContainMatch[1],
        substring: expectContainMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }

    // --- expect_not_contain (snake_case) ---
    const expectNotContainMatch = inner.match(/^expect_not_contain\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectNotContainMatch) {
      testBlock.steps.push({
        type: "test_expect_not_contain",
        variable: expectNotContainMatch[1],
        substring: expectNotContainMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }

    // --- expect_equal (snake_case) ---
    const expectEqualMatch = inner.match(/^expect_equal\s+([A-Za-z_][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (expectEqualMatch) {
      testBlock.steps.push({
        type: "test_expect_equal",
        variable: expectEqualMatch[1],
        expected: expectEqualMatch[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        loc,
      });
      continue;
    }

    // --- Reject old camelCase assertions ---
    if (/^expectContain\s/.test(inner)) {
      fail(filePath, 'camelCase assertions are no longer supported; use "expect_contain"', innerNo, col);
    }
    if (/^expectNotContain\s/.test(inner)) {
      fail(filePath, 'camelCase assertions are no longer supported; use "expect_not_contain"', innerNo, col);
    }
    if (/^expectEqual\s/.test(inner)) {
      fail(filePath, 'camelCase assertions are no longer supported; use "expect_equal"', innerNo, col);
    }

    // --- const capture = run ref("args") [allow_failure] ---
    const constRunMatch = inner.match(
      /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(([^)]*)\)(?:\s+(allow_failure))?\s*$/,
    );
    if (constRunMatch) {
      const captureName = constRunMatch[1];
      const workflowRef = constRunMatch[2];
      if (!isRef(workflowRef)) {
        fail(filePath, "const ... = run must target a valid reference: const name = run ref(args)", innerNo, col);
      }
      const argsRaw = constRunMatch[3].trim();
      const args: string[] = argsRaw ? parseTestCallArgs(argsRaw) : [];
      const allowFailure = constRunMatch[4] === "allow_failure";
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

    // --- run ref("args") [allow_failure] (no capture) ---
    const runMatch = inner.match(
      /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(([^)]*)\)(?:\s+(allow_failure))?\s*$/,
    );
    if (runMatch) {
      const workflowRef = runMatch[1];
      if (!isRef(workflowRef)) {
        fail(filePath, "run in test must target a valid reference: run ref(args)", innerNo, col);
      }
      const argsRaw = runMatch[2].trim();
      const args: string[] = argsRaw ? parseTestCallArgs(argsRaw) : [];
      const allowFailure = runMatch[3] === "allow_failure";
      testBlock.steps.push({
        type: "test_run_workflow",
        workflowRef,
        args: args.length > 0 ? args : undefined,
        allowFailure: allowFailure || undefined,
        loc,
      });
      continue;
    }

    // --- Reject old syntax: bare assignment without const/run ---
    const oldAssignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s|$)/);
    if (oldAssignMatch) {
      fail(filePath, `use "const ${oldAssignMatch[1]} = run ${oldAssignMatch[2]}(…)" to capture workflow output`, innerNo, col);
    }

    // --- Reject old syntax: bare workflow call without run ---
    const oldBareCallMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)(?:\s|$)/);
    if (oldBareCallMatch) {
      fail(filePath, `use "run ${oldBareCallMatch[1]}(…)" to call a workflow in tests`, innerNo, col);
    }

    // --- No fallback: reject unrecognized lines ---
    fail(filePath, `unrecognized test step: ${inner}`, innerNo, col);
  }

  if (i >= lines.length) {
    fail(filePath, `unterminated test block: ${description}`, lineNo);
  }
  return { testBlock, nextIndex: i + 1 };
}

/** Parse comma-separated args from inside parentheses: "arg1", "arg2" */
function parseTestCallArgs(argsRaw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  for (let j = 0; j < argsRaw.length; j += 1) {
    const ch = argsRaw[j];
    if (ch === '"' && (j === 0 || argsRaw[j - 1] !== "\\")) {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      const trimmed = current.trim();
      if (trimmed) args.push(decodeTestArg(trimmed));
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) args.push(decodeTestArg(trimmed));
  return args;
}

function decodeTestArg(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return token;
}
