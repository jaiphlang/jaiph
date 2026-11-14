import { execFile } from "child_process";
import { isMissingBinaryError, missingBinaryMessage } from "./compile";

// The Jaiph CLI contract this adapter depends on:
//   `jaiph graph [--def <name>] [-d <n|all>] [-i <n|all>] [-l] <file.jh>`
//   prints a Mermaid `flowchart TD` document to stdout and exits 0; on any
//   diagnostic or a missing def it prints the reason to stderr and exits 1.
// Tests in test/graph.test.ts run the real CLI so they break if that changes.

/** A depth limit as the CLI takes it: a non-negative integer, or "all". */
export type GraphLimit = number | "all";

export interface GraphPreviewOptions {
  def: string;
  depth: GraphLimit;
  importDepth: GraphLimit;
  libs: boolean;
}

/** Mirrors the CLI defaults (`--def main -d 3 -i 1`, no `-l`). */
export const DEFAULT_GRAPH_PREVIEW_OPTIONS: GraphPreviewOptions = {
  def: "main",
  depth: 3,
  importDepth: 1,
  libs: false,
};

export type GraphResult =
  | { kind: "ok"; mermaid: string }
  | { kind: "config-error"; message: string }
  | { kind: "error"; message: string };

export interface RunGraphOptions {
  compilerPath: string;
  filePath: string;
  options: GraphPreviewOptions;
  cwd?: string;
  /** True when jaiph.compilerPath was left at its default (not configured). */
  usingDefaultPath: boolean;
  timeoutMs?: number;
}

export function graphArgs(filePath: string, o: GraphPreviewOptions): string[] {
  const args = ["graph", "--def", o.def, "-d", String(o.depth), "-i", String(o.importDepth)];
  if (o.libs) args.push("-l");
  args.push(filePath);
  return args;
}

export function runGraph(opts: RunGraphOptions): Promise<GraphResult> {
  const { compilerPath, filePath, options, cwd, usingDefaultPath, timeoutMs = 15_000 } = opts;
  return new Promise<GraphResult>((resolve) => {
    execFile(
      compilerPath,
      graphArgs(filePath, options),
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (isMissingBinaryError(error as NodeJS.ErrnoException | null)) {
          resolve({ kind: "config-error", message: missingBinaryMessage(compilerPath, usingDefaultPath) });
          return;
        }
        if (error) {
          resolve({ kind: "error", message: (stderr || error.message).trim() });
          return;
        }
        resolve({ kind: "ok", mermaid: stdout });
      },
    );
  });
}

/**
 * Names of the defs declared at the top level of a Jaiph source, in source
 * order (what `--def` accepts). A light scan, not a parse: it only feeds the
 * preview's def picker, and the CLI still reports an unknown def.
 */
export function listDefNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^(?:export\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}
