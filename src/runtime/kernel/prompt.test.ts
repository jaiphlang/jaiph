import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBackendArgs,
  executePrompt,
  parseEtimeToSeconds,
  prepareClaudeEnv,
  resolveConfig,
  selectTailToKill,
  type ProcNode,
} from "./prompt";

describe("resolveConfig", () => {
  it("uses defaults when env is empty", () => {
    const saved = { ...process.env };
    delete process.env.JAIPH_AGENT_BACKEND;
    delete process.env.JAIPH_AGENT_COMMAND;
    delete process.env.JAIPH_AGENT_MODEL;
    delete process.env.JAIPH_AGENT_CURSOR_FLAGS;
    delete process.env.JAIPH_AGENT_CLAUDE_FLAGS;
    delete process.env.JAIPH_PROMPT_FINAL_FILE;
    const config = resolveConfig();
    assert.equal(config.backend, "cursor");
    assert.equal(config.agentCommand, "cursor-agent");
    assert.equal(config.model, "");
    assert.deepEqual(config.cursorFlags, []);
    assert.deepEqual(config.claudeFlags, []);
    Object.assign(process.env, saved);
  });

  it("reads from env vars", () => {
    const saved = { ...process.env };
    process.env.JAIPH_AGENT_BACKEND = "claude";
    process.env.JAIPH_AGENT_COMMAND = "my-agent --flag";
    process.env.JAIPH_AGENT_MODEL = "test-model";
    process.env.JAIPH_AGENT_CURSOR_FLAGS = "--a --b";
    const config = resolveConfig();
    assert.equal(config.backend, "claude");
    assert.equal(config.agentCommand, "my-agent --flag");
    assert.equal(config.model, "test-model");
    assert.deepEqual(config.cursorFlags, ["--a", "--b"]);
    Object.assign(process.env, saved);
  });
});

describe("buildBackendArgs", () => {
  it("builds cursor args without model", () => {
    const config = {
      backend: "cursor",
      agentCommand: "cursor-agent",
      model: "",
      workspaceRoot: "/ws",
      trustedWorkspace: "/ws",
      cursorFlags: [] as string[],
      claudeFlags: [] as string[],
      promptFinalFile: "",
    };
    const { command, args } = buildBackendArgs(config, "test prompt");
    assert.equal(command, "cursor-agent");
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--workspace"));
    assert.ok(args.includes("/ws"));
    assert.ok(args.includes("test prompt"));
    assert.ok(!args.includes("--model"));
  });

  it("builds cursor args with model", () => {
    const config = {
      backend: "cursor",
      agentCommand: "cursor-agent",
      model: "gpt-4",
      workspaceRoot: "/ws",
      trustedWorkspace: "/ws",
      cursorFlags: [] as string[],
      claudeFlags: [] as string[],
      promptFinalFile: "",
    };
    const { args } = buildBackendArgs(config, "test");
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-4"));
  });

  it("builds claude args", () => {
    const config = {
      backend: "claude",
      agentCommand: "cursor-agent",
      model: "",
      workspaceRoot: "/ws",
      trustedWorkspace: "/ws",
      cursorFlags: [] as string[],
      claudeFlags: ["--max-tokens", "1000"] as string[],
      promptFinalFile: "",
    };
    const { command, args } = buildBackendArgs(config, "test");
    assert.equal(command, "claude");
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--max-tokens"));
  });
});

describe("executePrompt", () => {
  it("cursor backend trims surrounding blank lines from captured final", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-cursor-trim-"));
    try {
      const fakeAgent = join(root, "fake-cursor-agent");
      writeFileSync(
        fakeAgent,
        [
          "#!/usr/bin/env bash",
          "python3 - <<'PY'",
          "import json",
          "print(json.dumps({\"type\": \"result\", \"result\": \"\\n\\nhello-from-cursor\\n\\n\"}))",
          "PY",
          "",
        ].join("\n"),
      );
      chmodSync(fakeAgent, 0o755);
      const chunks: string[] = [];
      const stdout: NodeJS.WritableStream = {
        write: (chunk: unknown) => {
          chunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream;
      const result = await executePrompt(
        "ignored",
        {
          backend: "cursor",
          agentCommand: fakeAgent,
          model: "",
          workspaceRoot: root,
          trustedWorkspace: root,
          cursorFlags: [],
          claudeFlags: [],
          promptFinalFile: "",
        },
        stdout,
      );
      assert.equal(result.status, 0);
      assert.equal(result.final, "hello-from-cursor");
      assert.ok(chunks.join("").includes("Final answer:"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareClaudeEnv", () => {
  it("keeps existing env when configured claude dir is writable", () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-claude-env-ok-"));
    try {
      const cfg = join(root, ".claude");
      const prepared = prepareClaudeEnv({ HOME: root, CLAUDE_CONFIG_DIR: cfg }, root);
      assert.equal(prepared.error, undefined);
      assert.equal(prepared.warning, undefined);
      assert.equal(prepared.env.CLAUDE_CONFIG_DIR, cfg);
      assert.ok(existsSync(join(cfg, "session-env")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to workspace-local claude config when default is not writable", () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-claude-env-fallback-"));
    try {
      const blockedPath = join(root, "blocked-config-path");
      writeFileSync(blockedPath, "not-a-directory");
      const prepared = prepareClaudeEnv({ CLAUDE_CONFIG_DIR: blockedPath }, root);
      assert.equal(prepared.error, undefined);
      assert.ok(prepared.warning);
      assert.equal(prepared.env.CLAUDE_CONFIG_DIR, join(root, ".jaiph", "claude-config"));
      assert.ok(existsSync(join(root, ".jaiph", "claude-config", "session-env")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tail watchdog helpers", () => {
  it("parses ps etime values", () => {
    assert.equal(parseEtimeToSeconds("00:59"), 59);
    assert.equal(parseEtimeToSeconds("01:02:03"), 3723);
    assert.equal(parseEtimeToSeconds("2-00:00:01"), 172801);
  });

  it("selects deepest stale tail descendant only", () => {
    const nodes: ProcNode[] = [
      { pid: 100, ppid: 1, elapsedSeconds: 5, command: "/usr/bin/node" },
      { pid: 200, ppid: 100, elapsedSeconds: 50, command: "/bin/zsh" },
      { pid: 300, ppid: 200, elapsedSeconds: 601, command: "/usr/bin/tail" },
      { pid: 310, ppid: 200, elapsedSeconds: 999, command: "/usr/bin/tail" },
      { pid: 320, ppid: 300, elapsedSeconds: 700, command: "/usr/bin/tail" },
      { pid: 400, ppid: 1, elapsedSeconds: 700, command: "/usr/bin/tail" },
    ];
    const selected = selectTailToKill(nodes, 100, 600);
    assert.ok(selected);
    assert.equal(selected?.pid, 320);
  });
});
