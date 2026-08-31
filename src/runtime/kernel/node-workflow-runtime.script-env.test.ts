// Sterile script env contract (see buildScriptEnv in env-allowlist.ts):
//  - a script subprocess receives only the prompt base env (process
//    mechanics), the script runtime contract keys, and its `use` keys
//    intersected with the `--env` grant (`JAIPH_ENV_GRANT`);
//  - ambient host keys — including agent credentials — never cross without
//    a `use` request plus a grant;
//  - a def in the call tree neither grants nor denies keys: only the script
//    declaration's `use` clause does.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { inlineScriptName } from "../../inline-script-name";
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

test("sterile: a script with no `use` never sees ambient host keys (incl. agent credentials)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "show");
    const jh = writeFlow(root, "flow.jh", [
      "script show = `echo x`",
      "export def main() {",
      "  run show()",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      GITHUB_TOKEN: "host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      AMBIENT_OTHER: "visible-to-runner-only",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
      assert.equal(calls.length, 1, "expected exactly one script spawn");
      const child = calls[0]!.env;
      assert.equal(child.GITHUB_TOKEN, undefined, "host secret must not cross without use + grant");
      assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined, "agent credential must not cross");
      assert.equal(child.AMBIENT_OTHER, undefined, "arbitrary ambient keys must not cross");
      // Base + contract surface still present.
      assert.equal(child.PATH, process.env.PATH, "base env (PATH) is forwarded");
      assert.equal(child.JAIPH_WORKSPACE, root, "contract key JAIPH_WORKSPACE is forwarded");
      assert.equal(child.JAIPH_SCRIPTS, scriptsDir, "contract key JAIPH_SCRIPTS is forwarded");
      assert.ok(child.JAIPH_RUN_DIR, "contract key JAIPH_RUN_DIR is forwarded");
      assert.ok(child.JAIPH_ARTIFACTS_DIR, "contract key JAIPH_ARTIFACTS_DIR is forwarded");
      assert.equal(child.JAIPH_AGENT_MODEL, "", "JAIPH_AGENT_MODEL stays defined (set -u scripts)");
      assert.equal(child.JAIPH_RUN_SUMMARY_FILE, undefined, "journal path never crosses");
      assert.equal(child.JAIPH_CHAIN_KEY, undefined, "audit-chain key never crosses");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("use + grant: the key crosses only when named in JAIPH_ENV_GRANT", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-grant-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "show");
    const jh = writeFlow(root, "flow.jh", [
      "script show use GITHUB_TOKEN = `echo x`",
      "export def main() {",
      "  run show()",
      "}",
    ]);
    const base = { ...makeEnv(root, scriptsDir), GITHUB_TOKEN: "host-secret" };

    // Granted: --env GITHUB_TOKEN was passed (CLI hand-off via JAIPH_ENV_GRANT).
    const granted = new NodeWorkflowRuntime(buildRuntimeGraph(jh), {
      env: { ...base, JAIPH_ENV_GRANT: "GITHUB_TOKEN" },
      cwd: root,
      suppressLiveEvents: true,
    });
    await withSpawnSpy(async (calls) => {
      assert.equal(await granted.runMain([]), 0);
      assert.equal(calls[0]!.env.GITHUB_TOKEN, "host-secret", "use + grant forwards the value");
    });

    // Not granted: host env has the key, but --env did not name it.
    const ungranted = new NodeWorkflowRuntime(buildRuntimeGraph(jh), {
      env: { ...base },
      cwd: root,
      suppressLiveEvents: true,
    });
    await withSpawnSpy(async (calls) => {
      assert.equal(await ungranted.runMain([]), 0);
      assert.equal(calls[0]!.env.GITHUB_TOKEN, undefined, "host presence alone is not a grant");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import script: `use` on the import line has the same spawn contract as a named script", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-import-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "gh");
    writeFileSync(join(root, "gh.sh"), "#!/usr/bin/env bash\necho x\n");
    const jh = writeFlow(root, "flow.jh", [
      'import script "./gh.sh" as gh use GITHUB_TOKEN',
      "export def main() {",
      "  run gh()",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      GITHUB_TOKEN: "host-secret",
      JAIPH_ENV_GRANT: "GITHUB_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.env.GITHUB_TOKEN, "host-secret", "imported script's use clause forwards the granted key");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no def-level leak: a callee def's script without `use` stays sterile even when the key is granted", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-def-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "with_use");
    writeScriptFile(scriptsDir, "without_use");
    const jh = writeFlow(root, "flow.jh", [
      "script with_use use GITHUB_TOKEN = `echo x`",
      "script without_use = `echo x`",
      "def callee() {",
      "  run without_use()",
      "}",
      "export def main() {",
      "  run with_use()",
      "  run callee()",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      GITHUB_TOKEN: "host-secret",
      JAIPH_ENV_GRANT: "GITHUB_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.env.GITHUB_TOKEN, "host-secret", "the declaring script gets the granted key");
      assert.equal(
        calls[1]!.env.GITHUB_TOKEN,
        undefined,
        "a def grants nothing: the callee's script did not use the key, so it stays sterile",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell-fallthrough def lines spawn `sh -c` with the sterile script env", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-shline-"));
  try {
    const { scriptsDir } = setup(root);
    const jh = writeFlow(root, "flow.jh", [
      "export def main() {",
      "  echo hello",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      UE_TOKEN: "host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      JAIPH_SERVE_TOKEN: "serve-secret",
      JAIPH_CHAIN_KEY: "chain-secret",
      JAIPH_RUN_SUMMARY_FILE: join(root, "run_summary.jsonl"),
      JAIPH_ENV_GRANT: "UE_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 1, "expected exactly one sh -c spawn");
      assert.deepEqual(calls[0]!.args, ["-c", "echo hello"], "the interpolated line runs via sh -c");
      const child = calls[0]!.env;
      assert.equal(child.UE_TOKEN, undefined, "shell lines have no use clause: a grant forwards nothing");
      assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined, "agent credential must not cross");
      assert.equal(child.JAIPH_SERVE_TOKEN, undefined, "host-only serve token must not cross");
      assert.equal(child.JAIPH_CHAIN_KEY, undefined, "audit-chain key never crosses");
      assert.equal(child.JAIPH_RUN_SUMMARY_FILE, undefined, "journal path never crosses");
      assert.equal(child.JAIPH_ENV_GRANT, undefined, "the grant list itself never crosses");
      // Base + contract surface still present, same as an inline script.
      assert.equal(child.PATH, process.env.PATH, "base env (PATH) is forwarded");
      assert.equal(child.JAIPH_WORKSPACE, root, "contract key JAIPH_WORKSPACE is forwarded");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-module use: `run lib.publish()` forwards the imported module's use key", async () => {
  // `use` lives on the definition: the entry file imports lib.jh with no `use`
  // of its own, and the granted key still reaches lib's script subprocess.
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-cross-"));
  try {
    const { scriptsDir } = setup(root);
    writeScriptFile(scriptsDir, "publish");
    writeFlow(root, "lib.jh", [
      "export script publish use UE_TOKEN = `echo x`",
    ]);
    const jh = writeFlow(root, "flow.jh", [
      'import "./lib.jh" as lib',
      "export def main() {",
      "  run lib.publish()",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      UE_TOKEN: "cross-secret",
      JAIPH_ENV_GRANT: "UE_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 1, "expected exactly one script spawn");
      assert.equal(
        calls[0]!.env.UE_TOKEN,
        "cross-secret",
        "the imported script's own use clause forwards the granted key across modules",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inline scripts have no use clause and get the sterile base only", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-script-env-inline-"));
  try {
    const { scriptsDir } = setup(root);
    // The emitted inline script file must exist for interpreter resolution.
    writeScriptFile(scriptsDir, inlineScriptName("echo hi", undefined));
    const jh = writeFlow(root, "flow.jh", [
      "export def main() {",
      "  run `echo hi`()",
      "}",
    ]);
    const env = {
      ...makeEnv(root, scriptsDir),
      GITHUB_TOKEN: "host-secret",
      JAIPH_ENV_GRANT: "GITHUB_TOKEN",
    };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(jh), { env, cwd: root, suppressLiveEvents: true });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.env.GITHUB_TOKEN, undefined, "a grant without a use clause forwards nothing");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
