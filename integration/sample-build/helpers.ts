import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Inherited JAIPH_RUNS_DIR (e.g. from a developer shell) would send runs outside each temp
// workspace; these tests expect artifacts under `<cwd>/.jaiph/runs`.
delete process.env.JAIPH_RUNS_DIR;

/** Resolve latest run directory. Layout: runsRoot/YYYY-MM-DD/HH-MM-SS-source/ */
export function getLatestRunDir(runsRoot: string): string {
  const dateDirs = readdirSync(runsRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  assert.ok(dateDirs.length > 0, "expected at least one date directory under " + runsRoot);
  const dateDirPath = join(runsRoot, dateDirs[dateDirs.length - 1]);
  const runDirNames = readdirSync(dateDirPath).sort();
  assert.ok(runDirNames.length > 0, "expected at least one run directory under " + dateDirPath);
  return join(dateDirPath, runDirNames[runDirNames.length - 1]);
}

export function readCombinedRunLogs(runDir: string): { out: string; err: string } {
  const files = readdirSync(runDir);
  const out = files
    .filter((name) => name.endsWith(".out"))
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  const err = files
    .filter((name) => name.endsWith(".err"))
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  return { out, err };
}
