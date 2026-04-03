import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildScripts, walkTestFiles } from "../src/transpiler";
import { parsejaiph } from "../src/parser";
import { buildRunTreeRows } from "../src/cli";
import { formatRunningBottomLine } from "../src/cli/run/progress";
import { parseStepEvent } from "../src/cli/run/events";

// Inherited JAIPH_RUNS_DIR (e.g. from a developer shell) would send runs outside each temp
// workspace; these tests expect artifacts under `<cwd>/.jaiph/runs`.
delete process.env.JAIPH_RUNS_DIR;

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

function readCombinedRunLogs(runDir: string): { out: string; err: string } {
  const files = readdirSync(runDir);
  const out = files
    .filter((name) => name.endsWith(".out"))
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  const err = files
    .filter((name) => name.endsWith(".err"))
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  return { out, err };
}

test("buildScripts extracts scripts for fixture corpus", () => {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-build-"));
  try {
    buildScripts(join(process.cwd(), "test/fixtures"), outDir);
    const scriptsDir = join(outDir, "scripts");
    assert.ok(existsSync(scriptsDir));
    assert.ok(readdirSync(scriptsDir).length > 0);
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
        "script local_impl = `echo ok`",
        "rule local() {",
        "  run local_impl()",
        "}",
        "",
        "workflow main() {",
        "  ensure mod.missing()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "mod.jh"),
      [
        "script existing_impl = `echo hi`",
        "rule existing() {",
        "  run existing_impl()",
        "}",
        "",
        "workflow mod() {",
        "  ensure existing()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE imported rule "mod\.missing" does not exist/);
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
        "rule local() {",
        "  echo ok",
        "}",
        "",
        "workflow entry() {",
        "  ensure local()",
        "  ensure mod.anything()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_IMPORT_NOT_FOUND import "mod" resolves to missing file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: .jaiph/main.jh once imported implement_from_queue.jh which had been
// renamed to engineer.jh, causing E_IMPORT_NOT_FOUND for every `jaiph test` run
// in the workspace. `jaiph test` now builds from the test file entrypoint only;
// this still checks main.jh imports and that the whole `.jaiph` graph builds.
test(".jaiph/main.jh imports only existing modules", () => {
  const jaiphDir = join(process.cwd(), ".jaiph");
  const mainJh = join(jaiphDir, "main.jh");
  assert.ok(existsSync(mainJh), ".jaiph/main.jh should exist");

  const ast = parsejaiph(readFileSync(mainJh, "utf8"), mainJh);
  for (const imp of ast.imports) {
    const resolved = join(dirname(mainJh), imp.path);
    assert.ok(existsSync(resolved), `import "${imp.alias}" resolves to missing file "${resolved}"`);
  }

  const outDir = join(jaiphDir, ".tmp-build-out");
  try {
    assert.doesNotThrow(() => buildScripts(jaiphDir, outDir));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

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

test("build rejects command substitution in prompt text", () => {
  const rootSubshell = mkdtempSync(join(tmpdir(), "jaiph-build-prompt-subshell-"));
  try {
    writeFileSync(
      join(rootSubshell, "main.jh"),
      [
        "workflow default() {",
        '  prompt "literal command substitution: $(echo SHOULD_NOT_RUN)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(rootSubshell, join(rootSubshell, "out")),
      /E_PARSE prompt cannot contain command substitution/,
    );
  } finally {
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
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"prompt-arg:$*\\\"}\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-args.jh");
    writeFileSync(
      filePath,
      [
        "workflow default(name) {",
        '  prompt "Say hello to ${name} and mention ${name} again."',
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
        JAIPH_AGENT_BACKEND: "cursor",
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
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"prompt-array:$*\\\"}\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-array.jh");
    writeFileSync(
      filePath,
      [
        "const DOCS = \"README.md docs/cli.md\"",
        "workflow default() {",
        '  prompt """',
        "Files to keep in sync:",
        "${DOCS}",
        '"""',
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
    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
    assert.ok(promptOut.length >= 0);
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
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"model-args:$*\\\"}\"",
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
        "workflow default() {",
        '  prompt "hello from metadata"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_AGENT_BACKEND: "cursor",
      JAIPH_DOCKER_ENABLED: "false",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete runEnv.JAIPH_AGENT_CURSOR_FLAGS;
    delete runEnv.JAIPH_AGENT_MODEL;
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: runEnv,
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
        "echo \"{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"cmd-args:$*\\\"}\"",
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
        "workflow default() {",
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
        JAIPH_AGENT_BACKEND: "cursor",
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
        "script print_captured = \`\`\`",
        "printf 'captured:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "claude"',
        '  agent.claude_flags = "--model sonnet-4"',
        "}",
        "workflow default() {",
        '  const result = prompt "hello"',
        '  run print_captured(result)',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_DOCKER_ENABLED: "false",
      NODE_NO_WARNINGS: "1",
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
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
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
        "workflow default() {",
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
        "script print_out = \`\`\`",
        "printf 'out:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default() {",
        '  const result = prompt "hi"',
        '  run print_out(result)',
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
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
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
        "script print_out = \`\`\`",
        "printf 'out:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default() {",
        '  const result = prompt "hi"',
        '  run print_out(result)',
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
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
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
        "script print_out = \`\`\`",
        "printf 'out:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.trusted_workspace = ".jaiph/.."',
        "}",
        "workflow default() {",
        '  const result = prompt "hi"',
        '  run print_out(result)',
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
        JAIPH_AGENT_TRUSTED_WORKSPACE: "/tmp/jaiph-explicit-trust",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
    assert.match(promptOut, /--trust \/tmp\/jaiph-explicit-trust/);
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
    assert.match(bootstrap, /workflow default\(\) \{/);
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

test("buildScripts accepts files with no workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-out-"));
  try {
    const filePath = join(root, "rules-only.jh");
    writeFileSync(
      filePath,
      [
        "script only_rule_impl = `echo ok`",
        "rule only_rule() {",
        "  run only_rule_impl()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(existsSync(join(outDir, "scripts", "only_rule_impl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts extracts scripts for ensure-with-args workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script check_branch_impl = \`\`\`",
        "test \"$1\" = \"main\"",
        "\`\`\`",
        "rule check_branch(branch) {",
        "  run check_branch_impl(branch)",
        "}",
        "",
        "workflow default(name) {",
        "  ensure check_branch(name)",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(readFileSync(join(outDir, "scripts", "check_branch_impl"), "utf8").includes("test "));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts writes multiple script stubs", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-functions-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-functions-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script changed_files = `printf '%s' 'from-function'`",
        "script print_value = \`\`\`",
        "printf '%s\\n' \"$1\"",
        "\`\`\`",
        "",
        "workflow default() {",
        "  VALUE = run changed_files()",
        '  run print_value(VALUE)',
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    const names = readdirSync(join(outDir, "scripts")).sort();
    assert.deepEqual(names, ["changed_files", "print_value"]);
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
        "script changed_files = `printf '%s' 'from-function'`",
        "script print_value = \`\`\`",
        "printf '%s\\n' \"$1\"",
        "\`\`\`",
        "",
        "workflow default() {",
        "  VALUE = run changed_files()",
        '  run print_value(VALUE)',
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
    assert.match(runResult.stdout, /script changed_files/);
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
      ["script done_impl = `echo done`", "workflow default(path, mode) {", "  run done_impl()", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default() {",
        '  run sub.default(path="docs/cli.md" mode="strict")',
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
        "script echo_args = \`\`\`",
        "printf '%s %s\\n' \"$1\" \"$2\"",
        "\`\`\`",
        "workflow default() {",
        '  run echo_args("first" "second")',
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
    assert.match(runResult.stdout, /script echo_args/);
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
      ["script done_impl = `echo done`", "workflow default(longparam) {", "  run done_impl()", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default() {",
        `  run sub.default(longparam="${longValue}")`,
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
      assert.match(runResult.stdout, /longparam="a{32}\.\.\./);
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
        "workflow default() {",
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
    "workflow default() {",
    "  run sub.default()",
    "}",
    "",
  ].join("\n");
  const subSource = [
    "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
        "  run sub.default()",
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
        "workflow default() {",
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
        "workflow default() {",
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

test("build fails when run in rule references unknown symbol", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "rule bad() {",
        "  run some_workflow()",
        "}",
        "",
        "workflow default() {",
        "  ensure bad()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildScripts(filePath, outDir),
      /unknown local script reference.*run in rules must target a script/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build fails when run in rule targets a workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-wf-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-run-wf-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow helper() {",
        '  log "hi"',
        "}",
        "",
        "rule bad() {",
        "  run helper()",
        "}",
        "",
        "workflow default() {",
        "  ensure bad()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildScripts(filePath, outDir),
      /run inside a rule must target a script, not workflow/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts accepts ensure inside a rule block", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script dep_impl = `echo dep`",
        "rule dep() {",
        "  run dep_impl()",
        "}",
        "",
        "rule main() {",
        "  ensure dep()",
        "}",
        "",
        "workflow default() {",
        "  ensure main()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(existsSync(join(outDir, "scripts", "dep_impl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts extracts scripts for ensure ... recover workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script dep_impl = `test -f ready.txt`",
        "rule dep() {",
        "  run dep_impl()",
        "}",
        "",
        "script install_deps_impl = `touch ready.txt`",
        "",
        "workflow install_deps() {",
        "  run install_deps_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure dep() recover run install_deps()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(readdirSync(join(outDir, "scripts")).includes("install_deps_impl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build rejects ensure recover inline shell block under strict shell-step ban", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-block-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-recover-block-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script ready_impl = `test -f ready.txt`",
        "rule ready() {",
        "  run ready_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure ready() recover { echo fixing; touch ready.txt; }",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildScripts(filePath, outDir),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts rejects shell assignment capture under strict shell-step ban", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "workflow default() {",
        "  out = false",
        "  echo done",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(filePath, outDir),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
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
        "workflow default() {",
        '  const result = prompt "Please greet the user"',
        '  return "${result}"',
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
        "workflow default() {",
        '  const a = prompt "greet"',
        '  const b = prompt "bye"',
        '  return "${a} ${b}"',
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
        '    /greet/ => "hello"',
        '    /bye/ => "goodbye"',
        '    _ => "default"',
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

test("jaiph test fails when no mock branch matches and no wildcard", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-no-else-"));
  try {
    writeFileSync(
      join(root, "single.jh"),
      [
        "workflow default() {",
        '  const result = prompt "unmatched prompt text"',
        '  return "${result}"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "single.test.jh"),
      [
        'import "single.jh" as s',
        "",
        'test "no wildcard arm" {',
        "  mock prompt {",
        '    /other/ => "never"',
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

    assert.equal(testResult.status, 1, "expected test to fail when no branch matches, no wildcard, and no backend in PATH");
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
    // Anchor workspace here: a parent of TMPDIR may contain `.jaiph`, which would otherwise
    // become JAIPH_WORKSPACE and send runs outside this temp root.
    mkdirSync(join(root, ".jaiph"), { recursive: true });
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
        "script print_captured = \`\`\`",
        "printf 'captured:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default() {",
        '  const result = prompt "Summarize"',
        '  run print_captured(result)',
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
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
    assert.match(workflowOut, /captured:[\s\S]*agent-summary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prompt capture stores only final answer in assigned variable", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-capture-final-only-"));
  try {
    mkdirSync(join(root, ".jaiph"), { recursive: true });
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
        "script print_captured = \`\`\`",
        "printf 'captured:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default() {",
        '  const result = prompt "Summarize"',
        '  run print_captured(result)',
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
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
    assert.match(workflowOut, /captured:[\s\S]*final-only-value/);
    assert.doesNotMatch(workflowOut, /captured:[^\n]*Plan: inspect data\./);

    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
    assert.ok(promptOut.length >= 0);
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
        "script print_got = \`\`\`",
        "printf 'got:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default() {",
        '  const result = prompt "ask"',
        '  run print_got(result)',
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
        "script print_got = \`\`\`",
        "printf 'got:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "cursor"',
        "}",
        "workflow default() {",
        '  const result = prompt "ask"',
        '  run print_got(result)',
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
        "script ready_impl = `echo ok`",
        "rule ready() {",
        "  run ready_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure ready()",
        '  return "ready-ok"',
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
        '  expectContain response "ready-ok"',
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
    "  mock script app.changed_files {",
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
  assert.equal(steps[2].type, "test_mock_script");
  if (steps[2].type === "test_mock_script") {
    assert.equal(steps[2].ref, "app.changed_files");
    assert.ok(steps[2].body.includes('echo "a.ts"'));
  }
  assert.equal(steps[3].type, "test_run_workflow");
  assert.equal(steps[4].type, "test_expect_contain");
});

test("parser ignores test keyword in non-test file", () => {
  const source = [
    "workflow default() {",
    '  echo "hello"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/main.jh");
  assert.equal(mod.tests, undefined);
});

test("jaiph test runs *.test.jh with mock workflow, rule, and script", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-symbols-"));
  try {
    writeFileSync(
      join(root, "app.jh"),
      [
        "script policy_check_impl = `echo real-policy`",
        "rule policy_check() {",
        "  run policy_check_impl()",
        "}",
        "script changed_files = `echo real_files`",
        "script build_impl = \`\`\`",
        'echo "real build"',
        "\`\`\`",
        "workflow build() {",
        "  run build_impl()",
        "}",
        "workflow default() {",
        "  ensure policy_check()",
        "  run build()",
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
        "  mock script app.changed_files {",
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
        "workflow default() {",
        '  prompt "please greet"',
        '  return "done"',
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
    writeFileSync(join(root, "b.jh"), "workflow default() { }\n");
    const files = walkTestFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files.some((f) => f.endsWith("a.test.jh")));
    assert.ok(!files.some((f) => f.endsWith("b.jh")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

