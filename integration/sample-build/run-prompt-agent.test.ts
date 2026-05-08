import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { getLatestRunDir, readCombinedRunLogs } from "./helpers";

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
    const nodeOnlyBin = join(root, "node-only-bin");
    mkdirSync(nodeOnlyBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeOnlyBin, "node"));

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
      PATH: `${nodeOnlyBin}:/nonexistent`,
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
