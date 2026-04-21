import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTAINER_RUN_DIR } from "../../runtime/docker";

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

export type FailureDetails = {
  summary: string;
  failedStepOutput: string | null;
  shouldPrintSummaryLine: boolean;
};

/**
 * Resolve canonical failure details for CLI rendering.
 * Prefer detailed failed step output when available; summary is fallback-only.
 */
export function resolveFailureDetails(stderr: string, summaryPath?: string): FailureDetails {
  const summary = summarizeError(stderr, "Workflow execution failed.");
  const failedStepOutput = summaryPath ? readFailedStepOutput(summaryPath) : null;
  return {
    summary,
    failedStepOutput,
    shouldPrintSummaryLine: !failedStepOutput,
  };
}

export function hasFatalRuntimeStderr(stderr: string, debugEnabled: boolean): boolean {
  if (debugEnabled) {
    return false;
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
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

type FailedStepSummaryRecord = {
  out_file: string;
  err_file: string;
  out_content?: string;
  err_content?: string;
};

function readFirstFailedStepSummary(summaryPath: string): FailedStepSummaryRecord | null {
  if (!existsSync(summaryPath)) {
    return null;
  }
  try {
    const lines = readFileSync(summaryPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        type?: string;
        status?: number;
        out_file?: unknown;
        err_file?: unknown;
        out_content?: unknown;
        err_content?: unknown;
      };
      if (parsed.type !== "STEP_END" || parsed.status === 0) {
        continue;
      }
      return {
        out_file: typeof parsed.out_file === "string" ? parsed.out_file : "",
        err_file: typeof parsed.err_file === "string" ? parsed.err_file : "",
        out_content: typeof parsed.out_content === "string" ? parsed.out_content : undefined,
        err_content: typeof parsed.err_content === "string" ? parsed.err_content : undefined,
      };
    }
  } catch {
    // ignore parse/read errors
  }
  return null;
}

/** Artifact paths from the first failed STEP_END in the run summary (not lexicographic "latest" in the run dir). */
export function failedStepArtifactPaths(summaryPath: string): { out?: string; err?: string } {
  const rec = readFirstFailedStepSummary(summaryPath);
  if (!rec) {
    return {};
  }
  const result: { out?: string; err?: string } = {};
  if (rec.out_file) {
    result.out = rec.out_file;
  }
  if (rec.err_file) {
    result.err = rec.err_file;
  }
  return result;
}

export function readFailedStepOutput(summaryPath: string): string | null {
  const rec = readFirstFailedStepSummary(summaryPath);
  if (!rec) {
    return null;
  }
  const trimContent = (raw: string): string => {
    const trimmed = raw.trimEnd();
    const outputLines = trimmed.split(/\n/);
    if (outputLines.length > FAILED_STEP_OUTPUT_MAX_LINES) {
      return outputLines.slice(-FAILED_STEP_OUTPUT_MAX_LINES).join("\n");
    }
    return trimmed;
  };
  // Prefer embedded content from the event (works in both Docker and
  // non-Docker modes). Fall back to reading files only for older
  // summaries that lack embedded content.
  const readFileContent = (path: string): string => {
    if (!path || !existsSync(path)) return "";
    return readFileSync(path, "utf8").trimEnd();
  };
  const outRaw = rec.out_content !== undefined ? rec.out_content : readFileContent(rec.out_file);
  const errRaw = rec.err_content !== undefined ? rec.err_content : readFileContent(rec.err_file);
  const outContent = outRaw ? trimContent(outRaw) : "";
  const errContent = errRaw ? trimContent(errRaw) : "";
  const parts: string[] = [];
  if (outContent) parts.push(outContent);
  if (errContent) parts.push(errContent);
  if (parts.length === 0) return null;
  return parts.join("\n");
}

/**
 * Discover run directory from the Docker sandbox runs mount.
 * In Docker mode the container's meta file is inaccessible from the host,
 * so we scan the bind-mounted sandboxRunDir for the latest run directory.
 */
export function discoverDockerRunDir(sandboxRunDir: string): { runDir?: string; summaryFile?: string } {
  try {
    const dateDirs = readdirSync(sandboxRunDir)
      .filter((d) => !d.startsWith(".") && statSync(join(sandboxRunDir, d)).isDirectory())
      .sort()
      .reverse();
    for (const dateDir of dateDirs) {
      const datePath = join(sandboxRunDir, dateDir);
      const timeDirs = readdirSync(datePath)
        .filter((d) => statSync(join(datePath, d)).isDirectory())
        .sort()
        .reverse();
      for (const timeDir of timeDirs) {
        const runDir = join(datePath, timeDir);
        const summaryFile = join(runDir, "run_summary.jsonl");
        if (existsSync(summaryFile)) {
          return { runDir, summaryFile };
        }
      }
    }
  } catch {
    // ignore — sandboxRunDir may not exist or be readable
  }
  return {};
}

/** Remap a container-internal path to the equivalent host path. */
export function remapContainerPath(containerPath: string, sandboxRunDir: string): string {
  const prefix = CONTAINER_RUN_DIR + "/";
  if (containerPath.startsWith(prefix)) {
    return join(sandboxRunDir, containerPath.slice(CONTAINER_RUN_DIR.length));
  }
  if (containerPath === CONTAINER_RUN_DIR) {
    return sandboxRunDir;
  }
  return containerPath;
}
