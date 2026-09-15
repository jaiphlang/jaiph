import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime, _scriptSpawn } from "./node-workflow-runtime";

/** An ErrnoException carrying the given syscall `code` (e.g. "E2BIG"). */
function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Minimal fake ChildProcess that emits `error(err)` on the next tick — the
 * async spawn-failure path (e.g. the OS rejecting an oversized argv after the
 * spawn call returns a handle).
 */
function fakeChildEmittingError(err: NodeJS.ErrnoException): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  const makeStream = (): EventEmitter & { setEncoding: () => void } => {
    const s = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    s.setEncoding = () => {};
    return s;
  };
  child.stdout = makeStream();
  child.stderr = makeStream();
  setImmediate(() => child.emit("error", err));
  return child;
}

/** Swap `_scriptSpawn.spawn` for `impl` while `fn` runs, then restore it. */
async function withSpawn(
  impl: typeof _scriptSpawn.spawn,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = _scriptSpawn.spawn;
  _scriptSpawn.spawn = impl;
  try {
    await fn();
  } finally {
    _scriptSpawn.spawn = orig;
  }
}

function makeRuntime(root: string, jhBody: string): {
  runtime: NodeWorkflowRuntime;
  env: NodeJS.ProcessEnv;
  scriptsDir: string;
} {
  const jh = join(root, "flow.jh");
  writeFileSync(jh, jhBody);
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const graph = buildRuntimeGraph(jh);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_TEST_MODE: "1",
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    JAIPH_SCRIPTS: scriptsDir,
    JAIPH_WORKSPACE: root,
  };
  const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
  return { runtime, env, scriptsDir };
}

