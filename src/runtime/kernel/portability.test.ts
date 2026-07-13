import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { killProcessTree, _portability } from "./portability";

// Precedent for platform stubbing: src/runtime/docker.test.ts.
function withPlatform(platform: string, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    if (orig) Object.defineProperty(process, "platform", orig);
  }
}

/** Capture every `process.kill(pid, signal)` call while `fn` runs. */
function withKillSpy(
  fn: (calls: Array<{ pid: number; signal: NodeJS.Signals | undefined }>) => void,
  behavior?: (pid: number, signal: NodeJS.Signals | undefined) => void,
): void {
  const calls: Array<{ pid: number; signal: NodeJS.Signals | undefined }> = [];
  const orig = process.kill;
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: NodeJS.Signals) => {
    calls.push({ pid, signal });
    if (behavior) behavior(pid, signal);
    return true;
  }) as typeof process.kill;
  try {
    fn(calls);
  } finally {
    (process as { kill: typeof process.kill }).kill = orig;
  }
}

/** Capture the `_portability.spawn` invocation and return a fake child. */
function withSpawnSpy(
  fn: (calls: Array<{ command: string; args: string[] }>, fakeChild: EventEmitter) => void,
): void {
  const calls: Array<{ command: string; args: string[] }> = [];
  const fakeChild = new EventEmitter() as EventEmitter & { unref?: () => void };
  fakeChild.unref = () => {};
  const orig = _portability.spawn;
  _portability.spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return fakeChild as unknown as ReturnType<typeof _portability.spawn>;
  }) as typeof _portability.spawn;
  try {
    fn(calls, fakeChild);
  } finally {
    _portability.spawn = orig;
  }
}

// ---------------------------------------------------------------------------
// POSIX branch
// ---------------------------------------------------------------------------

test("POSIX: killProcessTree sends signal to the negative PID (process group)", () => {
  withPlatform("linux", () => {
    withKillSpy((calls) => {
      killProcessTree(1234, "SIGTERM");
      assert.equal(calls.length, 1, "exactly one process.kill call on the happy path");
      assert.deepEqual(calls[0], { pid: -1234, signal: "SIGTERM" });
    });
  });
});

test("POSIX: falls back to per-process kill when the group kill throws (ESRCH)", () => {
  withPlatform("linux", () => {
    withKillSpy(
      (calls) => {
        killProcessTree(1234, "SIGINT");
        assert.deepEqual(calls, [
          { pid: -1234, signal: "SIGINT" }, // group kill attempted first
          { pid: 1234, signal: "SIGINT" }, // then per-process fallback
        ]);
      },
      (pid) => {
        if (pid < 0) throw new Error("ESRCH");
      },
    );
  });
});

test("POSIX: SIGKILL escalation also uses the negative PID group kill", () => {
  withPlatform("linux", () => {
    withKillSpy((calls) => {
      killProcessTree(999, "SIGKILL");
      assert.deepEqual(calls[0], { pid: -999, signal: "SIGKILL" });
    });
  });
});

// ---------------------------------------------------------------------------
// win32 branch
// ---------------------------------------------------------------------------

test("win32: killProcessTree spawns `taskkill /pid <pid> /T /F`", () => {
  withPlatform("win32", () => {
    withSpawnSpy((spawnCalls) => {
      withKillSpy((killCalls) => {
        killProcessTree(4321, "SIGTERM");
        assert.equal(spawnCalls.length, 1, "taskkill spawned once");
        assert.equal(spawnCalls[0].command, "taskkill");
        assert.deepEqual(spawnCalls[0].args, ["/pid", "4321", "/T", "/F"]);
        assert.equal(killCalls.length, 0, "no process.kill on the happy win32 path");
      });
    });
  });
});

test("win32: SIGINT also spawns taskkill /T (Ctrl-C path)", () => {
  withPlatform("win32", () => {
    withSpawnSpy((spawnCalls) => {
      killProcessTree(7, "SIGINT");
      assert.deepEqual(spawnCalls[0].args, ["/pid", "7", "/T", "/F"]);
    });
  });
});

test("win32: SIGKILL escalation is a documented no-op (tree already force-killed)", () => {
  withPlatform("win32", () => {
    withSpawnSpy((spawnCalls) => {
      withKillSpy((killCalls) => {
        killProcessTree(4321, "SIGKILL");
        assert.equal(spawnCalls.length, 0, "no second taskkill on SIGKILL escalation");
        assert.equal(killCalls.length, 0, "no process.kill on SIGKILL escalation");
      });
    });
  });
});

test("win32: degrades to per-process kill when taskkill cannot be spawned", () => {
  withPlatform("win32", () => {
    withSpawnSpy((_spawnCalls, fakeChild) => {
      withKillSpy((killCalls) => {
        killProcessTree(555, "SIGTERM");
        // spawn returns a child that reports failure asynchronously via "error".
        fakeChild.emit("error", new Error("spawn taskkill ENOENT"));
        assert.deepEqual(killCalls, [{ pid: 555, signal: "SIGTERM" }]);
      });
    });
  });
});

test("win32: NEVER calls process.kill with a negative PID (SIGTERM, SIGINT, SIGKILL)", () => {
  withPlatform("win32", () => {
    withSpawnSpy((_spawnCalls, fakeChild) => {
      withKillSpy((killCalls) => {
        killProcessTree(1234, "SIGTERM");
        fakeChild.emit("error", new Error("no taskkill")); // force the fallback path too
        killProcessTree(1234, "SIGINT");
        fakeChild.emit("error", new Error("no taskkill"));
        killProcessTree(1234, "SIGKILL");
        for (const call of killCalls) {
          assert.ok(call.pid > 0, `win32 must never signal a negative PID (saw ${call.pid})`);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Lint contract: only the portability module may group-kill via negative PID.
// ---------------------------------------------------------------------------

// Tests run from dist/src/runtime/kernel/, so repo root is five levels up.
const REPO_ROOT = resolve(__dirname, "../../../..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Non-test production source files (excludes *.test.ts / *.acceptance.test.ts). */
function walkProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no production source file outside portability.ts invokes process.kill with a negative PID", () => {
  // Match `process.kill(-` allowing whitespace, e.g. `process.kill( -pid`.
  const negativeGroupKill = /process\.kill\(\s*-/;
  const offenders: string[] = [];
  for (const file of walkProductionTsFiles(SRC_ROOT)) {
    const rel = file.slice(REPO_ROOT.length + 1);
    // The helper is the one sanctioned home for the negative-PID group kill.
    if (rel === join("src", "runtime", "kernel", "portability.ts")) continue;
    const content = readFileSync(file, "utf8");
    if (negativeGroupKill.test(content)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `negative-PID group kill must be confined to portability.ts; offenders: ${offenders.join(", ")}`,
  );
});
