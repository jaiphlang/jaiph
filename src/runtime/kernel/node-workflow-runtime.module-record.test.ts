// Runtime resolution of the builtin `module` record. The value follows the
// file, not the process: a def sees the `.jh` file it was written in, even when
// a def in another file called it. `file` / `dir` come from the absolute path
// on the module graph (no realpath, no cwd, no entry-file path); `name` /
// `version` / `description` come from that file's module-level config.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makeEnv(root: string, scriptsDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    JAIPH_SCRIPTS: scriptsDir,
    JAIPH_WORKSPACE: root,
  };
}

function returnValue(runtime: NodeWorkflowRuntime): string {
  return readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8");
}

test("module.file/dir follow the file across modules (subdirectories, not the workspace root)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-module-record-"));
  try {
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });

    const flowPath = join(dirA, "flow.jh");
    writeFileSync(join(dirB, "lib.jh"), [
      "export def dir_of() {",
      '  return "${module.dir}"',
      "}",
      "",
    ].join("\n"));
    writeFileSync(flowPath, [
      'import "../b/lib.jh" as lib',
      "export def main() {",
      '  return "${module.file}|${module.dir}|${lib.dir_of()}"',
      "}",
      "",
    ].join("\n"));

    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(flowPath), {
      env: makeEnv(root, join(root, "scripts")),
      cwd: root,
      suppressLiveEvents: true,
    });
    assert.equal(await runtime.runMain([]), 0);
    const [file, dir, libDir] = returnValue(runtime).split("|");
    assert.equal(file, flowPath, "module.file is the entry file's absolute path");
    assert.equal(dir, dirA, "module.dir is the entry file's directory");
    assert.equal(libDir, dirB, "the imported def sees its own file's directory");
    assert.notEqual(dir, root, "not the workspace root");
    assert.notEqual(libDir, root, "not the workspace root");
    assert.notEqual(dir, libDir, "the two files' directories differ");
    // module.dir has no trailing slash — joins cleanly.
    assert.equal(`${dir}/sources.json`, join(dirA, "sources.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module.name/version/description read the file's config; unset fields are empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-module-record-meta-"));
  try {
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });

    writeFileSync(join(dirB, "lib.jh"), [
      "config {",
      '  module.name = "lib"',
      '  module.version = "1"',
      '  module.description = "d"',
      "}",
      "export def meta_of() {",
      '  return "${module.name}|${module.version}|${module.description}"',
      "}",
      "",
    ].join("\n"));
    const flowPath = join(dirA, "flow.jh");
    // flow.jh has no module.* config — every field is "".
    writeFileSync(flowPath, [
      'import "../b/lib.jh" as lib',
      "export def main() {",
      '  return "${module.name}|${module.version}|${module.description}::${lib.meta_of()}"',
      "}",
      "",
    ].join("\n"));

    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(flowPath), {
      env: makeEnv(root, join(root, "scripts")),
      cwd: root,
      suppressLiveEvents: true,
    });
    assert.equal(await runtime.runMain([]), 0);
    assert.equal(returnValue(runtime), "||::lib|1|d");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("if on module.dir sees the file's directory, not empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-module-record-if-"));
  try {
    const dirA = join(root, "a");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    const flowPath = join(dirA, "flow.jh");
    writeFileSync(flowPath, [
      "export def main() {",
      `  if module.dir == "${dirA}" {`,
      '    return "matched"',
      "  }",
      '  return "no"',
      "}",
      "",
    ].join("\n"));

    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(flowPath), {
      env: makeEnv(root, join(root, "scripts")),
      cwd: root,
      suppressLiveEvents: true,
    });
    assert.equal(await runtime.runMain([]), 0);
    assert.equal(returnValue(runtime), "matched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a def passes module.dir to a script as an argument; the script env grows no `module` var", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-module-record-script-"));
  try {
    const dirA = join(root, "a");
    const scriptsDir = join(root, "scripts");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    // The emitted inline script file must exist for interpreter resolution.
    writeFileSync(join(scriptsDir, inlineScriptName("echo hi", undefined)), "#!/usr/bin/env bash\necho hi\n");
    const flowPath = join(dirA, "flow.jh");
    writeFileSync(flowPath, [
      "export def main() {",
      "  'echo hi'(module.dir)",
      "}",
      "",
    ].join("\n"));

    const env = { ...makeEnv(root, scriptsDir), module: "should-not-cross" };
    const runtime = new NodeWorkflowRuntime(buildRuntimeGraph(flowPath), {
      env,
      cwd: root,
      suppressLiveEvents: true,
    });
    await withSpawnSpy(async (calls) => {
      assert.equal(await runtime.runMain([]), 0);
      assert.equal(calls.length, 1, "expected exactly one script spawn");
      assert.equal(calls[0]!.args[calls[0]!.args.length - 1], dirA, "the def passed module.dir as the script argument");
      assert.equal(calls[0]!.env.module, undefined, "a script step's env does not grow a `module` variable");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
