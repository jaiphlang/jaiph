/**
 * Runtime event emission helpers used by the Node workflow runtime.
 *
 * The durable `run_summary.jsonl` journal is written by the trusted kernel
 * process, but its integrity is protected by a *keyed* HMAC chain: each line's
 * `prev_hash` is `chainHmac(key, previousRawLine)`. The per-run key is held by
 * the host and the kernel process only — it is scrubbed from every script /
 * agent subprocess env (see `scrubTrustedKeys` in node-workflow-runtime.ts and
 * `scrubPromptEnv` in env-allowlist.ts). An audited workflow can therefore
 * delete or rewrite the journal on disk, but it cannot forge a chain that
 * verifies, so every read/export boundary can detect the tamper and hard-fail.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

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
 * Basename of the per-run key file the host writes beside the journal once the
 * run is terminal, so later read/export boundaries can verify the chain. The
 * dot prefix keeps it out of the serve run-dir scan (`scanRunDirs`).
 */
export const CHAIN_KEY_FILE = ".chain-key";

/** Journal basename inside a run directory. */
const RUN_SUMMARY = "run_summary.jsonl";

/** A fresh 256-bit per-run key as lowercase hex. */
export function generateChainKey(): string {
  return randomBytes(32).toString("hex");
}

/** Keyed chain digest: HMAC-SHA256(key, data) as lowercase hex. */
export function chainHmac(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * Persist the per-run key beside the journal (host-side, after the run is
 * terminal). Best-effort: a read-only / vanished run dir must never fail a run.
 */
export function writeChainKey(runDir: string, key: string): void {
  try {
    writeFileSync(join(runDir, CHAIN_KEY_FILE), key, { mode: 0o600 });
  } catch {
    // Best-effort persistence; absence just means "cannot verify" downstream.
  }
}

/** Read the per-run key beside the journal, or null when none was written. */
export function readChainKey(runDir: string): string | null {
  try {
    const k = readFileSync(join(runDir, CHAIN_KEY_FILE), "utf8").trim();
    return k.length > 0 ? k : null;
  } catch {
    return null;
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
 */
export function verifyRunSummaryChain(filePath: string, key: string): { ok: boolean; error?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, error: "journal unreadable (missing or truncated)" };
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let expected = chainHmac(key, CHAIN_GENESIS);
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
  }
  return { ok: true };
}

/**
 * Read/export-boundary guard. Loads the run's persisted key and verifies its
 * journal:
 *  - `{ verified: false, ok: true }` when no key was persisted (the run predates
 *    keying, or was launched without a host that owns the key) — cannot verify,
 *    so callers must not block on it.
 *  - `{ verified: true, ok }` with the chain result otherwise.
 *
 * Every read/export boundary (run listing, `/v1/runs/{id}/events`, OTLP/Sentry
 * export) hard-fails when `verified === true && ok === false`.
 */
export function verifyRunJournal(runDir: string): { verified: boolean; ok: boolean; error?: string } {
  const key = readChainKey(runDir);
  if (key === null) return { verified: false, ok: true };
  const res = verifyRunSummaryChain(join(runDir, RUN_SUMMARY), key);
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
