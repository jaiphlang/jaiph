/**
 * Runtime event emission helpers used by the Node workflow runtime.
 *
 * The durable `run_summary.jsonl` journal is written by the trusted kernel
 * process, but its integrity is protected by a *keyed* HMAC chain: each line's
 * `prev_hash` is `chainHmac(key, previousRawLine)`. The per-run key is held by
 * the host and the kernel process only — it is scrubbed from every script /
 * agent subprocess env (see `scrubKernelKeys` in node-workflow-runtime.ts and
 * `scrubPromptEnv` in env-allowlist.ts). An audited workflow can therefore
 * delete or rewrite the journal on disk, but it cannot forge a chain that
 * verifies, so every read/export boundary can detect the tamper and hard-fail.
 *
 * The persisted key lives in an operator-side store (`resolveAuditKeyStore`)
 * OUTSIDE the agent-writable run directory, so a workflow cannot squat the key
 * path or delete the key to disable its own tamper evidence (finding M-3).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Env var carrying the per-run HMAC chain key into the trusted kernel process.
 * Always referenced through this constant (never as a literal `env.JAIPH_*`)
 * so it stays an internal key: it must never appear in a script/agent
 * subprocess env or in user-facing docs.
 */
export const CHAIN_KEY_ENV = "JAIPH_CHAIN_KEY";

/** Sentinel seed hashed under the key to produce the first line's prev_hash. */
export const CHAIN_GENESIS = "0".repeat(64);

/**
 * Terminal journal marker. A run that reached its end emits exactly one
 * `RUN_END` as the LAST line of `run_summary.jsonl` (see
 * `NodeWorkflowRuntime.runRoot`). Boundary verification requires this line so a
 * completed journal whose tail was truncated — a shorter-but-internally-valid
 * chain — is rejected (finding L-3).
 */
export const TERMINAL_EVENT_TYPE = "RUN_END";

/** Journal basename inside a run directory. */
const RUN_SUMMARY = "run_summary.jsonl";

/** Basename of the secret key file inside a run's store entry directory. */
const KEY_FILE = "key";

/**
 * Operator-side directory that holds per-run audit-chain keys. It lives OUTSIDE
 * the run directory — which is agent-writable (`$JAIPH_RUN_DIR` for script
 * steps) — so a program cannot squat the key path, delete the key, or
 * otherwise disable its own tamper evidence (finding M-3). Default: the
 * operator's home `.jaiph/audit-keys`; override with `JAIPH_AUDIT_KEY_DIR`
 * (e.g. to place keys on a locked-down volume). Read by the CLI only — the
 * kernel never resolves this.
 */
export function resolveAuditKeyStore(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAIPH_AUDIT_KEY_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".jaiph", "audit-keys");
}

/**
 * Per-run store entry directory: `<store>/<sha256(canonical run dir)>`. Keyed by
 * the run directory's canonical filesystem identity — stable across the write
 * and every later verify, and NOT forgeable from an agent-writable file (a run
 * id read back from the tamperable journal would be). The directory's existence
 * is the durable "this run was launched with a key" marker; the `key` file
 * inside it holds the secret.
 */
function auditKeyEntryDir(runDir: string, env: NodeJS.ProcessEnv = process.env): string {
  let canonical: string;
  try {
    canonical = realpathSync(runDir);
  } catch {
    canonical = resolve(runDir);
  }
  const id = createHash("sha256").update(canonical, "utf8").digest("hex");
  return join(resolveAuditKeyStore(env), id);
}

/** Absolute path of a run's persisted key file (may not exist yet). */
export function chainKeyPath(runDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(auditKeyEntryDir(runDir, env), KEY_FILE);
}

/** A fresh 256-bit per-run key as lowercase hex. */
export function generateChainKey(): string {
  return randomBytes(32).toString("hex");
}

