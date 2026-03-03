import type { TestBlockDef } from "../types";
import { colFromRaw, fail, hasUnescapedClosingQuote, isRef, stripQuotes } from "./core";

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
      if (!arg.startsWith('"') || !hasUnescapedClosingQuote(arg, 1)) {
        fail(filePath, 'mock prompt must be: mock prompt "<response>"', innerNo, innerRaw.indexOf("mock"));
      }
      testBlock.steps.push({
        type: "test_mock_prompt",
        response: stripQuotes(arg),
        loc,
      });
      continue;
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
    const assignMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*$/);
    if (assignMatch) {
      const captureName = assignMatch[1];
      const workflowRef = assignMatch[2];
      if (!isRef(workflowRef)) {
        fail(filePath, "assignment in test must be: name = <workflow_ref>", innerNo, col);
      }
      testBlock.steps.push({
        type: "test_run_workflow",
        captureName,
        workflowRef,
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
