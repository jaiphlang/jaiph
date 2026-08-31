import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { basename } from "node:path";
import { buildScriptsFromGraph, walkTestFiles, loadModuleGraph } from "../../transpiler";
import { errText, jaiphError } from "../../errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs, resolveEnvPairs } from "../shared/usage";
import { runTestFile } from "../../runtime";

const TEST_USAGE =
  "Usage: jaiph test [--env KEY[=VALUE]]... [path]\n\n" +
  "Run *.test.jh modules. With no path, discovers every *.test.jh under the workspace\n" +
  "root. With a directory, runs every *.test.jh underneath (recursive). With a single\n" +
  "*.test.jh file, runs only that file.\n\n" +
  "  --env KEY=VALUE grant KEY to matching script and named-prompt `use` clauses\n" +
  "                  (repeatable); --env KEY forwards the host value. Unlike jaiph run,\n" +
  "                  a `use` key that is not granted does not fail the test — the key\n" +
  "                  is simply absent in the subprocess env.\n" +
  "  -h, --help      show this help\n\n" +
  "Example:\n" +
  "  jaiph test ./e2e/say_hello.test.jh\n";

export async function runTest(rest: string[]): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(TEST_USAGE);
    return 0;
  }
  const { positional, env } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);
  // `--env` grants `use` keys to script spawns (bare KEY still resolves the
  // host value and fails E_ENV_MISSING when unset). There is no `use`
  // pre-flight in the test lane: an ungranted key is absent in the spawn.
  let extraEnv: Record<string, string>;
  try {
    extraEnv = resolveEnvPairs(env, process.env);
  } catch (err) {
    process.stderr.write(`${errText(err)}\n`);
    return 1;
  }

  if (!input) {
    const workspaceRoot = detectWorkspaceRoot(process.cwd());
    const testFiles = walkTestFiles(workspaceRoot);
    if (testFiles.length === 0) {
      process.stderr.write("jaiph test: no *.test.jh files found (nothing to do)\n");
      return 0;
    }
    let exitCode = 0;
    for (const testFile of testFiles) {
      const code = await runSingleTestFile(testFile, workspaceRoot, runArgs, extraEnv);
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
      process.stderr.write("jaiph test: no *.test.jh files found (nothing to do)\n");
      return 0;
    }
    const workspaceRoot = detectWorkspaceRoot(inputAbs);
    let exitCode = 0;
    for (const testFile of testFiles) {
      const code = await runSingleTestFile(testFile, workspaceRoot, runArgs, extraEnv);
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
    return await runSingleTestFile(inputAbs, workspaceRoot, runArgs, extraEnv);
  }

  process.stderr.write(
    "jaiph test requires a *.test.jh file. Example:\n" +
      "  test \"...\" { mock prompt \"response\"; const r = run w.main(); expect_contain r \"...\"; }\n",
  );
  return 1;
}

export async function runSingleTestFile(
  testFileAbs: string,
  workspaceRoot: string,
  _runArgs: string[],
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const graph = loadModuleGraph(testFileAbs, workspaceRoot);
  const ast = graph.modules.get(graph.entryFile)!.ast;
  if (!ast.tests || ast.tests.length === 0) {
    throw jaiphError(ast.filePath, 1, 1, "E_PARSE", "test file must contain at least one test block");
  }

  // Build imported modules to extract scripts (needed for script steps)
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-test-"));
  try {
    /** Only compile the test module and its imports — not every `.jh` under the workspace. */
    const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
    return await runTestFile(graph, workspaceRoot, scriptsDir, ast.tests, extraEnv);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
