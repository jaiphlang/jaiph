import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("NodeWorkflowRuntime: ensure recover receives failure payload in $1", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-node-wf-ensure-recover-"));
  try {
    const jh = join(root, "ensure_recover_payload.jh");
    writeFileSync(
      jh,
      [
        "script check_ready_impl() {",
        '  echo "analysis-stdout-log"',
        '  echo "analysis-stderr-log" >&2',
        "  test -f ready.txt",
        "}",
        "",
        "rule check_ready {",
        "  run check_ready_impl",
        "}",
        "",
        "script write_recover_received() {",
        '  echo "$1" > recover_received.txt',
        "}",
        "",
        "script write_recover_arg2() {",
        '  echo "$1" > recover_arg2.txt',
        "}",
        "",
        "script mark_ready() {",
        "  touch ready.txt",
        "}",
        "",
        "workflow default {",
        "  ensure check_ready recover {",
        '    run write_recover_received "$1"',
        '    run write_recover_arg2 "$2"',
        "    run mark_ready",
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
    writeFileSync(join(scriptsDir, "write_recover_received"), '#!/usr/bin/env bash\nprintf "%s" "$1" > recover_received.txt\n', {
      mode: 0o755,
    });
    writeFileSync(join(scriptsDir, "write_recover_arg2"), '#!/usr/bin/env bash\nprintf "%s" "$1" > recover_arg2.txt\n', {
      mode: 0o755,
    });
    writeFileSync(join(scriptsDir, "mark_ready"), "#!/usr/bin/env bash\ntouch ready.txt\n", { mode: 0o755 });

    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault(["original-arg1", "preserved-arg2"]);
    assert.equal(status, 0);

    const recoverPayload = readFileSync(join(root, "recover_received.txt"), "utf8");
    assert.match(recoverPayload, /analysis-stdout-log/);
    assert.match(recoverPayload, /analysis-stderr-log/);

    const recoverArg2 = readFileSync(join(root, "recover_arg2.txt"), "utf8").trim();
    assert.equal(recoverArg2, "preserved-arg2");
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
        "script log_backend() {",
        '  printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "workflow default {",
        '  run log_backend "child"',
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
        "script log_backend() {",
        '  printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "workflow default {",
        '  run log_backend "parent_before"',
        "  run child.default",
        '  run log_backend "parent_after"',
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
        "script log_backend() {",
        '  printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "workflow default {",
        '  run log_backend "child"',
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
        "script log_backend() {",
        '  printf \'%s:%s\\n\' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"',
        "}",
        "workflow default {",
        '  run log_backend "parent_before"',
        "  run child.default",
        '  run log_backend "parent_after"',
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
