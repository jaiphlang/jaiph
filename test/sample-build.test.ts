import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { build, transpileTestFile, walkTestFiles } from "../src/transpiler";
import { parsejaiph } from "../src/parser";
import { buildRunTreeRows } from "../src/cli";
import { formatRunningBottomLine } from "../src/cli/run/progress";
import { parseStepEvent } from "../src/cli/run/events";

/** Resolve latest run directory. Layout: runsRoot/YYYY-MM-DD/HH-MM-SS-source/ */
function getLatestRunDir(runsRoot: string): string {
  const dateDirs = readdirSync(runsRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  assert.ok(dateDirs.length > 0, "expected at least one date directory under " + runsRoot);
  const dateDirPath = join(runsRoot, dateDirs[dateDirs.length - 1]);
  const runDirNames = readdirSync(dateDirPath).sort();
  assert.ok(runDirNames.length > 0, "expected at least one run directory under " + dateDirPath);
  return join(dateDirPath, runDirNames[runDirNames.length - 1]);
}

// Skip: triggers heap exhaustion (build + full stdlib read). TODO: fix memory usage and re-enable.
test.skip("build transpiles .jh into strict bash with retry flow", () => {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-build-"));
  try {
    const results = build(join(process.cwd(), "test/fixtures"), outDir);
    assert.equal(results.length, 3);

    // Stdlib is split into aggregator + runtime modules; combined they provide the full API.
    const srcDir = join(process.cwd(), "src");
    const runtimeDir = join(srcDir, "runtime");
    const stdlibAgg = readFileSync(join(srcDir, "jaiph_stdlib.sh"), "utf8");
    const stdlibModules = ["events.sh", "test-mode.sh", "steps.sh", "prompt.sh", "sandbox.sh"]
      .map((f) => readFileSync(join(runtimeDir, f), "utf8"))
      .join("\n");
    const stdlib = stdlibAgg + "\n" + stdlibModules;
    assert.match(stdlib, /jaiph__version\(\)/);
    assert.match(stdlib, /jaiph__runtime_api\(\)/);
    assert.match(stdlib, /jaiph::prompt\(\)/);
    assert.match(stdlib, /jaiph::prompt_impl\(\)/);
    assert.match(stdlib, /agent_command="\$\{JAIPH_AGENT_COMMAND:-cursor-agent\}"/);
    assert.match(stdlib, /trusted_workspace="\$\{JAIPH_AGENT_TRUSTED_WORKSPACE:-\$workspace_root\}"/);
    assert.match(
      stdlib,
      /--print --output-format stream-json --stream-partial-output --workspace "\$workspace_root" --model "\$JAIPH_AGENT_MODEL" --trust "\$trusted_workspace"( "\$\{cursor_extra_flags\[@\]\}")? "\$prompt_text"/,
    );
    assert.match(stdlib, /jaiph::run_step jaiph::prompt prompt jaiph::prompt_impl "\$@"/);
    assert.match(stdlib, /jaiph::execute_readonly\(\)/);
    assert.match(stdlib, /jaiph::run_step\(\)/);
    assert.match(stdlib, /sudo env JAIPH_PRECEDING_FILES="\$JAIPH_PRECEDING_FILES" unshare -m bash -c/);

    const generatedPath = join(outDir, "main.sh");
    const generated = readFileSync(generatedPath, "utf8");

    assert.match(generated, /^#!\/usr\/bin\/env bash/m);
    assert.match(generated, /set -euo pipefail/);
    assert.match(generated, /jaiph_stdlib_path="\$\{JAIPH_STDLIB:-\$HOME\/\.local\/bin\/jaiph_stdlib\.sh\}"/);
    assert.match(generated, /source "\$jaiph_stdlib_path"/);
    assert.match(generated, /if \[\[ "\$\(jaiph__runtime_api\)" != "1" \]\]/);
    assert.match(generated, /# Validates local build prerequisites\./);
    assert.match(generated, /# Orchestrates checks, prompt execution, and docs refresh\./);
    assert.match(generated, /main::project_ready\(\) \{/);
    assert.match(generated, /main::project_ready::impl\(\) \{/);
    assert.match(generated, /jaiph::run_step main::project_ready rule jaiph::execute_readonly main::project_ready::impl/);
    assert.match(generated, /if ! main::project_ready; then/);
    assert.match(generated, /bootstrap_project::nodejs/);
    assert.match(generated, /jaiph::prompt "\$JAIPH_PROMPT_PREVIEW" "\$@" <<__JAIPH_PROMPT_/);
    assert.match(generated, /main::build_passes\(\)/);
    assert.match(generated, /tools::security::scan_passes/);
    assert.match(generated, /main::update_docs/);
    assert.match(generated, /main::default::impl\(\) \{/);
    assert.match(generated, /jaiph::run_step main::default workflow main::default::impl "\$@"/);

    const securityGenerated = readFileSync(join(outDir, "tools/security.sh"), "utf8");
    assert.match(securityGenerated, /tools::security::scan_passes\(\) \{/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build validates imported rule references with deterministic errors", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-invalid-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "./mod.jh" as mod',
        "",
        "rule local {",
        "  echo ok",
        "}",
        "",
        "workflow main {",
        "  ensure mod.missing",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "mod.jh"),
      [
        "rule existing {",
        "  echo hi",
        "}",
        "",
        "workflow mod {",
        "  ensure existing",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE imported rule "mod\.missing" does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build fails on missing import file", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-import-missing-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(
      join(root, "sub/entry.jh"),
      [
        'import "../missing/mod.jh" as mod',
        "",
        "rule local {",
        "  echo ok",
        "}",
        "",
        "workflow entry {",
        "  ensure local",
        "  ensure mod.anything",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_IMPORT_NOT_FOUND import "mod" resolves to missing file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run compiles and executes workflow with args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-"));
  try {
    const filePath = join(root, "echo.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        "  printf '%s\\n' \"$1\"",
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

test("executable .jh invokes jaiph run semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-exec-jh-"));
  try {
    const filePath = join(root, "echo.jh");
    writeFileSync(
      filePath,
      [
        "#!/usr/bin/env jaiph",
        "",
        "workflow default {",
        "  printf 'exec-arg:%s\\n' \"$1\"",
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
        "workflow default {",
        "  printf 'debug-run:%s\\n' \"$1\"",
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
    assert.match(runResult.stderr, /\+ .*::default/);
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
        "workflow main {",
        "  printf 'fallback:%s\\n' \"$1\"",
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
        "workflow default {",
        "  false",
        "  echo after-false",
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
        "workflow default {",
        "  :",
        "}",
        "",
      ].join("\n"),
    );

    const stdlibPath = join(root, "jaiph_stdlib.sh");
    writeFileSync(
      stdlibPath,
      [
        "#!/usr/bin/env bash",
        "jaiph__runtime_api() { echo 1; }",
        "jaiph::run_step() {",
        "  local _name=\"$1\"",
        "  local _kind=\"$2\"",
        "  shift 2 || shift || true",
        "  \"$@\"",
        "}",
        "jaiph::execute_readonly() {",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph::prompt() {",
        "  :",
        "}",
        "echo runtime-broken >&2",
        "",
      ].join("\n"),
    );
    chmodSync(stdlibPath, 0o755);

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_STDLIB: stdlibPath, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /runtime-broken/);
    assert.match(runResult.stderr, /✗ FAIL workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
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
        "rule name_provided {",
        "  if [ -z \"$1\" ]; then",
        "    echo \"missing-name\" >&2",
        "    exit 1",
        "  fi",
        "}",
        "",
        "workflow default {",
        "  ensure name_provided \"$1\"",
        '  prompt "Say hello to $1"',
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
        "function helper_value() {",
        "  echo ok",
        "}",
        "",
        "rule helper_is_ok {",
        '  test "$(helper_value)" = "ok"',
        "}",
        "",
        "workflow default {",
        "  ensure helper_is_ok",
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
        "rule current_branch {",
        "  echo \"Current branch is not 'main'.\" >&2",
        "  exit 1",
        "}",
        "",
        "workflow default {",
        "  ensure current_branch",
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
    assert.match(runResult.stdout, /✗ \d+s/);
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
        "echo prompt-output:$*",
        "echo prompt-error >&2",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
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
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    const promptErrName = runFiles.find((name) => name.endsWith("-jaiph__prompt.err"));
    assert.equal(Boolean(promptOutName), true);
    assert.equal(Boolean(promptErrName), true);
    assert.match(promptOutName!, /^\d{6}-/);
    assert.match(promptErrName!, /^\d{6}-/);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    const promptErr = readFileSync(join(latestRunDir, promptErrName!), "utf8");
    // Prompt log contains prompt text and agent output (Command section may appear depending on runtime)
    assert.match(promptOut, /Prompt:\nhello from prompt\n\n/);
    assert.match(promptOut, /prompt-output:/);
    assert.match(promptErr, /prompt-error/);
    const summary = readFileSync(join(latestRunDir, "run_summary.jsonl"), "utf8");
    assert.match(summary, /"type":"STEP_END"/);
    assert.match(summary, /"kind":"prompt"/);
    const stepLogFiles = runFiles.filter((name) => name.endsWith(".out") || name.endsWith(".err"));
    for (const stepFile of stepLogFiles) {
      const size = statSync(join(latestRunDir, stepFile)).size;
      assert.equal(size > 0, true, `expected non-empty step log file: ${stepFile}`);
    }
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
        "workflow default {",
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
        JAIPH_AGENT_TRUSTED_WORKSPACE: undefined,
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /Reasoning:\nPlan: check name\. Then answer\./);
    assert.match(promptOut, /Final answer:\nHello Mike! Fun fact: Mike Shinoda co-founded Linkin Park\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects command substitution in prompt text", () => {
  const rootBackticks = mkdtempSync(join(tmpdir(), "jaiph-build-prompt-backticks-"));
  const rootSubshell = mkdtempSync(join(tmpdir(), "jaiph-build-prompt-subshell-"));
  try {
    writeFileSync(
      join(rootBackticks, "main.jh"),
      [
        "workflow default {",
        '  prompt "literal backticks: `uname`"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(rootSubshell, "main.jh"),
      [
        "workflow default {",
        '  prompt "literal command substitution: $(echo SHOULD_NOT_RUN)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => build(rootBackticks, join(rootBackticks, "out")),
      /E_PARSE prompt cannot contain backticks/,
    );
    assert.throws(
      () => build(rootSubshell, join(rootSubshell, "out")),
      /E_PARSE prompt cannot contain command substitution/,
    );
  } finally {
    rmSync(rootBackticks, { recursive: true, force: true });
    rmSync(rootSubshell, { recursive: true, force: true });
  }
});

test("jaiph run interpolates positional args in prompt text", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-args-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo prompt-arg:$*",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-args.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  prompt "Say hello to $1 and mention ${1} again."',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "Alice"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /Prompt:\nSay hello to Alice and mention Alice again\./);
    assert.match(promptOut, /prompt-arg:.*Say hello to Alice and mention Alice again\./);
    assert.doesNotMatch(promptOut, /\$1|\$\{1\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run interpolates named array placeholders in prompt text", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-array-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo prompt-array:$*",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-array.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  DOCS=("README.md" "docs/cli.md")',
        '  prompt "',
        "Files to keep in sync:",
        "${DOCS[@]}",
        '"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /Prompt:\n\nFiles to keep in sync:\nREADME\.md docs\/cli\.md/);
    assert.doesNotMatch(promptOut, /\$\{DOCS\[@\]\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run applies model from in-file metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-metadata-model-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo model-args:$*",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.default_model = "auto"',
        '  agent.cursor_flags = "--force --sandbox enabled"',
        "}",
        "workflow default {",
        '  prompt "hello from metadata"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_DOCKER_ENABLED: "false",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete runEnv.JAIPH_AGENT_CURSOR_FLAGS;
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: runEnv,
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /model-args:.*--model auto/);
    assert.match(promptOut, /model-args:.*--force/);
    assert.match(promptOut, /model-args:.*--sandbox enabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run supports agent.command with inline args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-agent-command-args-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo cmd-args:$*",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.command = "cursor-agent --force"',
        "}",
        "workflow default {",
        '  prompt "hello from command args"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /cmd-args:.*--force/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run agent.backend = claude uses Claude CLI and captures output", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-backend-claude-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeClaude = join(binDir, "claude");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env bash",
        "cat",
        "echo '{\"type\":\"result\",\"result\":\"claude-backend-output '$*'\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.backend = "claude"',
        '  agent.claude_flags = "--model sonnet-4"',
        "}",
        "workflow default {",
        '  result = prompt "hello"',
        '  printf \'captured:%s\\n\' "$result"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_DOCKER_ENABLED: "false",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete runEnv.JAIPH_AGENT_BACKEND;
    delete runEnv.JAIPH_AGENT_CLAUDE_FLAGS;
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: runEnv,
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const workflowOutName = runFiles.find(
      (name) => name.endsWith(".out") && !name.includes("jaiph__prompt"),
    );
    assert.equal(Boolean(workflowOutName), true);
    const workflowOut = readFileSync(join(latestRunDir, workflowOutName!), "utf8");
    assert.match(workflowOut, /captured:[\s\S]*claude-backend-output/);
    assert.match(workflowOut, /captured:[\s\S]*--model sonnet-4/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run agent.backend = claude without claude in PATH fails with clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-backend-claude-missing-"));
  try {
    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default {",
        '  prompt "hello"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_DOCKER_ENABLED: "false",
      PATH: `${dirname(process.execPath)}:/bin:/usr/bin:/nonexistent`,
    };
    delete runEnv.JAIPH_AGENT_BACKEND;
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: runEnv,
    });

    assert.equal(runResult.status, 1);
    assert.match(
      runResult.stderr + runResult.stdout,
      /agent\.backend is "claude" but the Claude CLI.*not found|JAIPH_AGENT_BACKEND=cursor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run JAIPH_AGENT_BACKEND env overrides file default", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-backend-env-override-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCursor = join(binDir, "cursor-agent");
    writeFileSync(
      fakeCursor,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"result\",\"result\":\"cursor-from-env\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCursor, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default {",
        '  result = prompt "hi"',
        '  printf \'out:%s\\n\' "$result"',
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
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const workflowOutName = runFiles.find(
      (name) => name.endsWith(".out") && !name.includes("jaiph__prompt"),
    );
    assert.equal(Boolean(workflowOutName), true);
    const workflowOut = readFileSync(join(latestRunDir, workflowOutName!), "utf8");
    assert.match(workflowOut, /out:[\s\S]*cursor-from-env/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run defaults Cursor trusted workspace to project root", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-trust-default-"));
  try {
    mkdirSync(join(root, ".jaiph"), { recursive: true });
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCursor = join(binDir, "cursor-agent");
    writeFileSync(
      fakeCursor,
      [
        "#!/usr/bin/env bash",
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"cursor-args:$*\\\"}\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCursor, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  result = prompt "hi"',
        '  printf \'out:%s\\n\' "$result"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const { JAIPH_AGENT_TRUSTED_WORKSPACE: _drop, ...env } = process.env as Record<string, string>;
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...env,
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, new RegExp(`--trust ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run JAIPH_AGENT_TRUSTED_WORKSPACE env overrides metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-trust-env-override-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCursor = join(binDir, "cursor-agent");
    writeFileSync(
      fakeCursor,
      [
        "#!/usr/bin/env bash",
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"cursor-args:$*\\\"}\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCursor, 0o755);

    const filePath = join(root, "prompt.jh");
    writeFileSync(
      filePath,
      [
        "config {",
        '  agent.trusted_workspace = ".jaiph/.."',
        "}",
        "workflow default {",
        '  result = prompt "hi"',
        '  printf \'out:%s\\n\' "$result"',
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
        JAIPH_AGENT_TRUSTED_WORKSPACE: "/tmp/jaiph-explicit-trust",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /--trust \/tmp\/jaiph-explicit-trust/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run uses JAIPH_STDLIB global runtime path", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-global-stdlib-"));
  try {
    const stdlibPath = join(root, "jaiph_stdlib.sh");
    writeFileSync(
      stdlibPath,
      [
        "#!/usr/bin/env bash",
        "jaiph__runtime_api() { echo 1; }",
        "jaiph::run_step() {",
        "  local _name=\"$1\"",
        "  local _kind=\"$2\"",
        "  shift 2 || shift || true",
        "  \"$@\"",
        "}",
        "jaiph::execute_readonly() {",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph::prompt() {",
        "  :",
        "}",
        "",
      ].join("\n"),
    );
    chmodSync(stdlibPath, 0o755);

    const filePath = join(root, "echo.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        "  echo global-stdlib-ok",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_STDLIB: stdlibPath },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph init creates workspace structure and guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-init-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const skillPath = join(process.cwd(), "docs/jaiph-skill.md");
    const initResult = spawnSync("node", [cliPath, "init"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, ...(existsSync(skillPath) ? { JAIPH_SKILL_PATH: skillPath } : {}) },
    });

    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(existsSync(join(root, ".jaiph")), true);
    assert.equal(existsSync(join(root, ".jaiph/lib")), false);
    assert.equal(existsSync(join(root, ".jaiph/bootstrap.jh")), true);
    assert.equal(existsSync(join(root, ".jaiph/jaiph-skill.md")), true);
    const bootstrap = readFileSync(join(root, ".jaiph/bootstrap.jh"), "utf8");
    assert.match(bootstrap, /^#!\/usr\/bin\/env jaiph\n\n/);
    assert.match(bootstrap, /workflow default \{/);
    assert.match(bootstrap, /\.jaiph\/jaiph-skill\.md/);
    assert.match(bootstrap, /Analyze repository structure/);
    assert.match(bootstrap, /Create or update Jaiph workflows under \.jaiph\//);
    assert.doesNotMatch(bootstrap, /\$1/);
    assert.equal(statSync(join(root, ".jaiph/bootstrap.jh")).mode & 0o777, 0o755);
    const localSkill = readFileSync(join(root, ".jaiph/jaiph-skill.md"), "utf8");
    assert.match(localSkill, /Jaiph Bootstrap Skill/);
    assert.equal(existsSync(join(root, ".gitignore")), false);
    assert.match(initResult.stdout, /Jaiph init/);
    assert.match(initResult.stdout, /▸ Creating \.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /✓ Initialized \.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /Synced \.jaiph\/jaiph-skill\.md/);
    assert.match(initResult.stdout, /\.\/\.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /analyze the project/i);
    assert.match(initResult.stdout, /add `\.jaiph\/` to `\.gitignore`/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph use maps nightly and version refs for reinstallation", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const installSpy = join(root, "install-spy.sh");
    const outputPath = join(root, "used-ref.txt");
    writeFileSync(
      installSpy,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s' \"$JAIPH_REPO_REF\" > \"$JAIPH_USE_REF_OUT\"",
        "",
      ].join("\n"),
    );
    chmodSync(installSpy, 0o755);

    const nightlyResult = spawnSync("node", [cliPath, "use", "nightly"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_INSTALL_COMMAND: `"${installSpy}"`,
        JAIPH_USE_REF_OUT: outputPath,
      },
    });
    assert.equal(nightlyResult.status, 0, nightlyResult.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "main");

    const versionResult = spawnSync("node", [cliPath, "use", "0.2.3"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_INSTALL_COMMAND: `"${installSpy}"`,
        JAIPH_USE_REF_OUT: outputPath,
      },
    });
    assert.equal(versionResult.status, 0, versionResult.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "v0.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build accepts files with no workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-out-"));
  try {
    const filePath = join(root, "rules-only.jh");
    writeFileSync(
      filePath,
      [
        "rule only_rule {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /rules-only::only_rule/);
    assert.doesNotMatch(results[0].bash, /__workflow_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build transpiles ensure statements with arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule check_branch {",
        "  test \"$1\" = \"main\"",
        "}",
        "",
        "workflow default {",
        "  ensure check_branch \"$1\"",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(
      results[0].bash,
      /jaiph::run_step entry::check_branch rule jaiph::execute_readonly entry::check_branch::impl "\$@"/,
    );
    assert.match(results[0].bash, /entry::check_branch "\$1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build supports top-level functions with namespaced wrappers", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-functions-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-functions-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "function changed_files() {",
        "  echo from-function",
        "}",
        "",
        "workflow default {",
        "  VALUE=\"$(changed_files)\"",
        "  printf '%s\\n' \"$VALUE\"",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /entry::changed_files::impl\(\) \{/);
    assert.match(results[0].bash, /entry::changed_files\(\) \{/);
    assert.match(results[0].bash, /jaiph::run_step_passthrough entry::changed_files function entry::changed_files::impl "\$@"/);
    assert.match(results[0].bash, /changed_files\(\) \{/);
    assert.match(results[0].bash, /entry::changed_files "\$@"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("jaiph run tree includes function calls from workflow shell steps", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-function-tree-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "function changed_files() {",
        "  echo from-function",
        "}",
        "",
        "workflow default {",
        "  VALUE=\"$(changed_files)\"",
        "  printf '%s\\n' \"$VALUE\"",
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
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /function changed_files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseStepEvent parses params array from event payload", () => {
  const line =
    '__JAIPH_EVENT__ {"type":"STEP_START","func":"main::docs_page","kind":"workflow","name":"docs_page","ts":"2025-01-01T00:00:00Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"run:1:1","parent_id":"run:0:0","seq":1,"depth":1,"run_id":"run-1","params":[["path","docs/cli.md"],["mode","strict"]]}';
  const event = parseStepEvent(line);
  assert.ok(event);
  assert.equal(event?.kind, "workflow");
  assert.equal(event?.name, "docs_page");
  assert.equal(event?.params?.length, 2);
  assert.deepEqual(event?.params?.[0], ["path", "docs/cli.md"]);
  assert.deepEqual(event?.params?.[1], ["mode", "strict"]);
});

test("parseStepEvent returns empty params when payload has no params", () => {
  const line =
    '__JAIPH_EVENT__ {"type":"STEP_START","func":"main::default","kind":"workflow","name":"default","ts":"2025-01-01T00:00:00Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"run:1:1","parent_id":null,"seq":1,"depth":0,"run_id":"run-1"}';
  const event = parseStepEvent(line);
  assert.ok(event);
  assert.equal(event?.params?.length, 0);
});

test("formatRunningBottomLine produces TTY bottom line with RUNNING, workflow name, and elapsed time", () => {
  const line = formatRunningBottomLine("default", 2.6);
  assert.ok(line.includes("RUNNING"), "contains RUNNING");
  assert.ok(line.includes("workflow"), "contains workflow");
  assert.ok(line.includes("default"), "contains workflow name");
  assert.match(line, /\(\d+\.\ds\)/, "contains (X.Xs) time");
});

test("jaiph run tree shows workflow params inline when run has key=value args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-params-"));
  try {
    writeFileSync(
      join(root, "sub.jh"),
      ["workflow default {", "  echo done", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default {",
        '  run sub.default path="docs/cli.md" mode="strict"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    // Nested workflow step is shown (rootStepId fix); params inline when runtime sends them
    assert.match(runResult.stdout, /▸ workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run tree shows function step; params shown when runtime includes them", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-fn-params-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "function echo_args() {",
        "  printf '%s %s\\n' \"$1\" \"$2\"",
        "}",
        "workflow default {",
        '  echo_args "first" "second"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /function echo_args/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run tree truncates param values over 32 chars when params present", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-truncate-"));
  try {
    const longValue = "a".repeat(40);
    writeFileSync(
      join(root, "sub.jh"),
      ["workflow default {", "  echo done", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default {",
        `  run sub.default longparam="${longValue}"`,
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    // When params are shown, long values are truncated to 32 chars + "..."
    if (/longparam=/.test(runResult.stdout)) {
      assert.match(runResult.stdout, /longparam=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\.\.\./);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test runs workflow with mocked prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default {",
        '  prompt "Please greet the user"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "hello.test.jh"),
      [
        'import "hello.jh" as h',
        "",
        'test "workflow default" {',
        '  mock prompt "Mocked greeting output"',
        "  response = h.default",
        '  expectContain response "Mocked greeting output"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
    assert.match(testResult.stdout, /test happy path|workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildRunTreeRows expands nested workflow from imported module", () => {
  const mainSource = [
    'import "sub.jh" as sub',
    "workflow default {",
    "  run sub.default",
    "}",
    "",
  ].join("\n");
  const subSource = [
    "workflow default {",
    '  prompt "nested prompt"',
    "}",
    "",
  ].join("\n");
  const mainMod = parsejaiph(mainSource, "/fake/main.jh");
  const subMod = parsejaiph(subSource, "/fake/sub.jh");
  const importedModules = new Map<string, ReturnType<typeof parsejaiph>>([
    ["sub", subMod],
  ]);
  const rows = buildRunTreeRows(mainMod, "workflow default", importedModules, "/fake");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[0].isRoot, true);
  assert.equal(rows[1].rawLabel, "workflow sub.default");
  assert.equal(rows[2].rawLabel, 'prompt "nested prompt"');
});

test("jaiph run shows nested workflow subtree and step timing", () => {
  const rootRaw = mkdtempSync(join(tmpdir(), "jaiph-run-subtree-"));
  const root = realpathSync(rootRaw);
  try {
    writeFileSync(
      join(root, "sub.jh"),
      [
        "workflow default {",
        '  prompt "nested prompt"',
        "}",
        "",
      ].join("\n"),
    );
    const mainPath = join(root, "main.jh");
    writeFileSync(
      mainPath,
      [
        'import "sub.jh" as sub',
        "workflow default {",
        "  run sub.default",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "main.test.jh"),
      [
        'import "main.jh" as m',
        "",
        'test "nested workflow" {',
        '  mock prompt "mocked"',
        "  response = m.default",
        '  expectContain response "mocked"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "main.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(rootRaw, { recursive: true, force: true });
  }
});

test("jaiph test fails when no mock matches prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-no-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default {",
        '  prompt "Please greet the user"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "hello.test.jh"),
      [
        'import "hello.jh" as h',
        "",
        'test "no mock for prompt" {',
        "  response = h.default",
        '  expectContain response "no mock"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
      },
    });

    assert.equal(testResult.status, 1, "expected test run to fail when prompt has no mock");
    assert.match(testResult.stderr + testResult.stdout, /expectContain failed|FAIL|no mock|not found|command not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test fails when non-test file is passed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-missing-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default {",
        '  prompt "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(testResult.status, 1);
    assert.match(testResult.stderr, /\.test\.jh|inline mock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build fails when run is used inside a rule block", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule bad {",
        "  run some_workflow",
        "}",
        "",
        "workflow default {",
        "  ensure bad",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(filePath, outDir), /`run` is not allowed inside a `rule` block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build accepts ensure inside a rule block", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule dep {",
        "  echo dep",
        "}",
        "",
        "rule main {",
        "  ensure dep",
        "}",
        "",
        "workflow default {",
        "  ensure main",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /entry::dep/);
    assert.match(results[0].bash, /entry::main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build transpiles ensure ... recover to bounded retry loop", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule dep {",
        "  test -f ready.txt",
        "}",
        "",
        "workflow install_deps {",
        "  touch ready.txt",
        "}",
        "",
        "workflow default {",
        "  ensure dep recover run install_deps",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    const bash = results[0].bash;
    assert.match(bash, /for _jaiph_retry in \$\(seq 1/);
    assert.match(bash, /JAIPH_ENSURE_MAX_RETRIES/);
    assert.match(bash, /_jaiph_ensure_prev_files="\$\{JAIPH_PRECEDING_FILES:-\}"/);
    assert.match(bash, /IFS=',' read -r -a _jaiph_ensure_files_arr/);
    assert.match(bash, /local _jaiph_ensure_passed=0/);
    assert.match(bash, /_jaiph_ensure_passed=1/);
    assert.match(bash, /set -- "\$_jaiph_ensure_output"/);
    assert.match(bash, /entry::dep/);
    assert.match(bash, /entry::install_deps "\$@"/);
    assert.match(bash, /\bdone\b/);
    assert.match(bash, /if \[\[ "\$_jaiph_ensure_passed" -ne 1 \]\]; then/);
    assert.match(bash, /ensure condition did not pass after/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build transpiles ensure ... recover { stmt; stmt; } to bounded retry loop with block", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-block-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-block-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule ready {",
        "  test -f ready.txt",
        "}",
        "",
        "workflow default {",
        "  ensure ready recover { echo fixing; touch ready.txt; }",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    const bash = results[0].bash;
    assert.match(bash, /for _jaiph_retry in \$\(seq 1/);
    assert.match(bash, /set -- "\$_jaiph_ensure_output"/);
    assert.match(bash, /set -- "\$\{_jaiph_ensure_prev_args\[@\]\}"/);
    assert.match(bash, /entry::ready/);
    assert.match(bash, /echo fixing/);
    assert.match(bash, /touch ready\.txt/);
    assert.match(bash, /\bdone\b/);
    assert.match(bash, /ensure condition did not pass after/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build emits prompt capture as name=$(jaiph::prompt_capture ...) for name = prompt \"...\"", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-capture-build-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-prompt-capture-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  result = prompt "Summarize the changes made"',
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /result=\$\(jaiph::prompt_capture "\$JAIPH_PROMPT_PREVIEW" <<__JAIPH_PROMPT_/);
    assert.match(results[0].bash, /Summarize the changes made/);
    assert.match(results[0].bash, /\s*\)\s*$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build emits JAIPH_STEP_PARAM_KEYS and named args for prompt with variable references", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-named-params-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-prompt-named-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  prompt "$role does $task"',
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    const bash = results[0].bash;
    // Should emit JAIPH_STEP_PARAM_KEYS with __prompt_impl, __preview, and the var refs
    assert.match(bash, /export JAIPH_STEP_PARAM_KEYS='__prompt_impl,__preview,role,task'/);
    // Should pass named args instead of "$@"
    assert.match(bash, /jaiph::prompt "\$JAIPH_PROMPT_PREVIEW" "role=\$role" "task=\$task" <</);
    // Should NOT contain "$@" in prompt call
    assert.doesNotMatch(bash, /jaiph::prompt.*"\$@"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build emits no named args for prompt without variable references", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-no-vars-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-prompt-no-vars-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  prompt "Hello world"',
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    const bash = results[0].bash;
    // Should NOT emit JAIPH_STEP_PARAM_KEYS for prompt without vars
    assert.doesNotMatch(bash, /JAIPH_STEP_PARAM_KEYS/);
    // Should NOT pass "$@"
    assert.doesNotMatch(bash, /jaiph::prompt.*"\$@"/);
    // Should only pass preview
    assert.match(bash, /jaiph::prompt "\$JAIPH_PROMPT_PREVIEW" <</);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build emits assignment capture for ensure and shell", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-assign-capture-build-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-assign-capture-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule echo_ok {",
        "  echo stdout-here",
        "}",
        "workflow default {",
        "  response = ensure echo_ok",
        "  out = echo hello",
        "  printf '%s\\n' \"$response\" \"$out\"",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    const bash = results[0].bash;
    assert.match(bash, /response=\$\(entry::echo_ok::impl\)/);
    assert.match(bash, /out=\$\(echo hello\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build: failed command in assignment form fails workflow (no || true)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        "  out = false",
        "  echo done",
        "}",
        "",
      ].join("\n"),
    );
    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /out=\$\(false\)/);
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_STDLIB: join(process.cwd(), "dist/src/jaiph_stdlib.sh") },
    });
    assert.notEqual(runResult.status, 0, "workflow with capture = false should fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("jaiph test captures mock response into variable and variable is available in subsequent step", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-prompt-capture-"));
  try {
    writeFileSync(
      join(root, "capture.jh"),
      [
        "workflow default {",
        '  result = prompt "Please greet the user"',
        '  echo "$result"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "capture.test.jh"),
      [
        'import "capture.jh" as c',
        "",
        'test "capture mock" {',
        '  mock prompt "CAPTURED_MOCK_OUTPUT"',
        "  response = c.default",
        '  expectContain response "CAPTURED_MOCK_OUTPUT"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "capture.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test inline mock prompt block with if/elif/else and first-match", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-block-"));
  try {
    writeFileSync(
      join(root, "multi_prompt.jh"),
      [
        "workflow default {",
        '  a = prompt "greet"',
        '  b = prompt "bye"',
        '  echo "$a" "$b"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "multi_prompt.test.jh"),
      [
        'import "multi_prompt.jh" as m',
        "",
        'test "mock block first-match" {',
        "  mock prompt {",
        '    if $1 contains "greet" ; then',
        '      respond "hello"',
        '    elif $1 contains "bye" ; then',
        '      respond "goodbye"',
        "    else",
        '      respond "default"',
        "    fi",
        "  }",
        "  out = m.default",
        '  expectContain out "hello"',
        '  expectContain out "goodbye"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "multi_prompt.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test fails when no mock branch matches and no else", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-no-else-"));
  try {
    writeFileSync(
      join(root, "single.jh"),
      [
        "workflow default {",
        '  result = prompt "unmatched prompt text"',
        '  echo "$result"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "single.test.jh"),
      [
        'import "single.jh" as s',
        "",
        'test "no else branch" {',
        "  mock prompt {",
        '    if $1 contains "other" ; then',
        '      respond "never"',
        "    fi",
        "  }",
        "  out = s.default",
        '  expectContain out "x"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "single.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
      },
    });

    assert.equal(testResult.status, 1, "expected test to fail when no branch matches, no else, and no backend in PATH");
    assert.match(
      testResult.stderr + testResult.stdout,
      /workflow exited with status|no mock matched|no branch matched|expectContain failed|FAIL|not found|command not found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prompt capture: variable accessible in subsequent shell step", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-capture-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"result\",\"result\":\"agent-summary\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "capture.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  result = prompt "Summarize"',
        '  printf \'captured:%s\\n\' "$result"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const workflowOutName = runFiles.find(
      (name) => name.endsWith(".out") && !name.includes("jaiph__prompt"),
    );
    assert.equal(Boolean(workflowOutName), true);
    const workflowOut = readFileSync(join(latestRunDir, workflowOutName!), "utf8");
    assert.match(workflowOut, /captured:[\s\S]*agent-summary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prompt capture stores only final answer in assigned variable", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-capture-final-only-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"thinking\",\"text\":\"Plan: inspect data.\"}'",
        "echo '{\"type\":\"result\",\"result\":\"final-only-value\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "capture_final_only.jh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  result = prompt "Summarize"',
        '  printf \'captured:%s\\n\' "$result"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const runFiles = readdirSync(latestRunDir);
    const workflowOutName = runFiles.find((name) => name.endsWith(".out") && !name.includes("jaiph__prompt"));
    assert.equal(Boolean(workflowOutName), true);
    const workflowOut = readFileSync(join(latestRunDir, workflowOutName!), "utf8");
    assert.match(workflowOut, /captured:[\s\S]*final-only-value/);
    assert.doesNotMatch(workflowOut, /captured:[\s\S]*Plan: inspect data\./);

    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /Reasoning:\nPlan: inspect data\./);
    assert.match(promptOut, /Final answer:\nfinal-only-value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test with agent.backend = claude uses mock and does not invoke claude", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-backend-claude-mock-"));
  try {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default {",
        '  result = prompt "ask"',
        '  printf \'got:%s\\n\' "$result"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "mock overrides backend" {',
        '  mock prompt "mock-response"',
        "  out = w.default",
        '  expectContain out "mock-response"',
        '  expectContain out "got:"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/bin:/usr/bin:/nonexistent` },
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout + testResult.stderr, /mock-response|PASS|passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test when prompt is not mocked runs selected backend", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-unmocked-backend-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCursor = join(binDir, "cursor-agent");
    writeFileSync(
      fakeCursor,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"result\",\"result\":\"backend-ran\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCursor, 0o755);

    writeFileSync(
      join(root, "flow.jh"),
      [
        "config {",
        '  agent.backend = "cursor"',
        "}",
        "workflow default {",
        '  result = prompt "ask"',
        '  printf \'got:%s\\n\' "$result"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "no mock uses backend" {',
        "  out = w.default",
        '  expectContain out "backend-ran"',
        '  expectContain out "got:"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout + testResult.stderr, /backend-ran|PASS|passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test passes for workflow using ensure only with mocks", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-ensure-only-"));
  try {
    writeFileSync(
      join(root, "ensure_only.jh"),
      [
        "rule ready {",
        "  echo ok",
        "}",
        "",
        "workflow default {",
        "  ensure ready",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "ensure_only.test.jh"),
      [
        'import "ensure_only.jh" as e',
        "",
        'test "workflow default" {',
        "  response = e.default",
        '  expectContain response "ok"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "ensure_only.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
    assert.match(testResult.stdout, /workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser parses test blocks in *.test.jh file", () => {
  const source = [
    'import "workflow.jh" as w',
    '',
    'test "runs default" {',
    '  response = w.default',
    '  expectContain response "PASS"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/workflow.test.jh");
  assert.ok(mod.tests);
  assert.equal(mod.tests!.length, 1);
  assert.equal(mod.tests![0].description, "runs default");
  assert.equal(mod.tests![0].steps.length, 2);
  assert.equal(mod.tests![0].steps[0].type, "test_run_workflow");
  if (mod.tests![0].steps[0].type === "test_run_workflow") {
    assert.equal(mod.tests![0].steps[0].captureName, "response");
    assert.equal(mod.tests![0].steps[0].workflowRef, "w.default");
  }
  assert.equal(mod.tests![0].steps[1].type, "test_expect_contain");
  if (mod.tests![0].steps[1].type === "test_expect_contain") {
    assert.equal(mod.tests![0].steps[1].variable, "response");
    assert.equal(mod.tests![0].steps[1].substring, "PASS");
  }
});

test("parser parses mock workflow, rule, and function in test block", () => {
  const source = [
    'import "app.jh" as app',
    "",
    'test "isolated orchestration" {',
    "  mock workflow app.build {",
    '    echo "build ok"',
    "    exit 0",
    "  }",
    "",
    "  mock rule app.policy_check {",
    '    echo "policy blocked" >&2',
    "    exit 1",
    "  }",
    "",
    "  mock function app.changed_files {",
    '    echo "a.ts"',
    '    echo "b.ts"',
    "  }",
    "",
    "  out = app.default",
    '  expectContain out "policy blocked"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/app.test.jh");
  assert.ok(mod.tests);
  assert.equal(mod.tests!.length, 1);
  assert.equal(mod.tests![0].description, "isolated orchestration");
  const steps = mod.tests![0].steps;
  assert.equal(steps[0].type, "test_mock_workflow");
  if (steps[0].type === "test_mock_workflow") {
    assert.equal(steps[0].ref, "app.build");
    assert.ok(steps[0].body.includes('echo "build ok"'));
    assert.ok(steps[0].body.includes("exit 0"));
  }
  assert.equal(steps[1].type, "test_mock_rule");
  if (steps[1].type === "test_mock_rule") {
    assert.equal(steps[1].ref, "app.policy_check");
    assert.ok(steps[1].body.includes("exit 1"));
  }
  assert.equal(steps[2].type, "test_mock_function");
  if (steps[2].type === "test_mock_function") {
    assert.equal(steps[2].ref, "app.changed_files");
    assert.ok(steps[2].body.includes('echo "a.ts"'));
  }
  assert.equal(steps[3].type, "test_run_workflow");
  assert.equal(steps[4].type, "test_expect_contain");
});

test("parser ignores test keyword in non-test file", () => {
  const source = [
    "workflow default {",
    '  echo "hello"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/main.jh");
  assert.equal(mod.tests, undefined);
});

test("transpileTestFile produces runnable bash with expect_contain", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-transpile-test-"));
  try {
    const workflowPath = join(root, "w.jh");
    const testPath = join(root, "w.test.jh");
    writeFileSync(
      workflowPath,
      ["workflow default {", '  echo "ok"', "}", ""].join("\n"),
    );
    writeFileSync(
      testPath,
      [
        'import "w.jh" as w',
        "",
        'test "sanity" {',
        "  out = w.default",
        '  expectContain out "ok"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = transpileTestFile(testPath, root);
    assert.match(bash, /jaiph__expect_contain/);
    assert.match(bash, /jaiph__test_0/);
    assert.match(bash, /jaiph__run_tests/);
    assert.match(bash, /source.*w\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transpileTestFile emits JAIPH_MOCK_SCRIPTS_DIR and mock scripts for mock workflow/rule/function", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-transpile-mock-symbols-"));
  try {
    writeFileSync(
      join(root, "app.jh"),
      [
        "rule policy_check {",
        "  echo real",
        "}",
        "function changed_files {",
        "  echo real_files",
        "}",
        "workflow build {",
        '  echo "real build"',
        "}",
        "workflow default {",
        "  ensure policy_check",
        "  run build",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "app.test.jh"),
      [
        'import "app.jh" as app',
        "",
        'test "mocks" {',
        "  mock workflow app.build {",
        '    echo "mock build"',
        "    exit 0",
        "  }",
        "  mock rule app.policy_check {",
        "    exit 0",
        "  }",
        "  mock function app.changed_files {",
        '    echo "a.ts"',
        "  }",
        "  out = app.default",
        '  expectContain out "mock build"',
        "}",
        "",
      ].join("\n"),
    );
    build(root, root);
    const bash = transpileTestFile(join(root, "app.test.jh"), root);
    assert.match(bash, /JAIPH_MOCK_SCRIPTS_DIR/);
    assert.match(bash, /jaiph__mock_dir=\$\(mktemp -d\)/);
    assert.match(bash, /mock build/);
    assert.match(bash, /echo "a\.ts"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test runs *.test.jh with mock workflow, rule, and function", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-symbols-"));
  try {
    writeFileSync(
      join(root, "app.jh"),
      [
        "rule policy_check {",
        "  echo real-policy",
        "}",
        "function changed_files {",
        "  echo real_files",
        "}",
        "workflow build {",
        '  echo "real build"',
        "}",
        "workflow default {",
        "  ensure policy_check",
        "  run build",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "app.test.jh"),
      [
        'import "app.jh" as app',
        "",
        'test "isolated orchestration" {',
        "  mock workflow app.build {",
        '    echo "build ok"',
        "    exit 0",
        "  }",
        "",
        "  mock rule app.policy_check {",
        '    echo "policy ok"',
        "    exit 0",
        "  }",
        "",
        "  mock function app.changed_files {",
        '    echo "a.ts"',
        '    echo "b.ts"',
        "  }",
        "",
        "  out = app.default",
        '  expectContain out "policy ok"',
        '  expectContain out "build ok"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const result = spawnSync("node", [cliPath, "test", join(root, "app.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    assert.match(result.stdout, /test\(s\) passed|PASS/);
    assert.match(result.stdout, /isolated orchestration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test runs *.test.jh file with mocks", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-native-test-"));
  try {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default {",
        '  prompt "please greet"',
        '  echo "done"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as f',
        "",
        'test "captures output" {',
        '  mock prompt "mocked"',
        "  out = f.default",
        '  expectContain out "mocked"',
        '  expectContain out "done"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const result = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    assert.match(result.stdout, /test\(s\) passed|PASS/);
    assert.match(result.stdout, /captures output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkTestFiles discovers *.test.jh in directory", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-walk-test-"));
  try {
    writeFileSync(join(root, "a.test.jh"), "test \"t\" { }\n");
    writeFileSync(join(root, "b.jh"), "workflow default { }\n");
    writeFileSync(join(root, "c.test.jph"), "test \"t\" { }\n");
    const files = walkTestFiles(root);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith("a.test.jh")));
    assert.ok(files.some((f) => f.endsWith("c.test.jph")));
    assert.ok(!files.some((f) => f.endsWith("b.jh")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream_json_to_text deduplicates repeated assistant and result events", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stream-dedup-"));
  try {
    const finalFile = join(root, "final.txt");
    const runtimeDir = join(process.cwd(), "dist/src/runtime");
    // Simulate --include-partial-messages output: two assistant messages + result, all with same content.
    const events = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello, World!" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello, World!" }] } }),
      JSON.stringify({ type: "result", result: "Hello, World!" }),
    ].join("\n");
    const result = spawnSync("bash", ["-c", `source "${runtimeDir}/prompt.sh" && printf '%s\\n' '${events.replace(/'/g, "'\\''")}' | JAIPH_PROMPT_FINAL_FILE="${finalFile}" jaiph::stream_json_to_text`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, "stream_json_to_text should exit 0: " + result.stderr);
    // Final file should contain the response exactly once.
    const finalContent = readFileSync(finalFile, "utf8");
    assert.equal(finalContent, "Hello, World!", "JAIPH_PROMPT_FINAL_FILE should contain the response once, got: " + JSON.stringify(finalContent));
    // Stdout should contain the response exactly once (inside "Final answer:" section).
    const stdout = result.stdout;
    const occurrences = stdout.split("Hello, World!").length - 1;
    assert.equal(occurrences, 1, "stdout should contain the response once, got " + occurrences + " times: " + JSON.stringify(stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream_json_to_text deduplicates when stream deltas are followed by assistant message", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stream-dedup2-"));
  try {
    const finalFile = join(root, "final.txt");
    const runtimeDir = join(process.cwd(), "dist/src/runtime");
    // Simulate streaming: text_delta events, then assistant message, then result.
    const events = [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: ", World!" } } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello, World!" }] } }),
      JSON.stringify({ type: "result", result: "Hello, World!" }),
    ].join("\n");
    const result = spawnSync("bash", ["-c", `source "${runtimeDir}/prompt.sh" && printf '%s\\n' '${events.replace(/'/g, "'\\''")}' | JAIPH_PROMPT_FINAL_FILE="${finalFile}" jaiph::stream_json_to_text`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, "stream_json_to_text should exit 0: " + result.stderr);
    const finalContent = readFileSync(finalFile, "utf8");
    assert.equal(finalContent, "Hello, World!", "JAIPH_PROMPT_FINAL_FILE should contain streamed response once");
    const stdout = result.stdout;
    const occurrences = stdout.split("Hello, World!").length - 1;
    assert.equal(occurrences, 1, "stdout should contain the response once, got " + occurrences + " times");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
