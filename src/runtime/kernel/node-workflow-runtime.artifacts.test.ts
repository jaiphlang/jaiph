import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

test("NodeWorkflowRuntime: workflow step .out accumulates Command:/Prompt: and log (mocked prompt)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-artifacts-"));
  try {
    const jh = join(root, "prompt_log.jh");
    writeFileSync(
      jh,
      [
        "workflow default {",
        '  response = prompt "hello-mock"',
        '  log "$response"',
        "}",
        "",
      ].join("\n"),
    );
    const mockFile = join(root, "mocks.txt");
    writeFileSync(mockFile, "mocked-agent-reply\n");

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_FILE: mockFile,
      JAIPH_NODE_ORCHESTRATOR: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const runDir = runtime.getRunDir();
    const outs = readdirSync(runDir).filter((f) => f.endsWith(".out"));
    assert.ok(outs.length >= 1, `expected .out artifacts in ${runDir}`);
    const defaultOut = outs.find((f) => f.includes("workflow__default"));
    assert.ok(defaultOut, `expected workflow__default.out, got ${outs.join(", ")}`);
    const content = readFileSync(join(runDir, defaultOut), "utf8");
    assert.match(content, /^Command:\n/);
    assert.match(content, /Prompt:\n"hello-mock"/);
    assert.match(content, /mocked-agent-reply/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
