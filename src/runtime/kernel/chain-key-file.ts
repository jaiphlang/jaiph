// Off-process transport for the per-run audit-chain HMAC key.
//
// The key must never sit on the workflow-leader's exec-time environment. A
// script child running as the same OS user can read its parent's exec env
// (`ps eww -p $PPID`, or `/proc/$PPID/environ` on Linux); a key found there
// would let the audited program forge a journal that verifies. So — exactly
// like the `--env` grant VALUE map (env-grant-file.ts) — the key is written to
// a private `0600` tmpdir file (outside the workspace and the run dir) and only
// the file *path* rides on the runner env (`CHAIN_KEY_FILE_ENV`). The detached
// leader reads the key into memory at startup and removes the file, then drops
// the path env var so no script/prompt child inherits even the pointer. The
// exec-time env therefore carries a path to an already-deleted file, never the
// secret itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Runner env var naming the tmpdir file that carries the per-run audit-chain
 * key to the detached workflow leader. Only this path (never the key) rides on
 * the runner env. Distinct from `JAIPH_AUDIT_KEY_DIR` (emit.ts), the
 * operator-side store where the key is *persisted* after the run finishes.
 */
export const CHAIN_KEY_FILE_ENV = "JAIPH_AUDIT_KEY_FILE";

/**
 * Write the per-run audit-chain key to a fresh private tmpdir file and return
 * its path. The key never touches the runner process environment. The caller
 * removes the returned file's dir when the run finishes; the leader also removes
 * it on read (`readChainKeyFile`), so a normal run cleans up either way.
 */
export function writeChainKeyFile(key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-chain-"));
  const file = join(dir, "key");
  writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * Read the key written by `writeChainKeyFile`, then remove the file and its dir.
 * A missing/undefined path or an unreadable file yields an empty string — the
 * chain stays self-consistent but no boundary verifies it (same contract as a
 * keyless in-process run, e.g. `jaiph test`). Never throws.
 */
export function readChainKeyFile(file: string | undefined): string {
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  } finally {
    try {
      rmSync(dirname(file), { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the caller may also remove it
    }
  }
}
