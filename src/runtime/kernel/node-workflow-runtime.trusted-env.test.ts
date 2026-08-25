// trusted_envs runtime contract (see trusted-env.ts):
//  - declared keys resolve from the pristine env snapshot and are injected
//    only into the declaring workflow's `run`-step script spawns;
//  - every graph-declared key is scrubbed from workflow scope envs, so
//    undeclared sub-workflows and imported modules never see it;
//  - prompt agent subprocesses never receive the values in any mode.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime, _scriptSpawn } from "./node-workflow-runtime";

/** Minimal fake ChildProcess that emits `close(0)` on the next tick. */
function fakeChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  const makeStream = (): EventEmitter & { setEncoding: () => void } => {
    const s = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    s.setEncoding = () => {};
    return s;
  };
  child.stdout = makeStream();
  child.stderr = makeStream();
  setImmediate(() => child.emit("close", 0));
  return child;
}

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };

/** Swap `_scriptSpawn.spawn` for a stub recording the spawn env while `fn` runs. */
async function withSpawnSpy(fn: (calls: SpawnCall[]) => Promise<void>): Promise<void> {
  const calls: SpawnCall[] = [];
  const orig = _scriptSpawn.spawn;
  _scriptSpawn.spawn = ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: opts.env });
    return fakeChild() as unknown as ReturnType<typeof _scriptSpawn.spawn>;
  }) as typeof _scriptSpawn.spawn;
  try {
    await fn(calls);
  } finally {
    _scriptSpawn.spawn = orig;
  }
}

function writeFlow(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** Emit a named script file the way buildScriptFiles would (bash shebang). */
function writeScriptFile(scriptsDir: string, name: string): void {
  writeFileSync(join(scriptsDir, name), "#!/usr/bin/env bash\necho x\n");
}

function makeEnv(root: string, scriptsDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    JAIPH_SCRIPTS: scriptsDir,
    JAIPH_WORKSPACE: root,
  };
}

function setup(root: string): { scriptsDir: string } {
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  return { scriptsDir };
}

test("trusted_envs: declaring workflow's run-step script receives the host value; other ambient keys still pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-env-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "show");
    const jh = writeFlow(root, "flow.jh", [
      "script show = `echo x`",
      "workflow default() {",
      "  config {",
      '    trusted_envs = "GH_TOKEN"',
      "  }",
      "  run show()",
      "}",
    ]);
    const env = { ...makeEnv(root, scriptsDir), GH_TOKEN: "host-secret", AMBIENT_OTHER: "visible" };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runDefault([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 1, "expected exactly one script spawn");
      assert.equal(calls[0]!.env.GH_TOKEN, "host-secret", "declared key is injected into the run-step env");
      assert.equal(calls[0]!.env.AMBIENT_OTHER, "visible", "undeclared ambient keys are untouched");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted_envs: top-level config is sugar for every workflow in the entry file", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-env-module-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "show");
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "GH_TOKEN"',
      "}",
      "script show = `echo x`",
      "workflow sub() {",
      "  run show()",
      "}",
      "workflow default() {",
      "  run show()",
      "  run sub()",
      "}",
    ]);
    const env = { ...makeEnv(root, scriptsDir), GH_TOKEN: "host-secret" };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runDefault([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 2, "expected a script spawn from default and from sub");
      for (const call of calls) {
        assert.equal(call.env.GH_TOKEN, "host-secret", "module-level declaration reaches every entry workflow");
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted_envs: a sub-workflow that does not declare the key does not receive it (no scope inheritance)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-env-sub-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "show");
    const jh = writeFlow(root, "flow.jh", [
      "script show = `echo x`",
      "workflow sub() {",
      "  run show()",
      "}",
      "workflow default() {",
      "  config {",
      '    trusted_envs = "GH_TOKEN"',
      "  }",
      "  run show()",
      "  run sub()",
      "}",
    ]);
    const env = { ...makeEnv(root, scriptsDir), GH_TOKEN: "host-secret" };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runDefault([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.env.GH_TOKEN, "host-secret", "declaring workflow's own run step gets the value");
      assert.equal(calls[1]!.env.GH_TOKEN, undefined, "undeclared sub-workflow must not inherit the caller's secret");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted_envs: declared in an imported module is ignored — no injection, and the key is scrubbed", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-env-import-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "steal");
    writeFlow(root, "lib.jh", [
      "config {",
      '  trusted_envs = "HOST_SECRET"',
      "}",
      "script steal = `echo x`",
      "workflow grab() {",
      "  run steal()",
      "}",
    ]);
    const jh = writeFlow(root, "entry.jh", [
      'import "lib.jh" as lib',
      "workflow default() {",
      "  run lib.grab()",
      "}",
    ]);
    const env = { ...makeEnv(root, scriptsDir), HOST_SECRET: "host-value" };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runDefault([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0]!.env.HOST_SECRET,
        undefined,
        "imported module's trusted_envs must not pull a host secret into its own steps",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fake agent CLI: dumps its env to a file and emits a valid result line. */
function writeEnvDumpAgent(agentPath: string, envDumpPath: string): void {
  writeFileSync(
    agentPath,
    [
      "#!/usr/bin/env bash",
      `printenv > "${envDumpPath}"`,
      'echo \'{"type":"result","result":"ok"}\'',
      "",
    ].join("\n"),
  );
  chmodSync(agentPath, 0o755);
}

test("trusted_envs: host mode — the value never reaches a prompt agent subprocess", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-env-prompt-"));
  try {
    const { scriptsDir } = setup(root);
    const envDump = join(root, "agent-env.txt");
    const fakeAgent = join(root, "fake-agent");
    writeEnvDumpAgent(fakeAgent, envDump);
    const jh = writeFlow(root, "flow.jh", [
      "workflow default() {",
      "  config {",
      '    trusted_envs = "GH_TOKEN"',
      "  }",
      '  prompt "say hi"',
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      JAIPH_AGENT_COMMAND: fakeAgent,
      GH_TOKEN: "host-secret",
    };
    // promptRetryDelays: [] — a broken fake agent should fail fast, not back off.
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true, promptRetryDelays: [] });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);
    const dump = readFileSync(envDump, "utf8");
    assert.ok(!dump.includes("GH_TOKEN"), `prompt agent env must not contain GH_TOKEN:\n${dump}`);
    assert.ok(!dump.includes("host-secret"), "prompt agent env must not contain the secret value");
    assert.match(dump, /^JAIPH_WORKSPACE=./m, "JAIPH_ control keys still pass to the agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
