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
  resolveModel,
  selectTailToKill,
  type ProcNode,
  type PromptConfig,
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

function makeConfig(overrides: Partial<PromptConfig> = {}): PromptConfig {
  return {
    backend: "cursor",
    agentCommand: "cursor-agent",
    model: "",
    workspaceRoot: "/ws",
    trustedWorkspace: "/ws",
    cursorFlags: [],
    claudeFlags: [],
    codexApiKey: "",
    codexApiUrl: "https://api.openai.com/v1/chat/completions",
    promptFinalFile: "",
    ...overrides,
  };
}

describe("buildBackendArgs", () => {
  it("builds cursor args without model", () => {
    const config = makeConfig();
    const { command, args } = buildBackendArgs(config, "test prompt");
    assert.equal(command, "cursor-agent");
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--workspace"));
    assert.ok(args.includes("/ws"));
    assert.ok(args.includes("test prompt"));
    assert.ok(!args.includes("--model"));
  });

  it("builds cursor args with model", () => {
    const config = makeConfig({ model: "gpt-4" });
    const { args } = buildBackendArgs(config, "test");
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-4"));
  });

  it("builds claude args", () => {
    const config = makeConfig({ backend: "claude", claudeFlags: ["--max-tokens", "1000"] });
    const { command, args } = buildBackendArgs(config, "test");
    assert.equal(command, "claude");
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--max-tokens"));
  });
});

describe("resolveModel", () => {
  it("returns explicit when model is set", () => {
    const res = resolveModel(makeConfig({ model: "gpt-4" }));
    assert.equal(res.model, "gpt-4");
    assert.equal(res.reason, "explicit");
  });

  it("extracts model from cursor flags when model is empty", () => {
    const res = resolveModel(makeConfig({ backend: "cursor", cursorFlags: ["--model", "gpt-3.5"] }));
    assert.equal(res.model, "gpt-3.5");
    assert.equal(res.reason, "flags");
  });

  it("extracts model from claude flags when model is empty", () => {
    const res = resolveModel(makeConfig({ backend: "claude", claudeFlags: ["--model", "sonnet-4"] }));
    assert.equal(res.model, "sonnet-4");
    assert.equal(res.reason, "flags");
  });

  it("returns backend-default when no model anywhere", () => {
    const res = resolveModel(makeConfig({ backend: "cursor" }));
    assert.equal(res.model, "");
    assert.equal(res.reason, "backend-default");
  });

  it("returns backend-default for claude with no model", () => {
    const res = resolveModel(makeConfig({ backend: "claude" }));
    assert.equal(res.model, "");
    assert.equal(res.reason, "backend-default");
  });

  it("prefers explicit model over flags model", () => {
    const res = resolveModel(makeConfig({ model: "explicit-model", cursorFlags: ["--model", "flags-model"] }));
    assert.equal(res.model, "explicit-model");
    assert.equal(res.reason, "explicit");
  });
});

describe("buildBackendArgs — claude model", () => {
  it("passes --model for claude when model is set and not in flags", () => {
    const { args } = buildBackendArgs(makeConfig({ backend: "claude", model: "sonnet-4" }), "test");
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1, "--model should be present");
    assert.equal(args[idx + 1], "sonnet-4");
  });

  it("does not duplicate --model for claude when already in flags", () => {
    const { args } = buildBackendArgs(
      makeConfig({ backend: "claude", model: "sonnet-4", claudeFlags: ["--model", "opus-4"] }),
      "test",
    );
    const indices = args.reduce<number[]>((acc, v, i) => (v === "--model" ? [...acc, i] : acc), []);
    assert.equal(indices.length, 1, "should have exactly one --model");
    assert.equal(args[indices[0] + 1], "opus-4", "flags value wins (appended last)");
  });

  it("omits --model for claude when model is empty", () => {
    const { args } = buildBackendArgs(makeConfig({ backend: "claude" }), "test");
    assert.ok(!args.includes("--model"));
  });
});

