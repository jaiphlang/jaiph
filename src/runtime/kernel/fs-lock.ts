/**
 * Portable mkdir-based locks.
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy wait — matches bash lock polling without shelling out */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM") return true;
    return false;
  }
}

export function acquireLock(lockdir: string): boolean {
  const timeoutRaw = process.env.JAIPH_LOCK_TIMEOUT_SECONDS ?? "30";
  const timeoutS = /^\d+$/.test(timeoutRaw) ? parseInt(timeoutRaw, 10) : 30;
  let sleepMsVal = 50;
  const sleepRaw = process.env.JAIPH_LOCK_SLEEP_SECONDS;
  if (sleepRaw !== undefined && sleepRaw !== "") {
    const parsed = parseFloat(sleepRaw);
    if (!Number.isNaN(parsed) && parsed >= 0) sleepMsVal = Math.round(parsed * 1000);
  }
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockdir);
      writeFileSync(join(lockdir, "pid"), `${process.pid}\n`);
      return true;
    } catch {
      const pidPath = join(lockdir, "pid");
      if (existsSync(pidPath)) {
        const ownerRaw = readFileSync(pidPath, "utf8").trim();
        const owner = parseInt(ownerRaw, 10);
        if (owner > 0 && !isProcessAlive(owner)) {
          try {
            unlinkSync(pidPath);
          } catch {
            /* ignore */
          }
          try {
            rmdirSync(lockdir);
          } catch {
            /* ignore */
          }
          continue;
        }
      }
      if (Date.now() - started >= timeoutS * 1000) {
        process.stderr.write(`jaiph: lock timeout while waiting for ${lockdir}\n`);
        return false;
      }
      sleepMs(sleepMsVal);
    }
  }
}

export function releaseLock(lockdir: string): void {
  try {
    unlinkSync(join(lockdir, "pid"));
  } catch {
    /* ignore */
  }
  try {
    rmdirSync(lockdir);
  } catch {
    /* ignore */
  }
}
