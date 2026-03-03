import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, extname } from "node:path";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { build, transpileTestFile, walkTestFiles } from "../../transpiler";
import { detectWorkspaceRoot } from "../shared/paths";
import { parseArgs } from "../shared/usage";

export async function runTest(rest: string[]): Promise<number> {
  const { positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);

  if (!input) {
    const workspaceRoot = detectWorkspaceRoot(process.cwd());
    const testFiles = walkTestFiles(workspaceRoot);
    if (testFiles.length === 0) {
      process.stderr.write("jaiph test: no *.test.jh or *.test.jph files found\n");
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
      process.stderr.write(`jaiph test: no *.test.jh or *.test.jph files in ${input}\n`);
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

  if (!inputStat.isFile() || (ext !== ".jph" && ext !== ".jh")) {
    process.stderr.write("jaiph test expects a .jh, .jph, *.test.jh, *.test.jph file or directory\n");
    return 1;
  }

  const isTestFile =
    basename(inputAbs).endsWith(".test.jh") || basename(inputAbs).endsWith(".test.jph");
  if (isTestFile) {
    const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
    return await runSingleTestFile(inputAbs, workspaceRoot, runArgs);
  }

  process.stderr.write(
    "jaiph test requires a *.test.jh or *.test.jph file with inline mock prompt steps. Example:\n" +
      "  test \"...\" { mock prompt \"response\"; response = w.default; expectContain response \"...\"; }\n",
  );
  return 1;
}

export async function runSingleTestFile(
  testFileAbs: string,
  workspaceRoot: string,
  _runArgs: string[],
): Promise<number> {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-test-"));
  try {
    build(workspaceRoot, outDir);
    const testBash = transpileTestFile(testFileAbs, workspaceRoot);
    const rel = relative(workspaceRoot, testFileAbs).replace(/\.(test\.jh|test\.jph)$/, ".test.sh");
    const testScriptPath = join(outDir, rel);
    mkdirSync(dirname(testScriptPath), { recursive: true });
    writeFileSync(testScriptPath, testBash, "utf8");
    chmodSync(testScriptPath, 0o755);

    const runtimeEnv = { ...process.env, JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;
    runtimeEnv.JAIPH_TEST_MODE = "1";
    runtimeEnv.JAIPH_TEST_FILE = basename(testFileAbs);
    if (runtimeEnv.JAIPH_STDLIB === undefined) {
      runtimeEnv.JAIPH_STDLIB = join(__dirname, "..", "..", "jaiph_stdlib.sh");
    }
    delete runtimeEnv.BASH_ENV;
    delete runtimeEnv.JAIPH_RUN_DIR;
    delete runtimeEnv.JAIPH_RUN_SUMMARY_FILE;
    delete runtimeEnv.JAIPH_PRECEDING_FILES;

    const result = spawnSync("bash", [testScriptPath], {
      encoding: "utf8",
      cwd: workspaceRoot,
      env: runtimeEnv,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status !== 0) {
      return result.status ?? 1;
    }
    return 0;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
