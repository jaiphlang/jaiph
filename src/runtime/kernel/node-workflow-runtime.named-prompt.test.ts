// Named-prompt runtime behaviour:
//  - `${param}` interpolation in the named body (a mocked agent echoes the
//    expanded prompt text back; the capture must contain the argument value);
//  - `use KEY` + `--env KEY` injects the granted host secret into the agent
//    child env, while an anonymous prompt in the same def stays sterile.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { _backendSpawn, _codexBackend } from "./prompt-backends";

/** A fake agent child for the custom-command backend path: echoes a payload on stdout then closes. */
function fakeAgentChild(stdoutPayload: string): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { destroy: () => void };
    stderr: EventEmitter & { pipe: () => void; destroy: () => void };
    stdin: { write: () => void; end: () => void; destroy: () => void };
    pid: number;
    kill: () => void;
  };
  const stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
  stdout.destroy = () => {};
  const stderr = new EventEmitter() as EventEmitter & { pipe: () => void; destroy: () => void };
  stderr.pipe = () => {};
  stderr.destroy = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => {}, end: () => {}, destroy: () => {} };
  child.pid = 4242;
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(stdoutPayload));
    child.emit("close", 0);
  });
  return child;
}

type SpawnCall = { env: NodeJS.ProcessEnv };

async function withBackendSpy(
  payload: string,
  fn: (calls: SpawnCall[]) => Promise<void>,
): Promise<void> {
  const calls: SpawnCall[] = [];
  const orig = _backendSpawn.spawn;
  _backendSpawn.spawn = ((_command: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ env: opts.env });
    return fakeAgentChild(payload) as unknown as ReturnType<typeof _backendSpawn.spawn>;
  }) as typeof _backendSpawn.spawn;
  try {
    await fn(calls);
  } finally {
    _backendSpawn.spawn = orig;
  }
}

function writeEchoAgent(path: string): void {
  // Echo stdin (the prompt text piped for a custom command) back to stdout.
  writeFileSync(path, "#!/usr/bin/env bash\ncat\n", { mode: 0o755 });
}

test("named prompt interpolates ${param} in the body and invokes the agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-named-prompt-interp-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        'prompt analyze(log) = "Look at ${log}"',
        "export def main() {",
        '  const out = prompt analyze("hi")',
        "  return out",
        "}",
        "",
      ].join("\n"),
    );
    const agent = join(root, "echo-agent");
    writeEchoAgent(agent);
    const graph = buildRuntimeGraph(jh);
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
      },
      cwd: root,
      suppressLiveEvents: true,
    });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);
    const returnFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnFile), "return_value.txt should be written");
    const value = readFileSync(returnFile, "utf8");
    assert.match(value, /Look at hi/, "the named body ${log} must expand to the argument 'hi'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named prompt `use GITHUB_TOKEN` + --env grant reaches the agent child env; anonymous prompt does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-named-prompt-env-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        'prompt privileged(x) use GITHUB_TOKEN = "Privileged ${x}"',
        "export def main() {",
        '  const x = "y"',
        "  prompt privileged(x)",
        '  prompt "sterile anonymous"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    await withBackendSpy("done", async (calls) => {
      const runtime = new NodeWorkflowRuntime(graph, {
        env: {
          ...process.env,
          JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
          JAIPH_AGENT_BACKEND: "cursor",
          JAIPH_AGENT_COMMAND: join(root, "unused-agent"),
          JAIPH_WORKSPACE: root,
          JAIPH_ENV_GRANT: "GITHUB_TOKEN",
          GITHUB_TOKEN: "s3cr3t-token",
        },
        cwd: root,
        suppressLiveEvents: true,
      });
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 2, "both prompts spawn the agent");
      const [named, anon] = calls;
      assert.equal(named.env.GITHUB_TOKEN, "s3cr3t-token", "named prompt gets the granted use key");
      assert.equal(anon.env.GITHUB_TOKEN, undefined, "anonymous prompt stays sterile");
      assert.equal(named.env.JAIPH_ENV_GRANT, undefined, "the grant list itself never reaches the agent");
      assert.equal(anon.env.JAIPH_ENV_GRANT, undefined, "the grant list itself never reaches the agent");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex backend: named prompt `use` + --env grant reaches the request env; anonymous prompt does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-named-prompt-codex-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        'prompt privileged(x) use GITHUB_TOKEN = "Privileged ${x}"',
        "export def main() {",
        '  const x = "y"',
        "  prompt privileged(x)",
        '  prompt "sterile anonymous"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    const envs: NodeJS.ProcessEnv[] = [];
    const orig = _codexBackend.run;
    _codexBackend.run = ((_config, _promptText, _writer, _stderr, requestEnv) => {
      envs.push(requestEnv ?? {});
      return Promise.resolve({ final: "done", status: 0 });
    }) as typeof _codexBackend.run;
    try {
      const runtime = new NodeWorkflowRuntime(graph, {
        env: {
          ...process.env,
          JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
          JAIPH_AGENT_BACKEND: "codex",
          OPENAI_API_KEY: "sk-test",
          JAIPH_WORKSPACE: root,
          JAIPH_ENV_GRANT: "GITHUB_TOKEN",
          GITHUB_TOKEN: "s3cr3t-token",
        },
        cwd: root,
        suppressLiveEvents: true,
      });
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
      assert.equal(envs.length, 2, "both prompts reach the codex backend");
      const [named, anon] = envs;
      assert.equal(named.GITHUB_TOKEN, "s3cr3t-token", "named prompt puts the granted use key on the codex request env");
      assert.equal(anon.GITHUB_TOKEN, undefined, "anonymous prompt stays sterile");
      assert.equal(named.JAIPH_ENV_GRANT, undefined, "the grant list itself never reaches the agent");
    } finally {
      _codexBackend.run = orig;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
