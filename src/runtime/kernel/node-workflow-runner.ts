import { basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

function parseArgs(argv: string[]): {
  metaFile: string;
  sourceFile: string;
  builtScript: string;
  workflowName: string;
  runArgs: string[];
} {
  const metaFile = argv[2] ?? "";
  const sourceFile = argv[3] ?? process.env.JAIPH_SOURCE_ABS ?? "";
  const builtScript = argv[4] ?? "";
  const workflowName = argv[5] ?? "default";
  const runArgs = argv.slice(6);
  if (!metaFile || !sourceFile) {
    throw new Error("node-workflow-runner requires meta file and source file");
  }
  return { metaFile, sourceFile, builtScript, workflowName, runArgs };
}

async function main(): Promise<number> {
  const { metaFile, sourceFile, builtScript, workflowName, runArgs } = parseArgs(process.argv);
  process.env.JAIPH_SOURCE_FILE = basename(sourceFile);
  if (!process.env.JAIPH_SCRIPTS && builtScript) {
    process.env.JAIPH_SCRIPTS = join(dirname(builtScript), "scripts");
  }
  const graph = buildRuntimeGraph(sourceFile);
  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: process.cwd() });
  const status = workflowName === "default" ? await runtime.runDefault(runArgs) : 1;
  writeFileSync(
    metaFile,
    `status=${status}\nrun_dir=${runtime.getRunDir()}\nsummary_file=${runtime.getSummaryFile()}\n`,
    "utf8",
  );
  return status;
}

if (require.main === module) {
  main()
    .then((status) => process.exit(status))
    .catch((err) => {
      process.stderr.write(`jaiph node runner: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
