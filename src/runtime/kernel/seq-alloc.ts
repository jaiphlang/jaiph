/**
 * Atomic step-sequence allocator (JS kernel).
 * Single source of truth for seq allocation across all Bash async branches in a run.
 *
 * CLI:  node seq-alloc.js
 * Env:  JAIPH_RUN_DIR — run directory containing the .seq file.
 * Stdout: the allocated seq number (integer).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock, releaseLock } from "./fs-lock";

export function allocateNextSeq(runDir: string): number {
  const seqFile = join(runDir, ".seq");
  const lockPath = `${seqFile}.lock`;
  if (!acquireLock(lockPath)) {
    throw new Error(`seq-alloc: lock timeout on ${lockPath}`);
  }
  try {
    const raw = readFileSync(seqFile, "utf8").trim();
    const current = raw ? parseInt(raw, 10) : 0;
    const next = current + 1;
    writeFileSync(seqFile, String(next));
    return next;
  } finally {
    releaseLock(lockPath);
  }
}

function main(): void {
  const runDir = process.env.JAIPH_RUN_DIR;
  if (!runDir) {
    process.stderr.write("seq-alloc: JAIPH_RUN_DIR required\n");
    process.exit(1);
  }
  process.stdout.write(String(allocateNextSeq(runDir)));
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  main();
}
