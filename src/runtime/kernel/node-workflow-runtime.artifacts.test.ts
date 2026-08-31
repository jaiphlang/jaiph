import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

test("NodeWorkflowRuntime: runMain writes return_value.txt with the workflow's return value", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-return-"));
  try {
    const jh = join(root, "returns.jh");
    writeFileSync(
      jh,
      [
        "export def main(name) {",
        '  return "hello ${name}"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain(["world"]);
    assert.equal(status, 0);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnValueFile), `expected return_value.txt in ${runtime.getRunDir()}`);
    assert.equal(readFileSync(returnValueFile, "utf8"), "hello world");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: runMain does not write return_value.txt when workflow has no return", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-noreturn-"));
  try {
    const jh = join(root, "noreturn.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        '  log "side effect only"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(!existsSync(returnValueFile), "expected no return_value.txt for workflow without return");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: prompt step preview preserves authored ${var} placeholders (not interpolated)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-preview-"));
  try {
    const jh = join(root, "prompt_preview.jh");
    writeFileSync(
      jh,
      [
        "export def main(name) {",
        '  prompt "Say hello to ${name} and stop."',
        "}",
        "",
      ].join("\n"),
    );
    const mockJson = JSON.stringify(["ok"]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    let status: number;
    try {
      status = await runtime.runMain(["Adam"]);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    assert.equal(status, 0);

    const summary = readFileSync(runtime.getSummaryFile(), "utf8");
    const promptStart = summary
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.type === "STEP_START" && e.kind === "prompt");
    assert.ok(promptStart, "expected a prompt STEP_START in run summary");
    const params = (promptStart as { params: Array<[string, string]> }).params;
    const previewEntry = params.find(([k]) => k === "prompt_text");
    assert.ok(previewEntry, "prompt STEP_START should include a prompt_text param");
    assert.equal(previewEntry![1], "Say hello to ${name} and stop.");
    const nameEntry = params.find(([k]) => k === "name");
    assert.ok(nameEntry, "prompt STEP_START should include the resolved `name` param");
    assert.equal(nameEntry![1], "Adam");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: prompt STEP_START/STEP_END carry the effective model for the display layer", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-step-model-"));
  try {
    const jh = join(root, "prompt_model_step.jh");
    writeFileSync(
      jh,
      [
        "config {",
        '  agent.model = "sonnet"',
        "}",
        "export def main() {",
        '  prompt "Classify this task"',
        "}",
        "",
      ].join("\n"),
    );
    const mockJson = JSON.stringify(["ok"]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }

    const events = readFileSync(runtime.getSummaryFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // STEP_START/STEP_END must carry model directly so the CLI renders
    // `prompt <backend> <model>` without reading PROMPT_START.
    const promptStart = events.find((e) => e.type === "STEP_START" && e.kind === "prompt");
    assert.ok(promptStart, "expected a prompt STEP_START in run summary");
    assert.equal(typeof promptStart!.name, "string");
    assert.ok((promptStart!.name as string).length > 0, "STEP_START should carry the backend name");
    assert.equal(promptStart!.model, "sonnet");
    const promptEnd = events.find((e) => e.type === "STEP_END" && e.kind === "prompt");
    assert.ok(promptEnd, "expected a prompt STEP_END in run summary");
    assert.equal(promptEnd!.model, "sonnet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: prompt STEP_START uses default label when backend auto-selects", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-step-model-default-"));
  try {
    const jh = join(root, "prompt_default_step.jh");
    writeFileSync(
      jh,
      ['export def main() {', '  prompt "hello"', "}", ""].join("\n"),
    );
    const mockJson = JSON.stringify(["ok"]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    delete env.JAIPH_AGENT_MODEL;
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }

    const events = readFileSync(runtime.getSummaryFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const promptStart = events.find((e) => e.type === "STEP_START" && e.kind === "prompt");
    assert.ok(promptStart, "expected a prompt STEP_START in run summary");
    assert.equal(promptStart!.model, "default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: workflow step .out accumulates Command:/Prompt: and log (mocked prompt)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-artifacts-"));
  try {
    const jh = join(root, "prompt_log.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        '  const response = prompt "hello-mock"',
        '  log response',
        "}",
        "",
      ].join("\n"),
    );
    const mockJson = JSON.stringify(["mocked-agent-reply"]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const runDir = runtime.getRunDir();
    const outs = readdirSync(runDir).filter((f) => f.endsWith(".out"));
    assert.ok(outs.length >= 1, `expected .out artifacts in ${runDir}`);
    const defaultOut = outs.find((f) => f.includes("def__main"));
    assert.ok(defaultOut, `expected def__main.out, got ${outs.join(", ")}`);
    const content = readFileSync(join(runDir, defaultOut), "utf8");
    assert.match(content, /^Command:\n/);
    assert.match(content, /Prompt:\n"hello-mock"/);
    assert.match(content, /mocked-agent-reply/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: failed prompt preserves backend stderr in artifacts and summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-prompt-stderr-"));
  try {
    const jh = join(root, "prompt_failure.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        '  prompt "hello-fail"',
        "}",
        "",
      ].join("\n"),
    );
    const fakeAgent = join(root, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        'echo "Cannot use this model: gpt-5.4" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_AGENT_BACKEND: "cursor",
      JAIPH_AGENT_COMMAND: fakeAgent,
      JAIPH_AGENT_MODEL: "gpt-5.4",
      JAIPH_WORKSPACE: root,
      // This test exercises single-attempt stderr capture; the prompt-retry
      // backoff schedule (default 15s → 1m → 10m → 30m → 2h) is orthogonal
      // and is covered by node-workflow-runtime.prompt-retry.test.ts.
      JAIPH_PROMPT_RETRY: "0",
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    let status: number;
    try {
      status = await runtime.runMain([]);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    assert.equal(status, 1);

    const runDir = runtime.getRunDir();
    const promptErr = readdirSync(runDir).find((f) => f.includes("prompt__prompt.err"));
    assert.ok(promptErr, `expected prompt__prompt.err in ${runDir}`);
    const promptErrContent = readFileSync(join(runDir, promptErr!), "utf8");
    assert.match(promptErrContent, /Cannot use this model: gpt-5\.4/);

    const summaryContent = readFileSync(runtime.getSummaryFile(), "utf8");
    assert.match(summaryContent, /Cannot use this model: gpt-5\.4/);
    assert.ok(!summaryContent.includes('"err_content":"prompt failed"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: run catch receives failure payload in catch scope (explicit binding)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-ensure-catch-"));
  try {
    const jh = join(root, "ensure_catch_payload.jh");
    writeFileSync(
      jh,
      [
        "script check_ready_impl = ```",
        'echo "analysis-stdout-log"',
        'echo "analysis-stderr-log" >&2',
        "test -f ready.txt",
        "```",
        "",
        "def check_ready() {",
        "  run check_ready_impl()",
        "}",
        "",
        'script write_catch_received = `echo "$1" > catch_received.txt`',
        "",
        'script write_catch_arg2 = `echo "$1" > catch_arg2.txt`',
        "",
        'script mark_ready = `touch ready.txt`',
        "",
        "export def main(name, extra) {",
        "  run check_ready() catch (failure) {",
        '    run write_catch_received(failure)',
        '    run write_catch_arg2(extra)',
        "    run mark_ready()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "check_ready_impl"),
      ['#!/usr/bin/env bash', 'echo "analysis-stdout-log"', 'echo "analysis-stderr-log" >&2', 'test -f ready.txt', ""].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    writeFileSync(join(scriptsDir, "write_catch_received"), '#!/usr/bin/env bash\nprintf "%s" "$1" > catch_received.txt\n', {
      mode: 0o755,
    });
    writeFileSync(join(scriptsDir, "write_catch_arg2"), '#!/usr/bin/env bash\nprintf "%s" "$1" > catch_arg2.txt\n', {
      mode: 0o755,
    });
    writeFileSync(join(scriptsDir, "mark_ready"), "#!/usr/bin/env bash\ntouch ready.txt\n", { mode: 0o755 });

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain(["original-arg1", "preserved-arg2"]);
    assert.equal(status, 0);

    const catchPayload = readFileSync(join(root, "catch_received.txt"), "utf8");
    assert.match(catchPayload, /analysis-stdout-log/);
    assert.match(catchPayload, /analysis-stderr-log/);

    const catchArg2 = readFileSync(join(root, "catch_arg2.txt"), "utf8").trim();
    assert.equal(catchArg2, "preserved-arg2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: nested cross-module run applies callee module config and restores caller scope after", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    // Scope env is observed through inline shell lines: script env is sterile
    // (env-allowlist.ts), so a script spawn no longer sees JAIPH_AGENT_MODEL.
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.model = "model-b"',
        "}",
        "def show() {",
        '  echo "child:$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentJh,
      [
        'import "child.jh" as child',
        "",
        'config {',
        '  agent.model = "model-a"',
        "}",
        "export def main() {",
        '  echo "parent_before:$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
        "  run child.show()",
        '  echo "parent_after:$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(parentJh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: metaFile,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "parent_before:\nchild:\nparent_after:\n";
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: config agent.model applies to prompt only via PROMPT_START, not JAIPH_AGENT_MODEL env", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-prompt-model-"));
  try {
    const jh = join(root, "prompt_model.jh");
    const metaFile = join(root, "scope.log");
    // Shell-line observation: scope env is what an inline shell step sees.
    writeFileSync(
      jh,
      [
        'config {',
        '  agent.model = "module-model"',
        "}",
        "def with_prompt(model) {",
        "  config {",
        "    agent.model = model",
        "  }",
        '  echo "shell:$JAIPH_AGENT_MODEL" >> "$JAIPH_SCOPE_LOG"',
        '  const answer = prompt "hello"',
        "}",
        "",
        "export def main() {",
        '  run with_prompt("workflow-model")',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const runsDir = join(root, ".jaiph", "runs");
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: JSON.stringify(["ok"]),
      JAIPH_RUNS_DIR: runsDir,
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_SCOPE_LOG: metaFile,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }

    assert.equal(readFileSync(metaFile, "utf8"), "shell:\n");

    const summaryLines = readFileSync(join(runtime.getRunDir(), "run_summary.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    const events = summaryLines.map((l) => JSON.parse(l));
    const promptStart = events.find((e: Record<string, unknown>) => e.type === "PROMPT_START");
    assert.ok(promptStart);
    assert.equal(promptStart.model, "workflow-model");
    assert.equal(promptStart.model_reason, "explicit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: nested cross-module run applies callee def-level config over callee module-level config", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-wf-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.model = "child-module-model"',
        "}",
        "def show() {",
        '  config {',
        '    agent.model = "child-workflow-model"',
        "  }",
        '  echo "child:$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentJh,
      [
        'import "child.jh" as child',
        "",
        'config {',
        '  agent.model = "model-a"',
        "}",
        "export def main() {",
        "  run child.show()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(parentJh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: metaFile,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    assert.equal(actual, "child:\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: nested cross-module run honors locked JAIPH_AGENT_MODEL over callee config", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-locked-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.model = "model-b"',
        "}",
        "def show() {",
        '  config {',
        '    agent.model = "child-workflow-model"',
        "  }",
        '  echo "child:$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentJh,
      [
        'import "child.jh" as child',
        "",
        'config {',
        '  agent.model = "model-a"',
        "}",
        "export def main() {",
        "  run child.show()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(parentJh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: metaFile,
      JAIPH_AGENT_MODEL: "env-model",
      JAIPH_AGENT_MODEL_LOCKED: "1",
    };

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    assert.equal(actual, "child:env-model\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: nested cross-module preserves locked JAIPH_AGENT_BACKEND (callee config ignored)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-lock-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.backend = "claude"',
        "}",
        "export def main() {",
        '  echo "child:$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentJh,
      [
        'import "child.jh" as child',
        "",
        'config {',
        '  agent.backend = "cursor"',
        "}",
        "export def main() {",
        '  echo "parent_before:$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "  run child.main()",
        '  echo "parent_after:$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(parentJh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: metaFile,
      JAIPH_AGENT_BACKEND: "claude",
      JAIPH_AGENT_BACKEND_LOCKED: "1",
    };

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "parent_before:claude\nchild:claude\nparent_after:claude\n";
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: sibling workflows do not inherit each other's metadata-derived agent settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-sibling-"));
  try {
    const jh = join(root, "sibling_isolation.jh");
    const metaFile = join(root, "sibling_scope.log");
    writeFileSync(
      jh,
      [
        "config {",
        '  agent.model = "module-model"',
        '  agent.backend = "cursor"',
        "}",
        "",
        "def alpha() {",
        "  config {",
        '    agent.model = "alpha-model"',
        '    agent.backend = "claude"',
        "  }",
        '  echo "alpha:model=$JAIPH_AGENT_MODEL,backend=$JAIPH_AGENT_BACKEND" >> "$JAIPH_SIBLING_LOG"',
        "}",
        "",
        "def beta() {",
        "  config {",
        '    agent.model = "beta-model"',
        "  }",
        '  echo "beta:model=$JAIPH_AGENT_MODEL,backend=$JAIPH_AGENT_BACKEND" >> "$JAIPH_SIBLING_LOG"',
        "}",
        "",
        "export def main() {",
        "  run alpha()",
        "  run beta()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_SIBLING_LOG: metaFile,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;
    delete env.JAIPH_AGENT_BACKEND;
    delete env.JAIPH_AGENT_BACKEND_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "alpha:model=,backend=claude\nbeta:model=,backend=cursor\n";
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: workflow config interpolates workflow parameters into prompt model", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-param-"));
  try {
    const jh = join(root, "param_config.jh");
    writeFileSync(
      jh,
      [
        "def implement(model) {",
        "  config {",
        "    agent.model = model",
        "  }",
        '  const answer = prompt "hello"',
        "}",
        "",
        "export def main() {",
        '  run implement("workflow-model")',
        "}",
        "",
      ].join("\n"),
    );

    const runsDir = join(root, ".jaiph", "runs");
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: JSON.stringify(["ok"]),
      JAIPH_RUNS_DIR: runsDir,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }

    const summaryLines = readFileSync(join(runtime.getRunDir(), "run_summary.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    const events = summaryLines.map((l) => JSON.parse(l));
    const promptStart = events.find((e: Record<string, unknown>) => e.type === "PROMPT_START");
    assert.ok(promptStart);
    assert.equal(promptStart.model, "workflow-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: prompt STEP_START params include named vars referenced in prompt text", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-prompt-params-"));
  try {
    const jh = join(root, "prompt_named.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        '  const dataset = "users"',
        '  const response = prompt "Analyze the ${dataset} table"',
        '  log response',
        "}",
        "",
      ].join("\n"),
    );
    const mockJson = JSON.stringify(["analysis-done"]);

    const runsDir = join(root, ".jaiph", "runs");
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: runsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    // Bridge env so appendRunSummaryLine (reads process.env) writes the summary.
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }

    const runDir = runtime.getRunDir();
    const summaryPath = join(runDir, "run_summary.jsonl");
    const summaryLines = readFileSync(summaryPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
    const events = summaryLines.map((l) => JSON.parse(l));
    const promptStart = events.find(
      (e: Record<string, unknown>) => e.type === "STEP_START" && e.kind === "prompt",
    );
    assert.ok(promptStart, "expected a STEP_START event for prompt");
    const params = promptStart.params as Array<[string, string]>;
    const paramMap = new Map(params);
    assert.ok(paramMap.has("dataset"), `expected 'dataset' in params, got keys: ${[...paramMap.keys()].join(", ")}`);
    assert.equal(paramMap.get("dataset"), "users");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: JAIPH_ARTIFACTS_DIR is set and points at writable artifacts/ subdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-artifacts-dir-"));
  try {
    const jh = join(root, "artifacts_env.jh");
    writeFileSync(jh, 'export def main() {\n  log "ok"\n}\n');

    const graph = buildRuntimeGraph(jh);
    const runsDir = join(root, ".jaiph", "runs");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: runsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const runDir = runtime.getRunDir();
    const artifactsDir = env.JAIPH_ARTIFACTS_DIR;

    // JAIPH_ARTIFACTS_DIR is set and points at <runDir>/artifacts
    assert.ok(artifactsDir, "JAIPH_ARTIFACTS_DIR should be set");
    assert.equal(artifactsDir, join(runDir, "artifacts"));

    // The directory exists before any workflow step runs
    assert.ok(existsSync(artifactsDir!), "artifacts dir should exist on disk");

    // It is writable
    const probe = join(artifactsDir!, "probe.txt");
    writeFileSync(probe, "test");
    assert.equal(readFileSync(probe, "utf8"), "test");

    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: JAIPH_ARTIFACTS_DIR resolves under .jaiph/runs when JAIPH_RUNS_DIR is unset", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-artifacts-default-"));
  try {
    const jh = join(root, "artifacts_default.jh");
    writeFileSync(jh, 'export def main() {\n  log "ok"\n}\n');

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = { ...process.env, JAIPH_TEST_MODE: "1" };
    delete env.JAIPH_RUNS_DIR;
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const artifactsDir = env.JAIPH_ARTIFACTS_DIR;

    assert.ok(artifactsDir, "JAIPH_ARTIFACTS_DIR should be set");
    assert.ok(artifactsDir!.includes(join(".jaiph", "runs")), "should be under .jaiph/runs");
    assert.ok(artifactsDir!.endsWith("/artifacts"), "should end with /artifacts");
    assert.ok(existsSync(artifactsDir!), "artifacts dir should exist");

    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: heartbeat file created at construction, removed on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-heartbeat-"));
  try {
    const jh = join(root, "heartbeat.jh");
    writeFileSync(jh, 'export def main() {\n  log "ok"\n}\n');
    const mockJson = JSON.stringify([""]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const runDir = runtime.getRunDir();

    const heartbeatPath = join(runDir, "heartbeat");
    assert.ok(existsSync(heartbeatPath), "heartbeat file should exist after construction");
    const ts = parseInt(readFileSync(heartbeatPath, "utf8"), 10);
    assert.ok(ts > 0 && ts <= Date.now(), "heartbeat should contain a valid epoch ms timestamp");

    await runtime.runMain([]);
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function inboxDispatchStartTargets(summaryPath: string): string[] {
  const text = readFileSync(summaryPath, "utf8");
  const order: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { type?: string; target?: string };
    if (e.type === "INBOX_DISPATCH_START" && typeof e.target === "string") {
      order.push(e.target);
    }
  }
  return order;
}

test("NodeWorkflowRuntime: JAIPH_INBOX_PARALLEL has no effect on inbox dispatch sequencing", async () => {
  const src = [
    "channel results -> consumer_a, consumer_b",
    "",
    "def producer() {",
    '  send "dispatch-order-payload" -> results',
    "}",
    "",
    "def consumer_a(msg) {",
    '  log "consumer_a"',
    "}",
    "",
    "def consumer_b(msg) {",
    '  log "consumer_b"',
    "}",
    "",
    "export def main() {",
    "  run producer()",
    "}",
    "",
  ].join("\n");

  const runOnce = async (inboxParallelEnv: string | undefined): Promise<string[]> => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-inbox-par-env-"));
    try {
      const jh = join(root, "inbox_par.jh");
      writeFileSync(jh, src);
      const graph = buildRuntimeGraph(jh);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        JAIPH_TEST_MODE: "1",
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      };
      delete env.JAIPH_INBOX_PARALLEL;
      if (inboxParallelEnv !== undefined) {
        env.JAIPH_INBOX_PARALLEL = inboxParallelEnv;
      }
      const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
      const prevSummary = process.env.JAIPH_RUN_SUMMARY_FILE;
      process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
      let status: number;
      try {
        status = await runtime.runMain([]);
      } finally {
        if (prevSummary === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
        else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummary;
      }
      assert.equal(status, 0);
      runtime.stopHeartbeat();
      return inboxDispatchStartTargets(runtime.getSummaryFile());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const without = await runOnce(undefined);
  const withTrue = await runOnce("true");
  assert.deepEqual(without, withTrue);
  assert.deepEqual(without, ["consumer_a", "consumer_b"]);
});

async function runInboxCapScenario(opts: {
  rootPrefix: string;
  fileName: string;
  source: string;
  inboxMaxDispatch?: string;
}): Promise<{ status: number; summary: string }> {
  const root = mkdtempSync(join(tmpdir(), opts.rootPrefix));
  try {
    const jh = join(root, opts.fileName);
    writeFileSync(jh, opts.source);
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    delete env.JAIPH_INBOX_MAX_DISPATCH;
    if (opts.inboxMaxDispatch !== undefined) {
      env.JAIPH_INBOX_MAX_DISPATCH = opts.inboxMaxDispatch;
    }
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummary = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    let status: number;
    try {
      status = await runtime.runMain([]);
    } finally {
      if (prevSummary === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummary;
    }
    runtime.stopHeartbeat();
    const summary = readFileSync(runtime.getSummaryFile(), "utf8");
    return { status, summary };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("NodeWorkflowRuntime: circular inbox sends fail with E_INBOX_DISPATCH_LIMIT instead of hanging", async () => {
  const { status, summary } = await runInboxCapScenario({
    rootPrefix: "jaiph-inbox-cap-circular-",
    fileName: "circular.jh",
    inboxMaxDispatch: "10",
    source: [
      "channel ping -> on_ping",
      "channel pong -> on_pong",
      "",
      "def on_ping(message, chan, sender) {",
      '  send "p" -> pong',
      "}",
      "",
      "def on_pong(message, chan, sender) {",
      '  send "p" -> ping',
      "}",
      "",
      "export def main() {",
      '  send "start" -> ping',
      "}",
      "",
    ].join("\n"),
  });
  assert.notEqual(status, 0, "circular sends must fail the workflow");
  const failLine = summary.split("\n").find((line) => line.includes("E_INBOX_DISPATCH_LIMIT"));
  assert.ok(failLine, `expected an E_INBOX_DISPATCH_LIMIT entry in run_summary.jsonl; got:\n${summary}`);
  assert.match(failLine!, /drained 10 messages without quiescing/);
  assert.match(failLine!, /channel \\"(ping|pong)\\"/);
  assert.match(failLine!, /raise JAIPH_INBOX_MAX_DISPATCH if intentional/);
});

test("NodeWorkflowRuntime: JAIPH_INBOX_MAX_DISPATCH=5 triggers the cap after 5 messages", async () => {
  const { status, summary } = await runInboxCapScenario({
    rootPrefix: "jaiph-inbox-cap-five-",
    fileName: "self_loop.jh",
    inboxMaxDispatch: "5",
    source: [
      "channel loop -> on_loop",
      "",
      "def on_loop(message, chan, sender) {",
      '  send "again" -> loop',
      "}",
      "",
      "export def main() {",
      '  send "start" -> loop',
      "}",
      "",
    ].join("\n"),
  });
  assert.notEqual(status, 0, "self-loop must fail the workflow");
  const lines = summary.split("\n").filter((line) => line.trim().length > 0);
  const dispatchStarts = lines.filter((line) => {
    const evt = JSON.parse(line) as { type?: string };
    return evt.type === "INBOX_DISPATCH_START";
  });
  assert.equal(dispatchStarts.length, 5, "exactly 5 dispatches should occur before the cap");
  const failLine = lines.find((line) => line.includes("E_INBOX_DISPATCH_LIMIT"));
  assert.ok(failLine, `expected E_INBOX_DISPATCH_LIMIT in summary; got:\n${summary}`);
  assert.match(failLine!, /drained 5 messages without quiescing/);
  assert.match(failLine!, /channel \\"loop\\"/);
});

test("NodeWorkflowRuntime: multi-message fan-out below the cap is unaffected", async () => {
  const { status, summary } = await runInboxCapScenario({
    rootPrefix: "jaiph-inbox-cap-fanout-",
    fileName: "fanout.jh",
    inboxMaxDispatch: "5",
    source: [
      "channel ch -> sink_a, sink_b, sink_c",
      "",
      "def producer() {",
      '  send "m1" -> ch',
      '  send "m2" -> ch',
      '  send "m3" -> ch',
      "}",
      "",
      "def sink_a(message, chan, sender) {",
      '  log "a"',
      "}",
      "",
      "def sink_b(message, chan, sender) {",
      '  log "b"',
      "}",
      "",
      "def sink_c(message, chan, sender) {",
      '  log "c"',
      "}",
      "",
      "export def main() {",
      "  run producer()",
      "}",
      "",
    ].join("\n"),
  });
  assert.equal(status, 0, "fan-out below the cap must succeed");
  assert.ok(!summary.includes("E_INBOX_DISPATCH_LIMIT"), "must not flag the cap below the limit");
});

test("NodeWorkflowRuntime: ANTHROPIC_API_KEY value in prompt text is redacted in run summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-redact-"));
  // Use a long, distinctive secret value that cannot appear by accident.
  const secret = "sk-ant-redacttest-1234567890abcdef";
  try {
    const jh = join(root, "prompt_redact.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        // Embed the literal secret in the prompt source so the write path must redact it.
        `  prompt "Call endpoint with token ${secret} and return result"`,
        "}",
        "",
      ].join("\n"),
    );
    const mockJson = JSON.stringify(["ok"]);
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      ANTHROPIC_API_KEY: secret,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      await runtime.runMain([]);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    const summaryText = readFileSync(runtime.getSummaryFile(), "utf8");
    assert.ok(!summaryText.includes(secret), "credential value must not appear in run summary");
    assert.ok(summaryText.includes("[REDACTED]"), "run summary must contain [REDACTED] in place of credential");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: credential value passed as a generic step param is redacted in run summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-param-redact-"));
  // Long, distinctive secret so it cannot collide with ordinary output tokens.
  const secret = "sk-ant-paramredact-1234567890abcdef";
  try {
    const jh = join(root, "param_redact.jh");
    writeFileSync(
      jh,
      [
        "def producer(token) {",
        '  log "producing"',
        "}",
        "",
        "export def main() {",
        // Pass the literal secret as a positional argument to a `run` step. The
        // arg lands in the step `params` pairs and must be scrubbed before the
        // durable journal write.
        `  run producer("${secret}")`,
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      // Credential-named key so redactCredentials targets this value.
      SOME_API_TOKEN: secret,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runMain([]);
      assert.equal(status, 0);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    const summaryText = readFileSync(runtime.getSummaryFile(), "utf8");
    assert.ok(!summaryText.includes(secret), "credential value must not appear in run summary params");
    // The producer step params carry the redaction placeholder in place of the secret.
    const lines = summaryText.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const producerStart = lines.find(
      (e) => e.type === "STEP_START" && e.kind === "def" && e.name === "producer",
    );
    assert.ok(producerStart, "expected a STEP_START event for the producer run step");
    const params = producerStart!.params as Array<[string, string]>;
    const tokenEntry = params.find(([k]) => k === "token");
    assert.ok(tokenEntry, `expected 'token' param, got keys: ${params.map(([k]) => k).join(", ")}`);
    assert.equal(tokenEntry![1], "[REDACTED]", "generic step param must be redacted in the durable journal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: credential values in log/logwarn/logerr are redacted in run summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-log-redact-"));
  // Distinct, distinctive secrets per level so each durable path is checked independently.
  const logSecret = "sk-ant-logredact-1234567890abcdef";
  const warnSecret = "sk-ant-warnredact-1234567890abcdef";
  const errSecret = "sk-ant-errredact-1234567890abcdef";
  try {
    const jh = join(root, "log_redact.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        // Embed the literal secret in each message so the durable write path must redact it.
        `  log "log token ${logSecret}"`,
        `  logwarn "warn token ${warnSecret}"`,
        `  logerr "err token ${errSecret}"`,
        "}",
        "",
      ].join("\n"),
    );
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      // Credential-named keys so redactCredentials targets these values.
      ANTHROPIC_API_KEY: logSecret,
      SOME_WARN_TOKEN: warnSecret,
      SOME_ERR_SECRET: errSecret,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      await runtime.runMain([]);
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    const summaryText = readFileSync(runtime.getSummaryFile(), "utf8");
    // No raw secret survives on any level's durable payload.
    assert.ok(!summaryText.includes(logSecret), "log credential value must not appear in run summary");
    assert.ok(!summaryText.includes(warnSecret), "logwarn credential value must not appear in run summary");
    assert.ok(!summaryText.includes(errSecret), "logerr credential value must not appear in run summary");
    // Each durable log line carries the redaction placeholder in place of the secret.
    const lines = summaryText.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const byType = (t: string) => lines.find((l) => l.type === t);
    assert.equal(byType("LOG")?.message, "log token [REDACTED]");
    assert.equal(byType("LOGWARN")?.message, "warn token [REDACTED]");
    assert.equal(byType("LOGERR")?.message, "err token [REDACTED]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: imported module cannot override agent.command by default (IMPORT_UNLOCK opts in)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-import-cmd-lock-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const cmdFile = join(root, "cmd.log");
    writeFileSync(
      childJh,
      [
        "config {",
        '  agent.command = "injected-agent"',
        "}",
        "export def main() {",
        '  echo "child:$JAIPH_AGENT_COMMAND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentJh,
      [
        'import "child.jh" as child',
        "",
        "export def main() {",
        '  echo "parent:$JAIPH_AGENT_COMMAND" >> "$JAIPH_META_SCOPE_FILE"',
        "  run child.main()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(parentJh);
    // Run 1: no unlock — imported module's agent.command must not override
    const env1: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: cmdFile,
    };
    delete env1.JAIPH_AGENT_COMMAND;
    delete env1.JAIPH_AGENT_COMMAND_LOCKED;
    delete env1.JAIPH_AGENT_COMMAND_IMPORT_UNLOCK;

    const runtime1 = new NodeWorkflowRuntime(graph, { env: env1, cwd: root, suppressLiveEvents: true });
    assert.equal(await runtime1.runMain([]), 0);

    const actual1 = readFileSync(cmdFile, "utf8");
    // child sees empty (not "injected-agent") because imported module's command is blocked
    assert.equal(actual1, "parent:\nchild:\n");

    // Run 2: with IMPORT_UNLOCK — imported module's agent.command IS applied
    writeFileSync(cmdFile, "");
    const env2: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: cmdFile,
      JAIPH_AGENT_COMMAND_IMPORT_UNLOCK: "1",
    };
    delete env2.JAIPH_AGENT_COMMAND;
    delete env2.JAIPH_AGENT_COMMAND_LOCKED;

    const runtime2 = new NodeWorkflowRuntime(graph, { env: env2, cwd: root, suppressLiveEvents: true });
    assert.equal(await runtime2.runMain([]), 0);

    const actual2 = readFileSync(cmdFile, "utf8");
    // child sees "injected-agent" because IMPORT_UNLOCK is set
    assert.equal(actual2, "parent:\nchild:injected-agent\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: entry module agent.command config is applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-entry-cmd-"));
  try {
    const jh = join(root, "entry.jh");
    const cmdFile = join(root, "cmd.log");
    writeFileSync(
      jh,
      [
        "config {",
        '  agent.command = "my-custom-agent"',
        "}",
        "export def main() {",
        '  echo "cmd:$JAIPH_AGENT_COMMAND" >> "$JAIPH_CMD_LOG"',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_CMD_LOG: cmdFile,
    };
    delete env.JAIPH_AGENT_COMMAND;
    delete env.JAIPH_AGENT_COMMAND_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    assert.equal(await runtime.runMain([]), 0);

    assert.equal(readFileSync(cmdFile, "utf8"), "cmd:my-custom-agent\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