/** Read the durable journal as parsed events. */
function readSummaryEvents(runtime: NodeWorkflowRuntime): Array<Record<string, unknown>> {
  return readFileSync(runtime.getSummaryFile(), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Run `fn` with `process.env.JAIPH_RUN_SUMMARY_FILE` bridged to the runtime's
 * summary file so `appendRunSummaryLine` (which reads process.env) writes the
 * durable journal, then restore it.
 */
async function withSummaryBridge(runtime: NodeWorkflowRuntime, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.JAIPH_RUN_SUMMARY_FILE;
  process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
    else process.env.JAIPH_RUN_SUMMARY_FILE = prev;
  }
}

type ExecuteScript = (
  filePath: string,
  scriptName: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ status: number; output: string; error: string }>;

// AC: a synchronous `E2BIG` throw from the spawn seam is a failed step, not a
// rejected Promise: status 1, stderr carries E_ARGV_TOO_LARGE with a byte count.
test("spawnAndCapture: a synchronous E2BIG throw resolves the script step as status 1 (E_ARGV_TOO_LARGE), never rejects", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-spawn-e2big-throw-"));
  try {
    const { runtime, env, scriptsDir } = makeRuntime(root, 'export def main() {\n  log "noop"\n}\n');
    writeFileSync(join(scriptsDir, "big"), "#!/usr/bin/env bash\necho hi\n");
    const throwSpawn = (() => {
      throw errnoError("spawn E2BIG", "E2BIG");
    }) as unknown as typeof _scriptSpawn.spawn;

    await withSpawn(throwSpawn, async () => {
      let result: { status: number; output: string; error: string } | undefined;
      let rejected = false;
      try {
        result = await (runtime as unknown as { executeScript: ExecuteScript }).executeScript(
          join(root, "flow.jh"),
          "big",
          ["a1"],
          env,
        );
      } catch {
        rejected = true;
      }
      assert.equal(rejected, false, "spawnAndCapture must not reject on a synchronous spawn throw");
      assert.ok(result, "expected a resolved StepResult");
      assert.equal(result!.status, 1, "oversized-argv spawn is a failed step");
      assert.match(result!.error, /E_ARGV_TOO_LARGE/, "stderr carries the stable oversized-argv marker");
      assert.match(result!.error, /E_ARGV_TOO_LARGE: \d+ bytes/, "marker includes the attempted byte count");
    });
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: `E2BIG` delivered via the async 'error' event is the SAME failed-step
// contract as the synchronous throw (not a thrown run).
test("spawnAndCapture: an 'error' event with code E2BIG is the same failed-step contract (E_ARGV_TOO_LARGE)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-spawn-e2big-event-"));
  try {
    const { runtime, env, scriptsDir } = makeRuntime(root, 'export def main() {\n  log "noop"\n}\n');
    writeFileSync(join(scriptsDir, "big"), "#!/usr/bin/env bash\necho hi\n");
    const errorSpawn = (() =>
      fakeChildEmittingError(errnoError("spawn E2BIG", "E2BIG"))) as unknown as typeof _scriptSpawn.spawn;

    await withSpawn(errorSpawn, async () => {
      const result = await (runtime as unknown as { executeScript: ExecuteScript }).executeScript(
        join(root, "flow.jh"),
        "big",
        ["a1"],
        env,
      );
      assert.equal(result.status, 1, "E2BIG via 'error' event is a failed step");
      assert.match(result.error, /E_ARGV_TOO_LARGE: \d+ bytes/, "same marker + byte count as the throw path");
    });
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: a non-E2BIG spawn failure keeps the existing status-1 + diagnosable
// ENOENT-interpreter message (E2BIG mapping must not swallow other failures).
test("spawnAndCapture: a synchronous ENOENT throw keeps the diagnosable interpreter message (not E_ARGV_TOO_LARGE)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-spawn-enoent-throw-"));
  try {
    const { runtime, env, scriptsDir } = makeRuntime(root, 'export def main() {\n  log "noop"\n}\n');
    writeFileSync(join(scriptsDir, "run_bad"), "#!/usr/bin/env my-missing-interp\necho hi\n");
    const throwSpawn = (() => {
      throw errnoError("spawn my-missing-interp ENOENT", "ENOENT");
    }) as unknown as typeof _scriptSpawn.spawn;

    await withSpawn(throwSpawn, async () => {
      const result = await (runtime as unknown as { executeScript: ExecuteScript }).executeScript(
        join(root, "flow.jh"),
        "run_bad",
        [],
        env,
      );
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.error, /E_ARGV_TOO_LARGE/, "ENOENT is not an oversized-argv failure");
      assert.match(result.error, /my-missing-interp/, "keeps the diagnosable interpreter name");
      assert.doesNotMatch(result.error, /ENOENT/, "not a raw ENOENT");
    });
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: executeManagedStep converts a thrown Error from `fn` into a status-1 step
// and still writes STEP_END. Today's control flow (no STEP_END on throw) fails this.
test("executeManagedStep: a thrown Error becomes a status-1 step with a STEP_END in the journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-managed-throw-"));
  try {
    const { runtime } = makeRuntime(root, 'export def main() {\n  log "noop"\n}\n');
    await withSummaryBridge(runtime, async () => {
      const result = await (runtime as unknown as {
        executeManagedStep: (
          kind: "def" | "script",
          name: string,
          args: string[],
          fn: () => Promise<unknown>,
        ) => Promise<{ status: number; error: string }>;
      }).executeManagedStep("script", "boom", [], async () => {
        throw new Error("kaboom-generic");
      });
      assert.equal(result.status, 1, "a thrown fn is a failed step, not a thrown run");
      assert.match(result.error, /kaboom-generic/, "the thrown message is preserved on stderr");
    });
    const events = readSummaryEvents(runtime);
    const stepEnd = events.find((e) => e.type === "STEP_END" && e.name === "boom");
    assert.ok(stepEnd, "expected a STEP_END for the throwing step");
    assert.equal(stepEnd!.status, 1, "STEP_END carries the failed status");
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: runRoot emits a terminal RUN_END even when the def body throws (a vanished
// process is not a handleable error). Today's control flow (no RUN_END on throw)
// fails this.
test("runRoot: emits a terminal RUN_END even when executeDef throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runroot-throw-"));
  try {
    const { runtime } = makeRuntime(root, 'export def main() {\n  log "noop"\n}\n');
    // Force the run body to throw with an error the runtime cannot handle,
    // simulating a vanished process mid-run.
    (runtime as unknown as { executeDef: () => Promise<never> }).executeDef = async () => {
      throw new Error("vanished-mid-run");
    };
    await withSummaryBridge(runtime, async () => {
      await assert.rejects(runtime.runRoot("main", []), /vanished-mid-run/);
    });
    const events = readSummaryEvents(runtime);
    assert.ok(events.some((e) => e.type === "RUN_START"), "RUN_START was emitted");
    const last = events[events.length - 1];
    assert.equal(last!.type, "RUN_END", "RUN_END is the terminal journal line even on a throw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: a `run script(huge)` whose argv would exceed ARG_MAX does not reject
// runRoot. After the step, the journal has STEP_END for that script and a
// terminal RUN_END (spawn mock; no live 1MB argv needed).
test("runRoot: an oversized-argv script spawn does not reject; journal has STEP_END + terminal RUN_END", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runroot-e2big-"));
  try {
    const { runtime, scriptsDir } = makeRuntime(
      root,
      ["script big = ```", 'echo "unreachable"', "```", "", "export def main() {", "  run big()", "}", ""].join("\n"),
    );
    writeFileSync(join(scriptsDir, "big"), '#!/usr/bin/env bash\necho "unreachable"\n');
    const throwSpawn = (() => {
      throw errnoError("spawn E2BIG", "E2BIG");
    }) as unknown as typeof _scriptSpawn.spawn;

    await withSpawn(throwSpawn, async () => {
      await withSummaryBridge(runtime, async () => {
        let status: number | undefined;
        let rejected = false;
        try {
          status = await runtime.runRoot("main", []);
        } catch {
          rejected = true;
        }
        assert.equal(rejected, false, "an oversized-argv spawn must not reject runRoot");
        assert.equal(status, 1, "the run fails through the failed step");
      });
    });

    const events = readSummaryEvents(runtime);
    const scriptEnd = events.find((e) => e.type === "STEP_END" && e.kind === "script" && e.name === "big");
    assert.ok(scriptEnd, "expected a STEP_END for the oversized script");
    assert.equal(scriptEnd!.status, 1, "the oversized script step ended status 1");
    const last = events[events.length - 1];
    assert.equal(last!.type, "RUN_END", "RUN_END is the terminal journal line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: when the oversized spawn is itself the failed `run`, the step ends status
// 1, so `recover` engages and its body runs (proving recover_limit applies).
test("runRoot: recover body runs after a mocked E2BIG on the recovered run step", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runroot-e2big-recover-"));
  try {
    const { runtime, scriptsDir } = makeRuntime(
      root,
      [
        "script big = ```",
        'echo "unreachable"',
        "```",
        "",
        "export def main() {",
        "  run big() recover (failure) {",
        '    logerr "RECOVER_RAN ${failure}"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(scriptsDir, "big"), '#!/usr/bin/env bash\necho "unreachable"\n');
    const throwSpawn = (() => {
      throw errnoError("spawn E2BIG", "E2BIG");
    }) as unknown as typeof _scriptSpawn.spawn;

    let status: number | undefined;
    await withSpawn(throwSpawn, async () => {
      await withSummaryBridge(runtime, async () => {
        status = await runtime.runRoot("main", []);
      });
    });
    assert.equal(status, 1, "big never succeeds, so the run ends status 1 after recover exhausts");

    const events = readSummaryEvents(runtime);
    const recoverLogs = events.filter(
      (e) => e.type === "LOGERR" && typeof e.message === "string" && (e.message as string).includes("RECOVER_RAN"),
    );
    assert.ok(recoverLogs.length >= 1, "the recover body ran at least once after the E2BIG failure");
    // The binding is the failed step's stdout CAPTURE PATH (empty here — the
    // spawn threw before any stdout), NOT the failure text. The E2BIG
    // diagnostic is a spawn diagnostic and lives in the sibling `.err`.
    const boundPath = (recoverLogs[0]!.message as string).replace("RECOVER_RAN ", "");
    assert.ok(isAbsolute(boundPath) && boundPath.endsWith(".out"), `binding must be a .out path, got: ${boundPath}`);
    assert.ok(!boundPath.includes("E_ARGV_TOO_LARGE"), "binding must be a path, not the oversized-argv text");
    assert.equal(readFileSync(boundPath, "utf8"), "", "a spawn that produced no stdout binds an empty .out");
    const errPath = `${boundPath.slice(0, -".out".length)}.err`;
    assert.match(
      readFileSync(errPath, "utf8"),
      /E_ARGV_TOO_LARGE/,
      "the oversized-argv spawn diagnostic lands in the sibling .err",
    );
    const last = events[events.length - 1];
    assert.equal(last!.type, "RUN_END", "the run still terminates with RUN_END");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
