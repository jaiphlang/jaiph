import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

function makeRuntime(root: string, jh: string): NodeWorkflowRuntime {
  const graph = buildRuntimeGraph(jh);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_TEST_MODE: "1",
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
  };
  return new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
}

test("runRoot: a non-default workflow runs as root, binds params positionally, writes return_value.txt", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-root-named-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(
      jh,
      [
        "workflow greet(name, punctuation) {",
        '  return "hello ${name}${punctuation}"',
        "}",
        "",
        "workflow default() {",
        '  log "unused"',
        "}",
        "",
      ].join("\n"),
    );
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("greet", ["world", "!"]);
    assert.equal(status, 0);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnValueFile), `expected return_value.txt in ${runtime.getRunDir()}`);
    assert.equal(readFileSync(returnValueFile, "utf8"), "hello world!");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRoot: an unknown workflow returns 1 and writes no return_value.txt", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-root-missing-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, ["workflow greet(name) {", '  return "hi ${name}"', "}", ""].join("\n"));
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("missing", []);
    assert.equal(status, 1);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(!existsSync(returnValueFile), "expected no return_value.txt for an unknown workflow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRoot: runDefault delegates to runRoot('default') with unchanged behaviour", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-root-default-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(
      jh,
      ["workflow default(name) {", '  return "hello ${name}"', "}", ""].join("\n"),
    );
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runDefault(["world"]);
    assert.equal(status, 0);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnValueFile), "runDefault should still write return_value.txt");
    assert.equal(readFileSync(returnValueFile, "utf8"), "hello world");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
