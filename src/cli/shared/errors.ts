import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function colorPalette(): { green: string; red: string; dim: string; reset: string } {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return { green: "", red: "", dim: "", reset: "" };
  }
  return {
    green: "\u001b[32m",
    red: "\u001b[31m",
    dim: "\u001b[2m",
    reset: "\u001b[0m",
  };
}

export function summarizeError(stderr: string, fallback?: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    return lines[lines.length - 1];
  }
  return fallback ?? "Workflow execution failed.";
}

export function hasFatalRuntimeStderr(stderr: string, debugEnabled: boolean): boolean {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  if (debugEnabled) {
    const nonXtraceLines = lines.filter((line) => !line.startsWith("+"));
    return nonXtraceLines.length > 0;
  }
  return true;
}

export type RunMeta = {
  output: string;
  status?: number;
  runDir?: string;
};

export function extractRunMeta(output: string): RunMeta {
  const lines = output.split(/\r?\n/);
  const visible: string[] = [];
  let status: number | undefined;
  let runDir: string | undefined;
  for (const line of lines) {
    if (line.startsWith("__JAIPH_META_STATUS__:")) {
      const raw = line.slice("__JAIPH_META_STATUS__:".length).trim();
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        status = parsed;
      }
      continue;
    }
    if (line.startsWith("__JAIPH_META_RUN_DIR__:")) {
      const raw = line.slice("__JAIPH_META_RUN_DIR__:".length).trim();
      if (raw) {
        runDir = raw;
      }
      continue;
    }
    visible.push(line);
  }
  return {
    output: visible.join("\n").trimEnd(),
    status,
    runDir,
  };
}

export function latestRunFiles(runDir: string): { out?: string; err?: string } {
  try {
    const files = readdirSync(runDir).sort();
    const out = [...files].reverse().find((name) => name.endsWith(".out"));
    const err = [...files].reverse().find((name) => name.endsWith(".err"));
    return {
      out: out ? join(runDir, out) : undefined,
      err: err ? join(runDir, err) : undefined,
    };
  } catch {
    return {};
  }
}

const FAILED_STEP_OUTPUT_MAX_LINES = 30;

export function readFailedStepOutput(summaryPath: string): string | null {
  if (!existsSync(summaryPath)) {
    return null;
  }
  try {
    const lines = readFileSync(summaryPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        type?: string;
        status?: number;
        out_file?: string;
        err_file?: string;
      };
      if (parsed.type === "STEP_END" && parsed.status !== 0) {
        const trimLines = (path: string): string => {
          if (!existsSync(path)) return "";
          const content = readFileSync(path, "utf8").trimEnd();
          const outputLines = content.split(/\n/);
          if (outputLines.length > FAILED_STEP_OUTPUT_MAX_LINES) {
            return outputLines.slice(-FAILED_STEP_OUTPUT_MAX_LINES).join("\n");
          }
          return content;
        };
        const outPath = typeof parsed.out_file === "string" ? parsed.out_file : "";
        const errPath = typeof parsed.err_file === "string" ? parsed.err_file : "";
        const outContent = outPath ? trimLines(outPath) : "";
        const errContent = errPath ? trimLines(errPath) : "";
        const parts: string[] = [];
        if (outContent) parts.push(outContent);
        if (errContent) parts.push(errContent);
        if (parts.length === 0) return null;
        return parts.join("\n");
      }
    }
  } catch {
    // ignore parse/read errors
  }
  return null;
}
