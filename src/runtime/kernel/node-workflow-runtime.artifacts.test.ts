import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

test("NodeWorkflowRuntime: runDefault writes return_value.txt with the workflow's return value", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-return-"));
  try {
    const jh = join(root, "returns.jh");
    writeFileSync(
      jh,
      [
        "workflow default(name) {",
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
    const status = await runtime.runDefault(["world"]);
    assert.equal(status, 0);

    const returnValueFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnValueFile), `expected return_value.txt in ${runtime.getRunDir()}`);
    assert.equal(readFileSync(returnValueFile, "utf8"), "hello world");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: runDefault does not write return_value.txt when workflow has no return", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-noreturn-"));
  try {
    const jh = join(root, "noreturn.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
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
    const status = await runtime.runDefault([]);
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
        "workflow default(name) {",
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
      status = await runtime.runDefault(["Adam"]);
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
    const mockJson = JSON.stringify(["mocked-agent-reply"]);

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_MOCK_RESPONSES_JSON: mockJson,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
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

test("NodeWorkflowRuntime: ensure catch receives failure payload in catch scope (explicit binding)", async () => {
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
        "rule check_ready() {",
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
        "  ensure check_ready() catch (failure) {",
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

test("NodeWorkflowRuntime: nested cross-module run applies callee module config and restores caller scope after", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.default_model = "model-b"',
        "}",
        'script log_model = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow show() {",
        '  run log_model("child")',
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
        '  agent.default_model = "model-a"',
        "}",
        'script log_model = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow default() {",
        '  run log_model("parent_before")',
        "  run child.show()",
        '  run log_model("parent_after")',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_model"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:%s\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
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
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "parent_before:model-a\nchild:model-b\nparent_after:model-a\n";
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: nested cross-module run applies callee workflow-level config over callee module-level config", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-nested-wf-"));
  try {
    const childJh = join(root, "child.jh");
    const parentJh = join(root, "parent.jh");
    const metaFile = join(root, "config_scope.log");
    writeFileSync(
      childJh,
      [
        'config {',
        '  agent.default_model = "child-module-model"',
        "}",
        'script log_model = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow show() {",
        '  config {',
        '    agent.default_model = "child-workflow-model"',
        "  }",
        '  run log_model("child")',
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
        '  agent.default_model = "model-a"',
        "}",
        "workflow default() {",
        "  run child.show()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_model"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:%s\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
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
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    assert.equal(actual, "child:child-workflow-model\n");
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
        '  agent.default_model = "model-b"',
        "}",
        'script log_model = `printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"`',
        "workflow show() {",
        '  config {',
        '    agent.default_model = "child-workflow-model"',
        "  }",
        '  run log_model("child")',
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
        '  agent.default_model = "model-a"',
        "}",
        "workflow default() {",
        "  run child.show()",
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_model"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s:%s\n\' "$1" "$JAIPH_AGENT_MODEL" >> "$JAIPH_META_SCOPE_FILE"',
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
      JAIPH_AGENT_MODEL: "env-model",
      JAIPH_AGENT_MODEL_LOCKED: "1",
    };

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
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

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
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

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    const expected = "alpha:model=alpha-model,backend=claude\nbeta:model=beta-model,backend=cursor\n";
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NodeWorkflowRuntime: workflow config interpolates workflow parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-meta-param-"));
  try {
    const jh = join(root, "param_config.jh");
    const metaFile = join(root, "param_scope.log");
    writeFileSync(
      jh,
      [
        'script log_model = `printf \'model:%s\\n\' "$JAIPH_AGENT_MODEL" >> "$JAIPH_PARAM_LOG"`',
        "",
        "workflow implement(model) {",
        "  config {",
        "    agent.default_model = model",
        "  }",
        '  run log_model()',
        "}",
        "",
        "workflow default() {",
        '  run implement("workflow-model")',
        "}",
        "",
      ].join("\n"),
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "log_model"),
      [
        "#!/usr/bin/env bash",
        'printf \'model:%s\n\' "$JAIPH_AGENT_MODEL" >> "$JAIPH_PARAM_LOG"',
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
      JAIPH_PARAM_LOG: metaFile,
    };
    delete env.JAIPH_AGENT_MODEL;
    delete env.JAIPH_AGENT_MODEL_LOCKED;

    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);

    const actual = readFileSync(metaFile, "utf8");
    assert.equal(actual, "model:workflow-model\n");
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

test("NodeWorkflowRuntime: JAIPH_ARTIFACTS_DIR is set and points at writable artifacts/ subdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-artifacts-dir-"));
  try {
    const jh = join(root, "artifacts_env.jh");
    writeFileSync(jh, 'workflow default() {\n  log "ok"\n}\n');

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
    writeFileSync(jh, 'workflow default() {\n  log "ok"\n}\n');

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
    writeFileSync(jh, 'workflow default() {\n  log "ok"\n}\n');
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

    await runtime.runDefault([]);
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
    "workflow producer() {",
    '  results <- "dispatch-order-payload"',
    "}",
    "",
    "workflow consumer_a(message, chan, sender) {",
    '  log "consumer_a"',
    "}",
    "",
    "workflow consumer_b(message, chan, sender) {",
    '  log "consumer_b"',
    "}",
    "",
    "workflow default() {",
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
        status = await runtime.runDefault([]);
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
      status = await runtime.runDefault([]);
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
      "workflow on_ping(message, chan, sender) {",
      '  pong <- "p"',
      "}",
      "",
      "workflow on_pong(message, chan, sender) {",
      '  ping <- "p"',
      "}",
      "",
      "workflow default() {",
      '  ping <- "start"',
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
      "workflow on_loop(message, chan, sender) {",
      '  loop <- "again"',
      "}",
      "",
      "workflow default() {",
      '  loop <- "start"',
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
      "workflow producer() {",
      '  ch <- "m1"',
      '  ch <- "m2"',
      '  ch <- "m3"',
      "}",
      "",
      "workflow sink_a(message, chan, sender) {",
      '  log "a"',
      "}",
      "",
      "workflow sink_b(message, chan, sender) {",
      '  log "b"',
      "}",
      "",
      "workflow sink_c(message, chan, sender) {",
      '  log "c"',
      "}",
      "",
      "workflow default() {",
      "  run producer()",
      "}",
      "",
    ].join("\n"),
  });
  assert.equal(status, 0, "fan-out below the cap must succeed");
  assert.ok(!summary.includes("E_INBOX_DISPATCH_LIMIT"), "must not flag the cap below the limit");
});
