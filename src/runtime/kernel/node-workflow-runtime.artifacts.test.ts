import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
        "workflow default() {",
        '  const response = prompt "hello-mock"',
        '  log response',
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

test("NodeWorkflowRuntime: failed prompt preserves backend stderr in artifacts and summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-prompt-stderr-"));
  try {
    const jh = join(root, "prompt_failure.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
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
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    let status: number;
    try {
      status = await runtime.runDefault([]);
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
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-run-catch-"));
  try {
    const jh = join(root, "run_catch_payload.jh");
    writeFileSync(
      jh,
      [
        "script check_ready_impl = ```",
        'echo "analysis-stdout-log"',
        'echo "analysis-stderr-log" >&2',
        "test -f ready.txt",
        "```",
        "",
        "workflow check_ready() {",
        "  run check_ready_impl()",
        "}",
        "",
        'script write_catch_received = `echo "$1" > catch_received.txt`',
        "",
        'script write_catch_arg2 = `echo "$1" > catch_arg2.txt`',
        "",
        'script mark_ready = `touch ready.txt`',
        "",
        "workflow default(name, extra) {",
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
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault(["original-arg1", "preserved-arg2"]);
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

test("NodeWorkflowRuntime: nested workflow inherits caller metadata scope (callee module config does not override)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-"));
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
        'script log_backend = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow default() {",
        '  run log_backend("child")',
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
        'script log_backend = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow default() {",
        '  run log_backend("parent_before")',
        "  run child.default()",
        '  run log_backend("parent_after")',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_backend"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:%s\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const graph = buildRuntimeGraph(parentJh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_META_SCOPE_FILE: metaFile,
    };
    delete env.JAIPH_AGENT_BACKEND;
    delete env.JAIPH_AGENT_BACKEND_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "parent_before:cursor\nchild:cursor\nparent_after:cursor\n";
    assert.equal(actual, expected);
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
        'script log_backend = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow default() {",
        '  run log_backend("child")',
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
        'script log_backend = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow default() {",
        '  run log_backend("parent_before")',
        "  run child.default()",
        '  run log_backend("parent_after")',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_backend"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:%s\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

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

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault([]);
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
        '  agent.default_model = "module-model"',
        '  agent.backend = "cursor"',
        "}",
        "",
        'script log_env = `printf \'%s:model=%s,backend=%s\\n\' "$1" "$JAIPH_AGENT_MODEL" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_SIBLING_LOG"`',
        "",
        "workflow alpha() {",
        "  config {",
        '    agent.default_model = "alpha-model"',
        '    agent.backend = "claude"',
        "  }",
        '  run log_env("alpha")',
        "}",
        "",
        "workflow beta() {",
        "  config {",
        '    agent.default_model = "beta-model"',
        "  }",
        '  run log_env("beta")',
        "}",
        "",
        "workflow default() {",
        "  run alpha()",
        "  run beta()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_env"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:model=%s,backend=%s\n\' "$1" "$JAIPH_AGENT_MODEL" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_SIBLING_LOG"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

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

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "alpha:model=alpha-model,backend=claude\nbeta:model=beta-model,backend=cursor\n";
    assert.equal(actual, expected);
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
        "workflow default() {",
        '  const dataset = "users"',
        '  const response = prompt "Analyze the ${dataset} table"',
        '  log response',
        "}",
        "",
      ].join("\n"),
    );
    const mockFile = join(root, "mocks.txt");
    writeFileSync(mockFile, "analysis-done\n");

    const runsDir = join(root, ".jaiph", "runs");
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_FILE: mockFile,
      JAIPH_RUNS_DIR: runsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    // Bridge env so appendRunSummaryLine (reads process.env) writes the summary.
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    try {
      const status = await runtime.runDefault([]);
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

test("NodeWorkflowRuntime: heartbeat file created at construction, removed on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-heartbeat-"));
  try {
    const jh = join(root, "heartbeat.jh");
    writeFileSync(jh, 'workflow default() {\n  log "ok"\n}\n');
    const mockFile = join(root, "mocks.txt");
    writeFileSync(mockFile, "");

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_FILE: mockFile,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const runDir = runtime.getRunDir();

    const heartbeatPath = join(runDir, "heartbeat");
    assert.ok(existsSync(heartbeatPath), "heartbeat file should exist after construction");
    const ts = parseInt(readFileSync(heartbeatPath, "utf8"), 10);
    assert.ok(ts > 0 && ts <= Date.now(), "heartbeat should contain a valid epoch ms timestamp");

    await runtime.runDefault([]);
    runtime.stopHeartbeat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
