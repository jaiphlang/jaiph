import { existsSync, realpathSync } from "node:fs";
import { relative } from "node:path";

/** Resolve an on-disk artifact path and ensure it stays under runsRoot (after realpath). */
export function safeArtifactPath(runsRootReal: string, candidate: string): string | null {
  if (!candidate || !existsSync(candidate)) {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  const rel = relative(runsRootReal, real);
  if (rel === "" || rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) {
    return null;
  }
  return real;
}
