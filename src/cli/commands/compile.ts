import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parsejaiph } from "../../parser";
import { validateReferences } from "../../transpile/validate";
import { resolveImportPath } from "../../transpile/resolve";
import { collectTransitiveJhModules, walkjhFiles } from "../../transpile/build";
import { detectWorkspaceRoot } from "../shared/paths";
import type { ValidateContext } from "../../transpile/validate";

export interface CompileDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Parse `path:line:col CODE message` from {@link jaiphError} and similar throws. */
export function diagnosticFromThrown(err: unknown): CompileDiagnostic | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/^(.+):(\d+):(\d+) (\S+) (.+)$/s);
  if (!m) return null;
  return {
    file: m[1],
    line: Number(m[2]),
    col: Number(m[3]),
    code: m[4],
    message: m[5].trimEnd(),
  };
}

function makeValidateContext(workspaceRoot?: string): ValidateContext {
  return {
    resolveImportPath,
    existsSync,
    readFile: (path: string) => readFileSync(path, "utf8"),
    parse: parsejaiph,
    workspaceRoot,
  };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...\n\n" +
      "Parse and validate modules (same checks as before `jaiph run`) without executing workflows.\n" +
      "With a directory, all non-test *.jh files are used as entrypoints; each file’s import closure is validated.\n\n" +
      "  --json       Print one JSON array of diagnostics to stdout (empty on success).\n" +
      "  --workspace  Override workspace root for import resolution for all paths.\n",
  );
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
        printUsage();
        return 1;
      }
      workspaceFlag = resolve(w);
      i += 1;
      continue;
    }
    if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      return 0;
    }
    paths.push(args[i]);
  }

  if (paths.length === 0) {
    printUsage();
    return 1;
  }

  const filesToValidate = new Set<string>();

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
        for (const f of collectTransitiveJhModules(abs, wr)) {
          filesToValidate.add(f);
        }
      } else if (st.isDirectory()) {
        const wr = workspaceFlag ?? detectWorkspaceRoot(abs);
        for (const entry of walkjhFiles(abs)) {
          for (const f of collectTransitiveJhModules(entry, wr)) {
            filesToValidate.add(f);
          }
        }
      } else {
        throw new Error(`not a file or directory: ${p}`);
      }
    }
  } catch (err) {
    const d = diagnosticFromThrown(err);
    if (json) {
      const fallback: CompileDiagnostic = {
        file: "",
        line: 1,
        col: 1,
        code: "E_COMPILE",
        message: err instanceof Error ? err.message : String(err),
      };
      process.stdout.write(JSON.stringify(d ? [d] : [fallback]) + "\n");
    } else {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    }
    return 1;
  }

  const sorted = [...filesToValidate].sort();
  const seen = new Set<string>();

  for (const file of sorted) {
    if (seen.has(file)) continue;
    seen.add(file);
    const wr = workspaceFlag ?? detectWorkspaceRoot(dirname(file));
    const ctx = makeValidateContext(wr);
    try {
      const ast = parsejaiph(readFileSync(file, "utf8"), file);
      validateReferences(ast, ctx);
    } catch (err) {
      const d = diagnosticFromThrown(err);
      if (json) {
        const fallback: CompileDiagnostic = {
          file,
          line: 1,
          col: 1,
          code: "E_COMPILE",
          message: err instanceof Error ? err.message : String(err),
        };
        process.stdout.write(JSON.stringify(d ? [d] : [fallback]) + "\n");
      } else {
        process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
      }
      return 1;
    }
  }

  if (json) {
    process.stdout.write("[]\n");
  }
  return 0;
}
