import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parsejaiph } from "./parser";
import { validateReferences } from "./transpile/validate";
import { resolveImportPath } from "./transpile/resolve";

// --- txtar parser ---

interface TxtarTestCase {
  name: string;
  expect:
    | { kind: "ok" }
    | { kind: "error"; code: string; substring: string; line?: number; col?: number };
  files: Map<string, string>;
}

function parseTxtar(content: string): TxtarTestCase[] {
  const cases: TxtarTestCase[] = [];
  const blocks = content.split(/^=== /m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const name = lines[0].trim();

    let expectLine: string | undefined;
    let fileStartIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("# @expect ")) {
        expectLine = line;
      }
      if (lines[i].startsWith("--- ")) {
        fileStartIdx = i;
        break;
      }
    }

    if (!expectLine) {
      throw new Error(`Test case "${name}": missing # @expect directive`);
    }
    if (fileStartIdx === -1) {
      throw new Error(`Test case "${name}": no virtual files (missing --- marker)`);
    }

    const expect = parseExpectDirective(name, expectLine);
    const files = parseVirtualFiles(lines.slice(fileStartIdx));

    cases.push({ name, expect, files });
  }
  return cases;
}

function parseExpectDirective(
  testName: string,
  line: string,
):
  | { kind: "ok" }
  | { kind: "error"; code: string; substring: string; line?: number; col?: number } {
  const after = line.slice("# @expect ".length).trim();
  if (after === "ok") return { kind: "ok" };

  const errorMatch = after.match(/^error\s+(\S+)\s+"(.+)"(?:\s+@(\d+)(?::(\d+))?)?$/);
  if (errorMatch) {
    const result: { kind: "error"; code: string; substring: string; line?: number; col?: number } =
      { kind: "error", code: errorMatch[1], substring: errorMatch[2] };
    if (errorMatch[3] !== undefined) result.line = parseInt(errorMatch[3], 10);
    if (errorMatch[4] !== undefined) result.col = parseInt(errorMatch[4], 10);
    return result;
  }
  throw new Error(`Test case "${testName}": invalid @expect directive: ${line}`);
}

function parseVirtualFiles(lines: string[]): Map<string, string> {
  const files = new Map<string, string>();
  let currentFile: string | undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (currentFile !== undefined) {
        files.set(currentFile, currentLines.join("\n") + "\n");
      }
      currentFile = line.slice(4).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentFile !== undefined) {
    files.set(currentFile, currentLines.join("\n") + "\n");
  }
  return files;
}

// --- test execution ---

function entryFile(files: Map<string, string>): string {
  if (files.has("main.jh")) return "main.jh";
  if (files.has("input.jh")) return "input.jh";
  if (files.has("input.test.jh")) return "input.test.jh";
  const first = files.keys().next().value;
  if (!first) throw new Error("No virtual files in test case");
  return first;
}

function runTestCase(tc: TxtarTestCase): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-compiler-test-"));
  try {
    for (const [name, content] of tc.files) {
      writeFileSync(join(tmpDir, name), content, "utf8");
    }
    const entry = entryFile(tc.files);
    const entryPath = join(tmpDir, entry);

    let caughtError: Error | undefined;
    try {
      const ast = parsejaiph(readFileSync(entryPath, "utf8"), entryPath);
      validateReferences(ast, {
        resolveImportPath,
        existsSync: (p: string) => existsSync(p),
        readFile: (p: string) => readFileSync(p, "utf8"),
        parse: parsejaiph,
      });
    } catch (err) {
      caughtError = err as Error;
    }

    if (tc.expect.kind === "ok") {
      if (caughtError) {
        assert.fail(
          `Expected success but got error: ${caughtError.message}`,
        );
      }
    } else {
      if (!caughtError) {
        assert.fail(
          `Expected error ${tc.expect.code} "${tc.expect.substring}" but compilation succeeded`,
        );
      }
      const msg = caughtError.message;
      assert.ok(
        msg.includes(tc.expect.code),
        `Error message should contain code "${tc.expect.code}", got: ${msg}`,
      );
      assert.ok(
        msg.includes(tc.expect.substring),
        `Error message should contain "${tc.expect.substring}", got: ${msg}`,
      );
      if (tc.expect.line !== undefined) {
        const locMatch = msg.match(/:(\d+):(\d+)\s/);
        assert.ok(locMatch, `Error message should contain :line:col prefix, got: ${msg}`);
        assert.equal(
          parseInt(locMatch![1], 10),
          tc.expect.line,
          `Expected error at line ${tc.expect.line} but got line ${locMatch![1]}, msg: ${msg}`,
        );
        if (tc.expect.col !== undefined) {
          assert.equal(
            parseInt(locMatch![2], 10),
            tc.expect.col,
            `Expected error at col ${tc.expect.col} but got col ${locMatch![2]}, msg: ${msg}`,
          );
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- meta-test support ---

/**
 * Verifies that a deliberately wrong expectation actually fails.
 * Returns true if the test case correctly fails (i.e., the runner detects the mismatch).
 */
export function expectFailure(tc: TxtarTestCase): boolean {
  try {
    runTestCase(tc);
    return false; // should have failed
  } catch {
    return true; // correctly detected mismatch
  }
}

// --- main: discover and run all txtar files ---

const fixturesDir = resolve(process.cwd(), "compiler-tests");
const txtarFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".txt"));

for (const file of txtarFiles) {
  const content = readFileSync(join(fixturesDir, file), "utf8");
  const cases = parseTxtar(content);

  for (const tc of cases) {
    test(`${file} > ${tc.name}`, () => {
      runTestCase(tc);
    });
  }
}

// --- meta-test: verify intentionally wrong expectations are caught ---

test("meta: wrong expectation is detected as failure", () => {
  const wrongCase: TxtarTestCase = {
    name: "meta-wrong",
    expect: { kind: "error", code: "E_PARSE", substring: "this will not match anything" },
    files: new Map([["input.jh", 'workflow default() {\n  log "hello"\n}\n']]),
  };
  assert.ok(
    expectFailure(wrongCase),
    "A valid program with an error expectation should be detected as a test failure",
  );
});

test("meta: wrong @line is detected as failure", () => {
  const wrongLine: TxtarTestCase = {
    name: "meta-wrong-line",
    expect: { kind: "error", code: "E_PARSE", substring: "unterminated workflow block", line: 999 },
    files: new Map([["input.jh", "workflow default() {\n  log \"hello\"\n"]]),
  };
  assert.ok(
    expectFailure(wrongLine),
    "A wrong @line expectation should be detected as a test failure",
  );
});

test("meta: wrong @col is detected as failure", () => {
  const wrongCol: TxtarTestCase = {
    name: "meta-wrong-col",
    expect: { kind: "error", code: "E_PARSE", substring: "unterminated workflow block", line: 1, col: 999 },
    files: new Map([["input.jh", "workflow default() {\n  log \"hello\"\n"]]),
  };
  assert.ok(
    expectFailure(wrongCol),
    "A wrong @col expectation should be detected as a test failure",
  );
});

test("meta: wrong ok expectation on broken input is detected", () => {
  const wrongCase: TxtarTestCase = {
    name: "meta-wrong-ok",
    expect: { kind: "ok" },
    files: new Map([["input.jh", "workflow default() {\n  log \"hello\"\n"]]),
  };
  assert.ok(
    expectFailure(wrongCase),
    "A broken program with an ok expectation should be detected as a test failure",
  );
});

export { parseTxtar, runTestCase };
export type { TxtarTestCase };
