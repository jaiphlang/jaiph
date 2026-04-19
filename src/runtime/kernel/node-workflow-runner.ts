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
  const workspaceRoot = process.env.JAIPH_WORKSPACE || undefined;
  const graph = buildRuntimeGraph(sourceFile, workspaceRoot);
  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: process.cwd() });
  let status: number;
  let returnValue: string | undefined;
  let output = "";
  if (workflowName === "default") {
    status = await runtime.runDefault(runArgs);
  } else {
    const result = await runtime.runNamedWorkflow(workflowName, runArgs);
    status = result.status;
    returnValue = result.returnValue;
    output = result.output;
  }
  let meta = `status=${status}\nrun_dir=${runtime.getRunDir()}\nsummary_file=${runtime.getSummaryFile()}\n`;
  if (returnValue !== undefined) meta += `return_value=${returnValue}\n`;
  if (output) meta += `output=${output}\n`;
  writeFileSync(metaFile, meta, "utf8");
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
