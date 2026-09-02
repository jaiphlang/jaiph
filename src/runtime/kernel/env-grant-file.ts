// Off-process transport for the `--env` grant VALUE map.
//
// `--env KEY[=VALUE]` values must never sit on the runner (workflow-leader)
// process environment: a host key that was never granted, and a granted value
// that only a `use` script needs, would otherwise be readable by any child that
// inherits the leader's env. The value map is instead written to a private
// tmpdir file (outside the workspace and the run dir — paths a prompt backend
// can reach) and the detached leader reads it into an in-memory grant map at
// startup, then removes the file. Only the file *path* rides on the runner env
// (`ENV_GRANT_FILE_ENV`); the leader drops that key before any step runs, so no
// value and no path is inherited by a script or prompt child.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Runner env var naming the tmpdir file that carries the `--env` grant VALUE
 * map to the detached workflow leader. The grant *names* stay on
 * `JAIPH_ENV_GRANT`; only this path (never a value) rides on the runner env.
 */
export const ENV_GRANT_FILE_ENV = "JAIPH_ENV_GRANT_FILE";

/**
 * Write the `--env` grant VALUE map to a fresh private tmpdir file and return
 * its path. The values never touch the runner process environment. The caller
 * removes the returned file's dir when the run finishes; the leader also removes
 * it on read (`readEnvGrantFile`), so a normal run cleans up either way.
 */
export function writeEnvGrantFile(values: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-grant-"));
  const file = join(dir, "grant.json");
  writeFileSync(file, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * Read the grant VALUE map written by `writeEnvGrantFile`, then remove the file
 * and its dir. A missing/undefined path or an unreadable/invalid file yields an
 * empty map — fail-closed: an ungranted key is simply absent. Never throws.
 */
export function readEnvGrantFile(file: string | undefined): Record<string, string> {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, string>) };
    }
    return {};
  } catch {
    return {};
  } finally {
    try {
      rmSync(dirname(file), { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the caller may also remove it
    }
  }
}
