import { execFile } from "child_process";

// The Jaiph CLI contract this adapter depends on:
//   `jaiph compile --json <file>` prints a JSON array of diagnostics to stdout
//   (`[]` when the file is clean) and exits non-zero when any diagnostic exists.
// Tests in test/compile.test.ts run the real CLI so they break if that changes.
export interface CompileDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export type CompileResult =
  | { kind: "ok"; diagnostics: CompileDiagnostic[] }
  | { kind: "config-error"; message: string }
  | { kind: "error"; message: string };

interface ExecError extends Error {
  code?: string | number | null;
}

/** A spawn failure means the compiler binary could not be launched at all. */
export function isMissingBinaryError(err: ExecError | null | undefined): boolean {
  return !!err && (err.code === "ENOENT" || err.code === "EACCES");
}

/** Build the user-facing message for a missing/unreachable compiler binary. */
export function missingBinaryMessage(compilerPath: string, usingDefaultPath: boolean): string {
  if (usingDefaultPath) {
    return `Jaiph compiler ("jaiph") not found on PATH. Install the Jaiph CLI or set "jaiph.compilerPath" in your settings.`;
  }
  return `Jaiph compiler not found at configured "jaiph.compilerPath": ${compilerPath}. Fix the path or install the Jaiph CLI.`;
}

export interface RunCompileOptions {
  compilerPath: string;
  filePath: string;
  cwd?: string;
  /** True when jaiph.compilerPath was left at its default (not configured). */
  usingDefaultPath: boolean;
  timeoutMs?: number;
}

export function runCompile(opts: RunCompileOptions): Promise<CompileResult> {
  const { compilerPath, filePath, cwd, usingDefaultPath, timeoutMs = 15_000 } = opts;
  return new Promise<CompileResult>((resolve) => {
    execFile(
      compilerPath,
      ["compile", "--json", filePath],
      { cwd, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const err = error as ExecError | null;
        if (isMissingBinaryError(err)) {
          resolve({ kind: "config-error", message: missingBinaryMessage(compilerPath, usingDefaultPath) });
          return;
        }
        // `compile` exits non-zero when diagnostics exist but still prints them
        // to stdout, so parse stdout before treating a non-zero exit as failure.
        const text = stdout?.trim();
        if (text) {
          try {
            resolve({ kind: "ok", diagnostics: JSON.parse(text) as CompileDiagnostic[] });
          } catch {
            resolve({ kind: "error", message: `Jaiph compile produced unexpected output: ${text.slice(0, 200)}` });
          }
          return;
        }
        if (err) {
          resolve({ kind: "error", message: (stderr || err.message).trim() });
          return;
        }
        resolve({ kind: "ok", diagnostics: [] });
      },
    );
  });
}
