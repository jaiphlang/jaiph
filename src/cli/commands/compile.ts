import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadModuleGraph } from "../../transpile/module-graph";
import { collectDiagnostics } from "../../transpile/validate";
import { walkjhFiles } from "../../transpile/build";
import { detectWorkspaceRoot } from "../shared/paths";
import {
  diagnosticFromThrown as parseThrownDiagnostic,
  type JaiphDiagnostic,
} from "../../diagnostics";

export interface CompileDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Parse `path:line:col CODE message` from {@link jaiphError} and similar throws. */
export function diagnosticFromThrown(err: unknown): CompileDiagnostic | null {
  const d = parseThrownDiagnostic(err);
  return d ? { file: d.file, line: d.line, col: d.col, code: d.code, message: d.message } : null;
}

function toCompileDiagnostic(d: JaiphDiagnostic): CompileDiagnostic {
  return { file: d.file, line: d.line, col: d.col, code: d.code, message: d.message };
}

const COMPILE_USAGE =
  "Usage: jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...\n\n" +
  "Parse import closures and run validateReferences only (same compile-time checks as before jaiph run).\n" +
  "Does not emit scripts/, does not run buildRuntimeGraph, does not spawn the workflow runner.\n" +
  "With a directory, all non-test *.jh files are used as entrypoints; each file's import closure is validated.\n" +
  "Pass *.test.jh explicitly to validate a test module.\n\n" +
  "  --json             print one JSON array of diagnostics to stdout (empty on success)\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect per file)\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  jaiph compile flow.jh\n";

function printUsageError(): void {
  process.stderr.write(COMPILE_USAGE);
}

function writeDiagnostics(json: boolean, diags: CompileDiagnostic[]): void {
  if (json) {
    process.stdout.write(JSON.stringify(diags) + "\n");
    return;
  }
  for (const d of diags) {
    process.stderr.write(`${d.file}:${d.line}:${d.col} ${d.code} ${d.message}\n`);
  }
}

export function runCompile(args: string[]): number {
  let json = false;
  let workspaceFlag: string | undefined;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") {
      json = true;
      continue;
    }
    if (args[i] === "--workspace") {
      const w = args[i + 1];
      if (!w) {
        printUsageError();
        return 1;
      }
      workspaceFlag = resolve(w);
      i += 1;
      continue;
    }
    if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write(COMPILE_USAGE);
      return 0;
    }
    paths.push(args[i]);
  }

  if (paths.length === 0) {
    printUsageError();
    return 1;
  }

  const entries: Array<{ file: string; workspaceRoot: string }> = [];

  try {
    for (const p of paths) {
      const abs = resolve(p);
      if (!existsSync(abs)) {
        throw new Error(`no such file or directory: ${p}`);
      }
      const st = statSync(abs);
      if (st.isFile()) {
        if (!abs.endsWith(".jh")) {
          throw new Error(`compile expects .jh files: ${p}`);
        }
        const wr = workspaceFlag ?? detectWorkspaceRoot(dirname(abs));
        entries.push({ file: abs, workspaceRoot: wr });
      } else if (st.isDirectory()) {
        const wr = workspaceFlag ?? detectWorkspaceRoot(abs);
        for (const entry of walkjhFiles(abs)) {
          entries.push({ file: entry, workspaceRoot: wr });
        }
      } else {
        throw new Error(`not a file or directory: ${p}`);
      }
    }
  } catch (err) {
    const d = diagnosticFromThrown(err);
    const fallback: CompileDiagnostic = {
      file: "",
      line: 1,
      col: 1,
      code: "E_COMPILE",
      message: err instanceof Error ? err.message : String(err),
    };
    writeDiagnostics(json, [d ?? fallback]);
    return 1;
  }

  const collected: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const { file, workspaceRoot } of entries) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const graph = loadModuleGraph(file, workspaceRoot);
      const diag = collectDiagnostics(graph);
      for (const d of diag.sorted()) collected.push(toCompileDiagnostic(d));
      for (const reachable of graph.modules.keys()) seen.add(reachable);
    } catch (err) {
      // Loader / parser errors are fatal (unrecoverable AST). Surface them
      // as a single diagnostic; they do not flow through `Diagnostics`.
      const d = diagnosticFromThrown(err);
      collected.push(
        d ?? {
          file,
          line: 1,
          col: 1,
          code: "E_COMPILE",
          message: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  if (collected.length === 0) {
    if (json) process.stdout.write("[]\n");
    return 0;
  }
  writeDiagnostics(json, collected);
  return 1;
}