describe("executePrompt", () => {
  it("cursor backend trims surrounding blank lines from captured final", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-cursor-trim-"));
    try {
      const fakeAgent = join(root, "cursor-agent");
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
        makeConfig({ agentCommand: fakeAgent, workspaceRoot: root, trustedWorkspace: root }),
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

describe("codex backend", () => {
  it("resolveConfig reads OPENAI_API_KEY and JAIPH_CODEX_API_URL", () => {
    const config = resolveConfig({
      JAIPH_AGENT_BACKEND: "codex",
      OPENAI_API_KEY: "sk-test-key",
      JAIPH_CODEX_API_URL: "https://custom.api/v1/chat/completions",
    });
    assert.equal(config.backend, "codex");
    assert.equal(config.codexApiKey, "sk-test-key");
    assert.equal(config.codexApiUrl, "https://custom.api/v1/chat/completions");
  });

  it("resolveConfig uses default codex API URL when env not set", () => {
    const config = resolveConfig({
      JAIPH_AGENT_BACKEND: "codex",
      OPENAI_API_KEY: "sk-test",
    });
    assert.equal(config.codexApiUrl, "https://api.openai.com/v1/chat/completions");
  });

  it("buildBackendArgs returns codex-api command with model and url", () => {
    const config = makeConfig({ backend: "codex", model: "o3" });
    const { command, args } = buildBackendArgs(config, "test prompt");
    assert.equal(command, "codex-api");
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("o3"));
    assert.ok(args.includes("--url"));
  });

  it("buildBackendArgs uses default model gpt-4o when model is empty", () => {
    const config = makeConfig({ backend: "codex" });
    const { args } = buildBackendArgs(config, "test");
    assert.ok(args.includes("gpt-4o"));
  });

  it("resolveModel returns backend-default for codex without model", () => {
    const res = resolveModel(makeConfig({ backend: "codex" }));
    assert.equal(res.model, "");
    assert.equal(res.reason, "backend-default");
  });

  it("resolveModel returns explicit for codex with model", () => {
    const res = resolveModel(makeConfig({ backend: "codex", model: "o3" }));
    assert.equal(res.model, "o3");
    assert.equal(res.reason, "explicit");
  });

  it("executePrompt fails with actionable error when OPENAI_API_KEY is missing", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const stdout = { write: () => true } as unknown as NodeJS.WritableStream;
      const result = await executePrompt(
        "test prompt",
        makeConfig({ backend: "codex", codexApiKey: "" }),
        stdout,
      );
      assert.equal(result.status, 1);
      const errOutput = stderrChunks.join("");
      assert.ok(errOutput.includes("OPENAI_API_KEY"), "error should mention OPENAI_API_KEY");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("executePrompt succeeds with mock HTTP server", async () => {
    const http = require("node:http") as typeof import("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const chunks: string[] = [];
      const stdout = {
        write: (chunk: unknown) => { chunks.push(String(chunk)); return true; },
      } as unknown as NodeJS.WritableStream;
      const result = await executePrompt(
        "say hello",
        makeConfig({
          backend: "codex",
          codexApiKey: "sk-test",
          codexApiUrl: `http://localhost:${port}/v1/chat/completions`,
        }),
        stdout,
      );
      assert.equal(result.status, 0);
      assert.equal(result.final, "Hello world");
      const output = chunks.join("");
      assert.ok(output.includes("Final answer:"), "should write Final answer header");
      assert.ok(output.includes("Hello world"), "should contain streamed text");
    } finally {
      server.close();
    }
  });

  it("executePrompt returns error on HTTP failure", async () => {
    const http = require("node:http") as typeof import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const stdout = { write: () => true } as unknown as NodeJS.WritableStream;
      const result = await executePrompt(
        "test",
        makeConfig({
          backend: "codex",
          codexApiKey: "sk-bad",
          codexApiUrl: `http://localhost:${port}/v1/chat/completions`,
        }),
        stdout,
      );
      assert.equal(result.status, 1);
      const errOutput = stderrChunks.join("");
      assert.ok(errOutput.includes("401"), "error should include status code");
      assert.ok(errOutput.includes("Invalid API key"), "error should include API message");
    } finally {
      process.stderr.write = origWrite;
      server.close();
    }
  });
});
