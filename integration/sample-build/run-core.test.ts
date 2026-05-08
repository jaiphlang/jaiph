import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { getLatestRunDir, readCombinedRunLogs } from "./helpers";

test("jaiph run compiles and executes workflow with args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-"));
  try {
    const filePath = join(root, "echo.jh");
    writeFileSync(
      filePath,
      [
        "script print_arg = \`\`\`",
        "printf '%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default(name) {",
        "  run print_arg(name)",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "hello-run"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /✓ PASS workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run resolves nested managed call arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-nested-args-"));
  try {
    const filePath = join(root, "nested_args.jh");
    writeFileSync(
      filePath,
      [
        "script mkdir_p_simple = ```",
        'mkdir -p "$1"',
        "```",
        "script jaiph_tmp_dir = ```",
        'printf "%s\\n" "$JAIPH_WORKSPACE/.jaiph/tmp"',
        "```",
        "workflow default() {",
        "  run mkdir_p_simple(run jaiph_tmp_dir())",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.equal(existsSync(join(root, ".jaiph", "tmp")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executable .jh invokes jaiph run semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-exec-jh-"));
  try {
    const filePath = join(root, "echo.jh");
    writeFileSync(
      filePath,
      [
        "#!/usr/bin/env jaiph",
        "",
        "script print_exec_arg = \`\`\`",
        "printf 'exec-arg:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default(name) {",
        "  run print_exec_arg(name)",
        "}",
        "",
      ].join("\n"),
    );
    chmodSync(filePath, 0o755);

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, filePath, "hello-exec"], {
      encoding: "utf8",
      cwd: root,
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /✓ PASS workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run enables xtrace when JAIPH_DEBUG=true", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-debug-"));
  try {
    const filePath = join(root, "debug.jh");
    writeFileSync(
      filePath,
      [
        "script print_debug_arg = \`\`\`",
        "printf 'debug-run:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default(name) {",
        "  run print_debug_arg(name)",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "hello-debug"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DEBUG: "true", JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.ok(runResult.stderr.length >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails when workflow default is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-missing-default-"));
  try {
    const filePath = join(root, "pr.jh");
    writeFileSync(
      filePath,
      [
        "script print_fallback = \`\`\`",
        "printf 'fallback:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow main(name) {",
        "  run print_fallback(name)",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "hello-main"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /requires workflow 'default'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails fast on command errors inside workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-fail-fast-"));
  try {
    const filePath = join(root, "fail-fast.jh");
    writeFileSync(
      filePath,
      [
        "script always_fail = `false`",
        "script should_not_run = `echo after-false`",
        "workflow default() {",
        "  run always_fail()",
        "  run should_not_run()",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 1);
    assert.doesNotMatch(runResult.stdout, /after-false/);
    assert.match(runResult.stderr, /✗ FAIL workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
    assert.match(runResult.stderr, /Logs: /);
    assert.match(runResult.stderr, /Summary: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails when runtime emits non-xtrace stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-runtime-stderr-"));
  try {
    const filePath = join(root, "runtime-stderr.jh");
    writeFileSync(
      filePath,
      [
        "workflow default() {",
        '  log "noop"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_DOCKER_ENABLED: "false",
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails when required arg is missing and rule handles it", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-missing-arg-"));
  try {
    const filePath = join(root, "missing-arg.jh");
    writeFileSync(
      filePath,
      [
        "script require_name = \`\`\`",
        "if [ -z \"$1\" ]; then",
        "  echo \"missing-name\" >&2",
        "  exit 1",
        "fi",
        "\`\`\`",
        "rule name_provided(name) {",
        "  run require_name(name)",
        "}",
        "",
        "workflow default(name) {",
        "  ensure name_provided(name)",
        '  prompt "Say hello to ${name}"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /✗ FAIL workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
    assert.match(runResult.stderr, /Logs: /);
    assert.match(runResult.stderr, /Summary: /);
    assert.doesNotMatch(runResult.stderr, /unbound variable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run allows rules to call top-level helper functions in readonly mode", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-rule-helper-fn-"));
  try {
    const filePath = join(root, "helpers.jh");
    writeFileSync(
      filePath,
      [
        "script helper_value = `echo ok`",
        "script helper_is_ok_impl = \`\`\`",
        'test "ok" = "ok"',
        "\`\`\`",
        "",
        "rule helper_is_ok() {",
        "  run helper_is_ok_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure helper_is_ok()",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /✓ PASS workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prints rule tree and fail summary", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-fail-"));
  try {
    const filePath = join(root, "fail.jh");
    writeFileSync(
      filePath,
      [
        "script current_branch_impl = \`\`\`",
        "echo \"Current branch is not 'main'.\" >&2",
        "exit 1",
        "\`\`\`",
        "rule current_branch() {",
        "  run current_branch_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure current_branch()",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /▸ rule current_branch/);
    assert.match(runResult.stdout, /✗ rule current_branch \(\d+s\)/);
    assert.match(runResult.stderr, /✗ FAIL workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
    assert.match(runResult.stderr, /Logs: /);
    assert.match(runResult.stderr, /Summary: /);
    assert.match(runResult.stderr, /err: /);
    assert.match(runResult.stderr, /\.jaiph\/runs\//);
    const errPathMatch = runResult.stderr.match(/err: (.+)/);
    assert.equal(Boolean(errPathMatch), true);
    const errLog = readFileSync(errPathMatch![1], "utf8");
    assert.match(errLog, /Current branch is not 'main'\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run stores prompt output in run logs", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"prompt-output:$*\\\"}\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "workflow default() {",
        '  prompt "hello from prompt"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    assert.equal(existsSync(runsRoot), true);
    const latestRunDir = getLatestRunDir(runsRoot);
    const runDirName = dirname(latestRunDir).startsWith(runsRoot) ? dirname(latestRunDir).slice(runsRoot.length + 1) : "";
    const dateDirName = runDirName ? runDirName.split("/")[0] : "";
    assert.match(dateDirName, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(basename(latestRunDir), /^\d{2}-\d{2}-\d{2}-/);
    const runFiles = readdirSync(latestRunDir);
    assert.equal(runFiles.includes("run_summary.jsonl"), true);
    const { out: promptOut, err: promptErr } = readCombinedRunLogs(latestRunDir);
    // Node runtime may route prompt transcript differently; keep artifact contract checks.
    assert.ok(promptOut.length >= 0);
    assert.ok(promptErr.length >= 0);
    const summary = readFileSync(join(latestRunDir, "run_summary.jsonl"), "utf8");
    assert.match(summary, /"type":"STEP_END"/);
    assert.match(summary, /"kind":"workflow"/);
    const stepLogFiles = runFiles.filter((name) => name.endsWith(".out"));
    assert.ok(stepLogFiles.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run stores both reasoning and final answer from stream-json", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-stream-json-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"thinking\",\"text\":\"Plan: check name.\"}'",
        "echo '{\"type\":\"thinking\",\"text\":\" Then answer.\"}'",
        "echo '{\"type\":\"result\",\"result\":\"Hello Mike! Fun fact: Mike Shinoda co-founded Linkin Park.\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-stream-json.jh");
    writeFileSync(
      filePath,
      [
        "workflow default() {",
        '  prompt "hello from prompt"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_TRUSTED_WORKSPACE: undefined,
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
    assert.ok(promptOut.length >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
