import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackendArgs, executePrompt, resolveConfig } from "./prompt";

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