/** Keyed chain digest: HMAC-SHA256(key, data) as lowercase hex. */
export function chainHmac(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * Persist the per-run key in the operator-side store (host-side, after the run
 * is terminal), so read/export boundaries can verify the chain. The store entry
 * directory is created FIRST — its existence is the tamper-evident "this run is
 * keyed" marker — then the key file is written `0600`.
 *
 * A failure to persist is a HARD error (finding M-3): without a durable key the
 * chain is unverifiable, so the caller must surface it rather than silently
 * continue as the old best-effort form did. Because the marker directory is
 * created before the key, even a partial failure leaves the run marked
 * keyed-but-keyless, which `verifyRunJournal` reports as a fail-closed integrity
 * failure rather than an unverifiable pass.
 */
export function writeChainKey(runDir: string, key: string, env: NodeJS.ProcessEnv = process.env): void {
  const entry = auditKeyEntryDir(runDir, env);
  mkdirSync(entry, { recursive: true, mode: 0o700 });
  writeFileSync(join(entry, KEY_FILE), key, { mode: 0o600 });
}

/** Read the per-run key from the operator-side store, or null when none exists. */
export function readChainKey(runDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const k = readFileSync(chainKeyPath(runDir, env), "utf8").trim();
    return k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

/** Whether a run was launched with a persisted key (its store entry exists). */
function isKeyedRun(runDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return existsSync(auditKeyEntryDir(runDir, env));
  } catch {
    return false;
  }
}

/**
 * Verify the keyed hash chain of a run_summary.jsonl file.
 *
 * Each line must carry `prev_hash` equal to `chainHmac(key, previousRawLine)`
 * (or `chainHmac(key, CHAIN_GENESIS)` for the first line). Returns
 * `{ ok: false, error }` at the first broken link, or when the file is
 * unreadable — a deleted/truncated journal is a verification failure, not a
 * silent pass. Because the key is unavailable to the audited workflow, a chain
 * recomputed under the public SHA-256 algorithm (without the key) does not
 * verify: the very first `prev_hash` already fails to match the keyed genesis.
 *
 * With `opts.requireTerminal`, the journal must additionally END with the
 * `RUN_END` terminal marker (finding L-3). The chain alone commits only to
 * prefix integrity, not to length or terminality: deleting the last K lines of
 * a completed journal leaves a shorter chain that still links correctly and
 * would otherwise verify `ok:true`. Requiring the terminal marker — always the
 * last line a completed run emits — rejects any post-terminal tail truncation.
 * Boundary callers (`verifyRunJournal`) set this because a persisted key is only
 * written once the run is terminal, so a keyed journal is always expected to end
 * with `RUN_END`.
 */
export function verifyRunSummaryChain(
  filePath: string,
  key: string,
  opts: { requireTerminal?: boolean } = {},
): { ok: boolean; error?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, error: "journal unreadable (missing or truncated)" };
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let expected = chainHmac(key, CHAIN_GENESIS);
  let lastType: unknown = undefined;
  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `line ${i + 1}: invalid JSON` };
    }
    if (parsed["prev_hash"] !== expected) {
      return {
        ok: false,
        error: `line ${i + 1}: expected prev_hash ${expected}, got ${String(parsed["prev_hash"])}`,
      };
    }
    expected = chainHmac(key, lines[i]);
    lastType = parsed["type"];
  }
  if (opts.requireTerminal && lastType !== TERMINAL_EVENT_TYPE) {
    return {
      ok: false,
      error:
        lines.length === 0
          ? `journal has no terminal ${TERMINAL_EVENT_TYPE} marker (empty or fully truncated)`
          : `journal not terminal: last event is ${String(lastType)}, expected ${TERMINAL_EVENT_TYPE} (truncated after run end?)`,
    };
  }
  return { ok: true };
}

/**
 * Read/export-boundary guard. Resolves the run's store entry and verifies its
 * journal:
 *  - `{ verified: false, ok: true }` when the run has no store entry — it was
 *    never keyed (predates keying, or was launched without a host that owns the
 *    key). Cannot verify, so callers must not block on it.
 *  - `{ verified: true, ok: false }` when the run WAS keyed but the key is gone
 *    at verification time. This is a fail-closed integrity failure (finding
 *    M-3): a keyed run whose key vanished must not silently downgrade to "not
 *    verified" and let a tampered journal through.
 *  - `{ verified: true, ok }` with the chain result otherwise.
 *
 * Every read/export boundary (run listing, `/v1/runs/{id}/events`, OTLP/Sentry
 * export) hard-fails when `verified === true && ok === false`.
 */
export function verifyRunJournal(runDir: string, env: NodeJS.ProcessEnv = process.env): { verified: boolean; ok: boolean; error?: string } {
  if (!isKeyedRun(runDir, env)) return { verified: false, ok: true };
  const key = readChainKey(runDir, env);
  if (key === null) {
    return { verified: true, ok: false, error: "audit chain key missing (fail closed)" };
  }
  // A keyed run is persisted only once terminal, so its journal must end with
  // the RUN_END marker: reject a completed journal whose tail was truncated
  // to a shorter-but-valid chain (finding L-3).
  const res = verifyRunSummaryChain(join(runDir, RUN_SUMMARY), key, { requireTerminal: true });
  return { verified: true, ok: res.ok, error: res.error };
}

/** UTC timestamp matching `date -u +"%Y-%m-%dT%H:%M:%SZ"` (no milliseconds). */
export function formatUtcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function appendRunSummaryLine(line: string): void {
  const file = process.env.JAIPH_RUN_SUMMARY_FILE;
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`, { flag: "a" });
}
