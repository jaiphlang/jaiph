import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { errText } from "../../errors";
import { loadModuleGraph, collectDiagnostics } from "../../transpiler";
import { buildGraph, emitMermaid, entryDefNames } from "../../graph";
import { detectWorkspaceRoot } from "../shared/paths";

const GRAPH_USAGE =
  "Usage: jaiph graph [--def <name>] [--workspace <dir>] <file.jh>\n\n" +
  "Print a def's execution flow as a Mermaid `flowchart TD` document to stdout.\n" +
  "Nothing runs: no scripts are emitted, no agent or prompt is called, and no\n" +
  "workflow runner is spawned. The file's import closure is parsed and validated\n" +
  "first (as jaiph compile does); any diagnostic goes to stderr with exit 1.\n\n" +
  "  --def <name>       entry def to graph (default: main; exported or not)\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  jaiph graph flow.jh\n" +
  "  jaiph graph --def helper flow.jh\n";

interface GraphArgs {
  def: string;
  workspace?: string;
  file?: string;
}

/** Parse graph flags; returns null to signal a usage error already printed. */
function parseGraphArgs(args: string[]): GraphArgs | null {
  let def = "main";
  let workspace: string | undefined;
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--def") {
      const v = args[i + 1];
      if (!v) return null;
      def = v;
      i += 1;
      continue;
    }
    if (arg === "--workspace") {
      const v = args[i + 1];
      if (!v) return null;
      workspace = resolve(v);
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return null;
    if (file !== undefined) return null;
    file = arg;
  }
  if (file === undefined) return null;
  return { def, workspace, file };
}

function writeDiagnosticLine(file: string, line: number, col: number, code: string, msg: string): void {
  process.stderr.write(`${file}:${line}:${col} ${code} ${msg}\n`);
}

export function runGraph(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(GRAPH_USAGE);
    return 0;
  }

  const parsed = parseGraphArgs(args);
  if (!parsed) {
    process.stderr.write(GRAPH_USAGE);
    return 1;
  }

  const abs = resolve(parsed.file!);
  if (parsed.file!.endsWith(".test.jh")) {
    process.stderr.write("jaiph graph: cannot graph a *.test.jh file\n\n");
    process.stderr.write(GRAPH_USAGE);
    return 1;
  }
  if (!parsed.file!.endsWith(".jh")) {
    process.stderr.write("jaiph graph: expects a .jh file\n\n");
    process.stderr.write(GRAPH_USAGE);
    return 1;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    process.stderr.write(`jaiph graph: no such file: ${parsed.file}\n`);
    return 1;
  }

  const workspaceRoot = parsed.workspace ?? detectWorkspaceRoot(dirname(abs));

  // Validation first — same per-module validator as jaiph compile. Any
  // diagnostic (or a fatal parser/loader throw) aborts with exit 1 and no
  // stdout.
  let graph;
  try {
    graph = loadModuleGraph(abs, workspaceRoot);
    const diag = collectDiagnostics(graph);
    const errors = diag.sorted();
    if (errors.length > 0) {
      for (const d of errors) writeDiagnosticLine(d.file, d.line, d.col, d.code, d.message);
      return 1;
    }
  } catch (err) {
    writeDiagnosticLine(abs, 1, 1, "E_COMPILE", errText(err));
    return 1;
  }

  const model = buildGraph(graph, parsed.def);
  if (!model) {
    const names = entryDefNames(graph);
    const available = names.length > 0 ? names.join(", ") : "(none)";
    process.stderr.write(
      `jaiph graph: no def "${parsed.def}" in ${parsed.file}. Available defs: ${available}\n`,
    );
    return 1;
  }

  process.stdout.write(emitMermaid(model));
  return 0;
}
