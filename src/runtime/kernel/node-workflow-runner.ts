import { basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadModuleGraph, readModuleGraph } from "../../transpile/module-graph";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

/**
 * Internal argv marker dispatched from `main` (src/cli/index.ts) to route the
 * remaining args here. Defined once so the CLI dispatcher and the spawn site
 * in `workflow-launch.ts` cannot drift.
 */
export const WORKFLOW_RUNNER_ARG = "__workflow-runner";

interface RunnerArgs {
  metaFile: string;
  sourceFile: string;
  builtScript: string;
  workflowName: string;
  runArgs: string[];
}

function parseRunnerArgs(positional: string[]): RunnerArgs {
  const metaFile = positional[0] ?? "";
  const sourceFile = positional[1] ?? process.env.JAIPH_SOURCE_ABS ?? "";
  const builtScript = positional[2] ?? "";
  const workflowName = positional[3] ?? "default";
  const runArgs = positional.slice(4);
  if (!metaFile || !sourceFile) {
    throw new Error("node-workflow-runner requires meta file and source file");
  }
  return { metaFile, sourceFile, builtScript, workflowName, runArgs };
}

/**
 * Run the workflow leader with the post-dispatch positional args
 * `[metaFile, sourceFile, builtScript, workflowName, ...runArgs]`.
 *
 * Callable from `src/cli/index.ts` when the reserved `__workflow-runner` argv
 * arrives, so the bun-compiled binary self-spawns into the runner without
 * needing a separate `node-workflow-runner.js` script on disk.
 */
export async function runWorkflowRunner(positional: string[]): Promise<number> {
  const { metaFile, sourceFile, builtScript, workflowName, runArgs } = parseRunnerArgs(positional);
  process.env.JAIPH_SOURCE_FILE = basename(sourceFile);
  if (!process.env.JAIPH_SCRIPTS && builtScript) {
    process.env.JAIPH_SCRIPTS = join(dirname(builtScript), "scripts");
  }
  const workspaceRoot = process.env.JAIPH_WORKSPACE || undefined;
  const graphFile = process.env.JAIPH_MODULE_GRAPH_FILE;
  const moduleGraph = graphFile ? readModuleGraph(graphFile) : loadModuleGraph(sourceFile, workspaceRoot);
  const graph = buildRuntimeGraph(moduleGraph);
  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: process.cwd() });
  const status = await runtime.runRoot(workflowName, runArgs);
  writeFileSync(
    metaFile,
    `status=${status}\nrun_dir=${runtime.getRunDir()}\nsummary_file=${runtime.getSummaryFile()}\n`,
    "utf8",
  );
  return status;
}

if (require.main === module) {
  runWorkflowRunner(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      process.stderr.write(`jaiph node runner: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
