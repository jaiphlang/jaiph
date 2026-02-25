import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "../src/transpiler";

test("build transpiles .jph into strict bash with retry flow", () => {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-build-"));
  try {
    const results = build(join(process.cwd(), "test/fixtures"), outDir);
    assert.equal(results.length, 3);

    const stdlib = readFileSync(join(process.cwd(), "src/jaiph_stdlib.sh"), "utf8");
    assert.match(stdlib, /jaiph__version\(\)/);
    assert.match(stdlib, /jaiph__runtime_api\(\)/);
    assert.match(stdlib, /jaiph__prompt\(\)/);
    assert.match(stdlib, /jaiph__prompt__impl\(\)/);
    assert.match(stdlib, /agent_command="\$\{JAIPH_AGENT_COMMAND:-cursor-agent\}"/);
    assert.match(
      stdlib,
      /--print --output-format stream-json --stream-partial-output --workspace "\$workspace_root" --model "\$JAIPH_AGENT_MODEL" --trust "\$prompt_text"/,
    );
    assert.match(stdlib, /jaiph__run_step jaiph__prompt jaiph__prompt__impl "\$@"/);
    assert.match(stdlib, /jaiph__execute_readonly\(\)/);
    assert.match(stdlib, /jaiph__run_step\(\)/);
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
    assert.match(generated, /main__rule_project_ready\(\) \{/);
    assert.match(generated, /main__rule_project_ready__impl\(\) \{/);
    assert.match(generated, /jaiph__run_step main__rule_project_ready jaiph__execute_readonly main__rule_project_ready__impl/);
    assert.match(generated, /if ! main__rule_project_ready; then/);
    assert.match(generated, /bootstrap_project__workflow_nodejs/);
    assert.match(generated, /jaiph__prompt "\$@" <<'__JAIPH_PROMPT_/);
    assert.match(generated, /main__rule_build_passes\(\)/);
    assert.match(generated, /tools__security__rule_scan_passes/);
    assert.match(generated, /main__workflow_update_docs/);
    assert.match(generated, /main__workflow_default__impl\(\) \{/);
    assert.match(generated, /jaiph__run_step main__workflow_default main__workflow_default__impl "\$@"/);

    const securityGenerated = readFileSync(join(outDir, "tools/security.sh"), "utf8");
    assert.match(securityGenerated, /tools__security__rule_scan_passes\(\) \{/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build validates imported rule references with deterministic errors", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-invalid-"));
  try {
    writeFileSync(
      join(root, "main.jph"),
      [
        'import "./mod.jph" as mod',
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
      join(root, "mod.jph"),
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
      join(root, "sub/entry.jph"),
      [
        'import "../missing/mod.jph" as mod',
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
    const filePath = join(root, "echo.jph");
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
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /✓ PASS workflow default \((?:\d+(?:\.\d+)?s|\d+m \d+s)\)/);
    assert.doesNotMatch(runResult.stdout, /hello-run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executable .jph invokes jaiph run semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-exec-jph-"));
  try {
    const filePath = join(root, "echo.jph");
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
    assert.doesNotMatch(runResult.stdout, /exec-arg:hello-exec/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run enables xtrace when JAIPH_DEBUG=true", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-debug-"));
  try {
    const filePath = join(root, "debug.jph");
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
      env: { ...process.env, JAIPH_DEBUG: "true" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /debug-run:hello-debug/);
    assert.match(runResult.stderr, /\+ .*__workflow_default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails when workflow default is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-missing-default-"));
  try {
    const filePath = join(root, "pr.jph");
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
    const filePath = join(root, "fail-fast.jph");
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
    const filePath = join(root, "runtime-stderr.jph");
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
        "jaiph__run_step() {",
        "  local _name=\"$1\"",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph__execute_readonly() {",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph__prompt() {",
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
      env: { ...process.env, JAIPH_STDLIB: stdlibPath },
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
    const filePath = join(root, "missing-arg.jph");
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

test("jaiph run prints rule tree and fail summary", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-fail-"));
  try {
    const filePath = join(root, "fail.jph");
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
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /└── rule current_branch/);
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

    const filePath = join(root, "prompt.jph");
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    assert.equal(existsSync(runsRoot), true);
    const runDirs = readdirSync(runsRoot);
    assert.equal(runDirs.length > 0, true);
    const sortedRunDirs = [...runDirs].sort();
    const latestRunDirName = sortedRunDirs[sortedRunDirs.length - 1];
    assert.match(latestRunDirName, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    const latestRunDir = join(runsRoot, latestRunDirName);
    const runFiles = readdirSync(latestRunDir);
    assert.equal(runFiles.includes("run_summary.jsonl"), true);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    const promptErrName = runFiles.find((name) => name.endsWith("-jaiph__prompt.err"));
    assert.equal(Boolean(promptOutName), true);
    assert.equal(Boolean(promptErrName), true);
    assert.match(promptOutName!, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    assert.match(promptErrName!, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    const promptErr = readFileSync(join(latestRunDir, promptErrName!), "utf8");
    assert.match(promptOut, /^Prompt:\nhello from prompt\n\n/);
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

test("jaiph run treats prompt text as literal (no shell interpolation)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-literal-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "printf 'arg:%s\\n' \"$1\"",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "prompt-literal.jph");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  prompt "',
        "literal backticks: `uname`",
        "literal command substitution: $(echo SHOULD_NOT_RUN)",
        "literal var: $HOME",
        'literal escaped quote: \\"quoted\\"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const runDirs = readdirSync(runsRoot).sort();
    const latestRunDir = join(runsRoot, runDirs[runDirs.length - 1]);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /Prompt:\n\nliteral backticks: `uname`/);
    assert.match(promptOut, /literal command substitution: \$\(echo SHOULD_NOT_RUN\)/);
    assert.match(promptOut, /literal var: \$HOME/);
    assert.match(promptOut, /literal escaped quote: "quoted"/);
    assert.doesNotMatch(promptOut, /literal command substitution: SHOULD_NOT_RUN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

    const filePath = join(root, "prompt-args.jph");
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const runDirs = readdirSync(runsRoot).sort();
    const latestRunDir = join(runsRoot, runDirs[runDirs.length - 1]);
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

test("jaiph run applies model from local TOML config", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-config-model-"));
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

    mkdirSync(join(root, ".jaiph"), { recursive: true });
    writeFileSync(
      join(root, ".jaiph/config.toml"),
      [
        "[agent]",
        'default_model = "auto"',
        "",
      ].join("\n"),
    );

    const filePath = join(root, "prompt.jph");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        '  prompt "hello from config"',
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
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const runDirs = readdirSync(runsRoot).sort();
    const latestRunDir = join(runsRoot, runDirs[runDirs.length - 1]);
    const runFiles = readdirSync(latestRunDir);
    const promptOutName = runFiles.find((name) => name.endsWith("-jaiph__prompt.out"));
    assert.equal(Boolean(promptOutName), true);
    const promptOut = readFileSync(join(latestRunDir, promptOutName!), "utf8");
    assert.match(promptOut, /model-args:.*--model auto/);
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
        "jaiph__run_step() {",
        "  local _name=\"$1\"",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph__execute_readonly() {",
        "  shift || true",
        "  \"$@\"",
        "}",
        "jaiph__prompt() {",
        "  :",
        "}",
        "",
      ].join("\n"),
    );
    chmodSync(stdlibPath, 0o755);

    const filePath = join(root, "echo.jph");
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
    const initResult = spawnSync("node", [cliPath, "init"], {
      encoding: "utf8",
      cwd: root,
    });

    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(existsSync(join(root, ".jaiph")), true);
    assert.equal(existsSync(join(root, ".jaiph/lib")), false);
    assert.equal(existsSync(join(root, ".jaiph/bootstrap.jph")), true);
    assert.equal(existsSync(join(root, ".jaiph/config.toml")), true);
    assert.equal(existsSync(join(root, ".jaiph/jaiph-skill.md")), true);
    const bootstrap = readFileSync(join(root, ".jaiph/bootstrap.jph"), "utf8");
    assert.match(bootstrap, /^#!\/usr\/bin\/env jaiph\n\n/);
    assert.match(bootstrap, /workflow default \{/);
    assert.match(bootstrap, /\.jaiph\/jaiph-skill\.md/);
    assert.match(bootstrap, /Analyze repository structure/);
    assert.match(bootstrap, /Create or update Jaiph workflows under \.jaiph\//);
    assert.doesNotMatch(bootstrap, /\$1/);
    assert.equal(statSync(join(root, ".jaiph/bootstrap.jph")).mode & 0o777, 0o755);
    const localConfig = readFileSync(join(root, ".jaiph/config.toml"), "utf8");
    assert.match(localConfig, /\[agent\]/);
    assert.match(localConfig, /default_model = "auto"/);
    assert.match(localConfig, /\[run\]/);
    assert.match(localConfig, /logs_dir = "\.jaiph\/runs"/);
    const localSkill = readFileSync(join(root, ".jaiph/jaiph-skill.md"), "utf8");
    assert.match(localSkill, /Jaiph Bootstrap Skill/);
    assert.equal(existsSync(join(root, ".gitignore")), false);
    assert.match(initResult.stdout, /Jaiph init/);
    assert.match(initResult.stdout, /▸ Creating \.jaiph\/bootstrap\.jph/);
    assert.match(initResult.stdout, /✓ Initialized \.jaiph\/bootstrap\.jph/);
    assert.match(initResult.stdout, /✓ Initialized \.jaiph\/config\.toml/);
    assert.match(initResult.stdout, /Synced \.jaiph\/jaiph-skill\.md/);
    assert.match(initResult.stdout, /\.\/\.jaiph\/bootstrap\.jph/);
    assert.match(initResult.stdout, /analyze the project/i);
    assert.match(initResult.stdout, /add `\.jaiph\/runs\/` to `\.gitignore`/i);
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
    const filePath = join(root, "rules-only.jph");
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
    assert.match(results[0].bash, /rule_only_rule/);
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
    const filePath = join(root, "entry.jph");
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
      /jaiph__run_step entry__rule_check_branch jaiph__execute_readonly entry__rule_check_branch__impl "\$@"/,
    );
    assert.match(results[0].bash, /entry__rule_check_branch "\$1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build supports top-level functions with namespaced wrappers", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-functions-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-functions-out-"));
  try {
    const filePath = join(root, "entry.jph");
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
    assert.match(results[0].bash, /entry__function_changed_files__impl\(\) \{/);
    assert.match(results[0].bash, /entry__function_changed_files\(\) \{/);
    assert.match(results[0].bash, /jaiph__run_step entry__function_changed_files entry__function_changed_files__impl "\$@"/);
    assert.match(results[0].bash, /changed_files\(\) \{/);
    assert.match(results[0].bash, /entry__function_changed_files "\$@"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("jaiph run tree includes function calls from workflow shell steps", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-function-tree-"));
  try {
    const filePath = join(root, "entry.jph");
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
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /function changed_files/);
    assert.doesNotMatch(runResult.stdout, /from-function/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
