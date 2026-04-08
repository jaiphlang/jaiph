import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { basename } from "node:path";
import { buildScripts, walkTestFiles } from "../../transpiler";
import { parsejaiph } from "../../parser";
import { jaiphError } from "../../errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { parseArgs } from "../shared/usage";
import { runTestFile } from "../../runtime/kernel/node-test-runner";

export async function runTest(rest: string[]): Promise<number> {
  const { positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);

  if (!input) {
    const workspaceRoot = detectWorkspaceRoot(process.cwd());
    const testFiles = walkTestFiles(workspaceRoot);
    if (testFiles.length === 0) {
      process.stderr.write("jaiph test: no *.test.jh files found\n");
      return 1;
    }
    let exitCode = 0;
    for (const testFile of testFiles) {
      const code = await runSingleTestFile(testFile, workspaceRoot, runArgs);
      if (code !== 0) exitCode = code;
    }
    return exitCode;
  }

  const inputAbs = resolve(input);
  const inputStat = statSync(inputAbs);
  const ext = extname(inputAbs);

  if (inputStat.isDirectory()) {
    const testFiles = walkTestFiles(inputAbs);
    if (testFiles.length === 0) {
      process.stderr.write(`jaiph test: no *.test.jh files in ${input}\n`);
      return 1;
    }
    const workspaceRoot = detectWorkspaceRoot(inputAbs);
    let exitCode = 0;
    for (const testFile of testFiles) {
      const code = await runSingleTestFile(testFile, workspaceRoot, runArgs);
      if (code !== 0) exitCode = code;
    }
    return exitCode;
  }

  if (!inputStat.isFile() || ext !== ".jh") {
    process.stderr.write("jaiph test expects a .jh or *.test.jh file or directory\n");
    return 1;
  }

  const isTestFile = basename(inputAbs).endsWith(".test.jh");
  if (isTestFile) {
    const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
    return await runSingleTestFile(inputAbs, workspaceRoot, runArgs);
  }

  process.stderr.write(
    "jaiph test requires a *.test.jh file with inline mock prompt steps. Example:\n" +
      "  test \"...\" { mock prompt \"response\"; response = w.default; expectContain response \"...\"; }\n",
  );
  return 1;
}

export async function runSingleTestFile(
  testFileAbs: string,
  workspaceRoot: string,
  _runArgs: string[],
): Promise<number> {
  const ast = parsejaiph(readFileSync(testFileAbs, "utf8"), testFileAbs);
  if (!ast.tests || ast.tests.length === 0) {
    throw jaiphError(ast.filePath, 1, 1, "E_PARSE", "test file must contain at least one test block");
  }

  // Build imported modules to extract scripts (needed for script steps)
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-test-"));
  try {
    /** Only compile the test module and its imports — not every `.jh` under the workspace. */
    const { scriptsDir } = buildScripts(testFileAbs, outDir, workspaceRoot);
    return await runTestFile(testFileAbs, workspaceRoot, scriptsDir, ast.tests);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
