import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export function defaultRunsRoot(cwd: string): string {
  return resolve(cwd, ".jaiph/runs");
}

export function resolveRunsRoot(cwd: string, explicit?: string): string {
  const raw = explicit ? resolve(cwd, explicit) : defaultRunsRoot(cwd);
  if (!existsSync(raw)) {
    return raw;
  }
  return realpathSync(raw);
}

/**
 * Resolve a client-supplied run key (encodeURIComponent of posix rel path) to a safe
 * relative path under runs root, or null if traversal is attempted.
 */
export function safeRelativeRunPath(runsRootReal: string, runKey: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(runKey);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const abs = resolve(runsRootReal, decoded);
  const rel = relative(runsRootReal, abs);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    return null;
  }
  return rel.split(sep).join("/");
}

export function runDirFromRel(runsRootReal: string, relPosix: string): string {
  const parts = relPosix.split("/");
  return resolve(runsRootReal, ...parts);
}
