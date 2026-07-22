import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime, _scriptSpawn } from "./node-workflow-runtime";

/** Minimal fake ChildProcess that emits `close(exitCode)` on the next tick. */
function fakeChild(exitCode: number): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  const makeStream = (): EventEmitter & { setEncoding: () => void } => {
    const s = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    s.setEncoding = () => {};
    return s;
  };
  child.stdout = makeStream();
  child.stderr = makeStream();
  setImmediate(() => child.emit("close", exitCode));
  return child;
}

/** Swap `_scriptSpawn.spawn` for a recording stub while `fn` runs. */
async function withSpawnSpy(
  fn: (calls: Array<{ command: string; args: string[] }>) => Promise<void>,
): Promise<void> {
  const calls: Array<{ command: string; args: string[] }> = [];
  const orig = _scriptSpawn.spawn;
  _scriptSpawn.spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return fakeChild(0) as unknown as ReturnType<typeof _scriptSpawn.spawn>;
  }) as typeof _scriptSpawn.spawn;
  try {
    await fn(calls);
  } finally {
    _scriptSpawn.spawn = orig;
  }
}

function makeRuntime(root: string): { runtime: NodeWorkflowRuntime; env: NodeJS.ProcessEnv; scriptsDir: string } {
  const jh = join(root, "flow.jh");
  writeFileSync(jh, ["workflow default() {", '  log "noop"', "}", ""].join("\n"));
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

// AC1: executeScript spawns the resolved interpreter with the script path as
// argv[1] (spawn args[0]) — asserted on the spawn call, not on side effects.
const SHEBANG_CASES: Array<{ label: string; shebang: string; expected: string }> = [
  { label: "bash", shebang: "#!/usr/bin/env bash", expected: "bash" },
  { label: "node", shebang: "#!/usr/bin/env node", expected: "node" },
  { label: "python3", shebang: "#!/usr/bin/env python3", expected: "python3" },
  { label: "custom", shebang: "#!/usr/bin/env my-custom-lang", expected: "my-custom-lang" },
];

for (const c of SHEBANG_CASES) {
  test(`executeScript: spawns resolved interpreter "${c.expected}" with the script path as argv[1] (${c.label} shebang)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-script-exec-"));
    try {
      const { runtime, env, scriptsDir } = makeRuntime(root);
      const scriptName = `run_${c.label}`;
      const scriptPath = join(scriptsDir, scriptName);
      writeFileSync(scriptPath, `${c.shebang}\necho hi\n`);
      await withSpawnSpy(async (calls) => {
        const result = await (runtime as unknown as {
          executeScript: (
            filePath: string,
            scriptName: string,
            args: string[],
            env: NodeJS.ProcessEnv,
          ) => Promise<{ status: number }>;
        }).executeScript(join(root, "flow.jh"), scriptName, ["a1", "a2"], env);
        assert.equal(result.status, 0);
        assert.equal(calls.length, 1, "expected exactly one spawn call");
        assert.equal(calls[0]!.command, c.expected, "spawned command is the resolved interpreter");
        assert.equal(calls[0]!.args[0], scriptPath, "script path is argv[1] (spawn args[0])");
        assert.deepEqual(calls[0]!.args, [scriptPath, "a1", "a2"], "script args follow the script path");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// AC2: a script with the exec bit stripped (0o644) still executes on POSIX,
// because the runtime spawns the interpreter explicitly rather than the file.
test("executeScript: script with exec bit stripped (0o644) still executes through the runtime", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-noexec-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        "script write_marker = ```",
        'printf "ran-ok" > marker.txt',
        "```",
        "",
        "workflow default() {",
        "  run write_marker()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = join(scriptsDir, "write_marker");
    writeFileSync(
      scriptPath,
      ["#!/usr/bin/env bash", "set -euo pipefail", 'printf "ran-ok" > marker.txt', ""].join("\n"),
    );
    // Strip the exec bit: with shebang+exec-bit execution this would fail EACCES.
    chmodSync(scriptPath, 0o644);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0, "workflow succeeded despite stripped exec bit");
    assert.equal(readFileSync(join(root, "marker.txt"), "utf8"), "ran-ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC3: a shebang naming a missing interpreter fails with a diagnosable Jaiph
// error naming the interpreter, not a raw ENOENT.
test("executeScript: missing interpreter fails with a diagnosable error naming the interpreter (not raw ENOENT)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-badinterp-"));
  try {
    const missing = "jaiph-nonexistent-interp-xyz";
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        "script run_bad = ```",
        'echo "unreachable"',
        "```",
        "",
        "workflow default() {",
        "  run run_bad()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "run_bad"), `#!/usr/bin/env ${missing}\necho unreachable\n`);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const result = await runtime.runNamedWorkflow("default", []);
    assert.equal(result.status, 1, "workflow failed on missing interpreter");
    const message = `${result.output ?? ""}${result.error ?? ""}`;
    assert.match(message, new RegExp(missing), "error names the missing interpreter");
    assert.doesNotMatch(message, /ENOENT/, "error is not a raw ENOENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression for the prompt env scrub (kernel/env-allowlist.ts): scrubbing is
// scoped to prompt backend subprocesses only. A trusted `run` script step must
// still receive the full workflow env — including a `--env`-injected secret
// (host mode merges the pairs into the runner env; Docker forwards them as
// explicit `-e` args). If the scrub ever extended to script spawns, the token
// below would be empty and this test would fail.
test("executeScript: a run script step still receives a --env-injected non-allowlisted secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-secret-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        'script show_token = `echo "token=$GITHUB_TOKEN"`',
        "",
        "workflow default() {",
        "  const t = run show_token()",
        '  return "${t}"',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "show_token"), '#!/usr/bin/env bash\necho "token=$GITHUB_TOKEN"\n');

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
      GITHUB_TOKEN: "fake-gh-secret",
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);
    const returnValue = readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8");
    assert.equal(returnValue, "token=fake-gh-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
