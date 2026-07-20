/**
 * Runtime event emission helpers used by the Node workflow runtime.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/** Sentinel prev_hash for the first line in a run_summary.jsonl chain. */
export const CHAIN_GENESIS = "0".repeat(64);

/** SHA-256 of `data` as a lowercase hex string. */
export function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Verify the hash chain of a run_summary.jsonl file.
 *
 * Each line must carry `prev_hash` equal to the SHA-256 of the previous raw
 * JSON line (or CHAIN_GENESIS for the first line). Returns `{ ok: true }` when
 * the chain is intact, or `{ ok: false, error }` describing the first broken
 * link so a caller can detect truncation or rewrite.
 */
export function verifyRunSummaryChain(filePath: string): { ok: boolean; error?: string } {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let expected = CHAIN_GENESIS;
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
    expected = sha256hex(lines[i]);
  }
  return { ok: true };
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
