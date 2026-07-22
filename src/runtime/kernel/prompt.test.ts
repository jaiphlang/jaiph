import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildBackendArgs,
  executePrompt,
  installPromptWatchdog,
  prepareClaudeEnv,
  resolveConfig,
  modelForStepEvent,
  BACKEND_DEFAULT_MODEL_LABEL,
  resolveModel,
  resolvePromptConfig,
  type PromptConfig,
} from "./prompt";
import { buildDockerArgs } from "../docker";

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

describe("resolvePromptConfig", () => {
  it("applies config model only when env model is unset", () => {
    const cfg = resolvePromptConfig({ JAIPH_AGENT_BACKEND: "claude" }, "workflow-model");
    assert.equal(cfg.model, "workflow-model");
  });

  it("env JAIPH_AGENT_MODEL wins over config model", () => {
    const cfg = resolvePromptConfig(
      { JAIPH_AGENT_BACKEND: "claude", JAIPH_AGENT_MODEL: "env-model" },
      "workflow-model",
    );
    assert.equal(cfg.model, "env-model");
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

describe("modelForStepEvent", () => {
  it("returns explicit and flags models unchanged", () => {
    assert.equal(modelForStepEvent({ model: "sonnet", reason: "explicit" }), "sonnet");
    assert.equal(modelForStepEvent({ model: "gpt-3.5", reason: "flags" }), "gpt-3.5");
  });

  it("returns default label when backend auto-selects", () => {
    assert.equal(
      modelForStepEvent({ model: "", reason: "backend-default" }),
      BACKEND_DEFAULT_MODEL_LABEL,
    );
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

  it("captures cursor stderr into the provided stderr writer on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-cursor-stderr-"));
    try {
      const fakeAgent = join(root, "cursor-agent");
      writeFileSync(
        fakeAgent,
        [
          "#!/usr/bin/env bash",
          'echo "Cannot use this model: gpt-5.4" >&2',
          "exit 1",
          "",
        ].join("\n"),
      );
      chmodSync(fakeAgent, 0o755);
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
      stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
      const result = await executePrompt(
        "ignored",
        makeConfig({
          agentCommand: fakeAgent,
          workspaceRoot: root,
          trustedWorkspace: root,
          model: "gpt-5.4",
        }),
        stdout,
        process.env,
        stderr,
      );
      assert.equal(result.status, 1);
      assert.match(stdoutChunks.join(""), /^Command:\n/);
      assert.match(stderrChunks.join(""), /Cannot use this model: gpt-5\.4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Minimal ChildProcess stand-in: an EventEmitter with a recording `kill`. */
const FAKE_CHILD_PID = 4242;
let origProcessKill: typeof process.kill | undefined;

// The watchdog terminates via killProcessTree(pid, signal) (portability.ts),
// which on POSIX calls process.kill(-pid|pid, signal). Spy on process.kill and
// record the signals aimed at the fake child's pid (either sign). Restored per
// test by the afterEach below so the spy never leaks into other suites.
function makeFakeChild(): { child: ChildProcess; killSignals: string[] } {
  const emitter = new EventEmitter() as EventEmitter & { pid: number; kill: (s?: string) => boolean };
  const killSignals: string[] = [];
  emitter.pid = FAKE_CHILD_PID;
  emitter.kill = (signal?: string) => {
    killSignals.push(signal ?? "SIGTERM");
    return true;
  };
  origProcessKill = process.kill;
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: NodeJS.Signals) => {
    if (Math.abs(pid) === FAKE_CHILD_PID) {
      killSignals.push(signal ?? "SIGTERM");
      return true;
    }
    return origProcessKill!(pid, signal);
  }) as typeof process.kill;
  return { child: emitter as unknown as ChildProcess, killSignals };
}

describe("installPromptWatchdog", () => {
  afterEach(() => {
    if (origProcessKill) {
      (process as { kill: typeof process.kill }).kill = origProcessKill;
      origProcessKill = undefined;
    }
  });

  it("layer 2: terminates and fails when output stalls past the idle timeout", async () => {
    const { child, killSignals } = makeFakeChild();
    const events: Array<{ status: number; reason: string; final: string }> = [];
    const stderr = new PassThrough();
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 40, maxDurationMs: 0, completionGraceMs: 0 }),
      "claude",
      stderr,
      (status, reason, final) => events.push({ status, reason, final }),
    );
    await delay(120);
    wd.clear();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 1);
    assert.match(events[0].reason, /no output/);
    assert.ok(killSignals.includes("SIGTERM"));
  });

  it("layer 2: bump() resets the idle timer so active runs are not killed", async () => {
    const { child } = makeFakeChild();
    const events: number[] = [];
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 80, maxDurationMs: 0, completionGraceMs: 0 }),
      "claude",
      new PassThrough(),
      (status) => events.push(status),
    );
    // Keep bumping inside the idle window for longer than the timeout itself.
    for (let i = 0; i < 4; i += 1) {
      await delay(40);
      wd.bump();
    }
    assert.equal(events.length, 0, "should not have expired while active");
    wd.clear();
  });

  it("layer 3: terminates and fails past the absolute maximum duration", async () => {
    const { child, killSignals } = makeFakeChild();
    const events: Array<{ status: number; reason: string }> = [];
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 0, maxDurationMs: 40, completionGraceMs: 0 }),
      "claude",
      new PassThrough(),
      (status, reason) => events.push({ status, reason }),
    );
    // bump() must NOT save it from the absolute cap.
    await delay(20);
    wd.bump();
    await delay(60);
    wd.clear();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 1);
    assert.match(events[0].reason, /maximum duration/);
    assert.ok(killSignals.includes("SIGTERM"));
  });

  it("layer 1: after completion, terminates and SUCCEEDS if the process never exits", async () => {
    const { child, killSignals } = makeFakeChild();
    const events: Array<{ status: number; reason: string; final: string }> = [];
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 0, maxDurationMs: 0, completionGraceMs: 40 }),
      "claude",
      new PassThrough(),
      (status, reason, final) => events.push({ status, reason, final }),
    );
    wd.markComplete("the answer");
    await delay(120);
    wd.clear();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 0, "completion grace must settle with success");
    assert.equal(events[0].final, "the answer");
    assert.match(events[0].reason, /did not exit/);
    assert.ok(killSignals.includes("SIGTERM"));
  });

  it("clear() before any timer fires prevents termination", async () => {
    const { child, killSignals } = makeFakeChild();
    const events: number[] = [];
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 40, maxDurationMs: 40, completionGraceMs: 40 }),
      "claude",
      new PassThrough(),
      (status) => events.push(status),
    );
    wd.clear();
    await delay(120);
    assert.equal(events.length, 0);
    assert.equal(killSignals.length, 0);
  });

  it("fires onExpire at most once even when multiple layers would trip", async () => {
    const { child } = makeFakeChild();
    const events: number[] = [];
    const wd = installPromptWatchdog(
      child,
      makeConfig({ idleTimeoutMs: 30, maxDurationMs: 35, completionGraceMs: 0 }),
      "claude",
      new PassThrough(),
      (status) => events.push(status),
    );
    await delay(120);
    wd.clear();
    assert.equal(events.length, 1);
  });
});

describe("executePrompt — prompt watchdog (end to end)", () => {
  it("recovers (success) when the agent finishes but the process never exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-grace-"));
    try {
      // Fake cursor-agent: emit a terminal `result` event, then hang forever.
      const fakeAgent = join(root, "cursor-agent");
      writeFileSync(
        fakeAgent,
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' '{"type":"result","result":"done-but-stuck"}'`,
          // `exec` so SIGTERM hits sleep directly — no orphaned grandchild.
          "exec sleep 600",
          "",
        ].join("\n"),
      );
      chmodSync(fakeAgent, 0o755);
      const stdout = new PassThrough();
      stdout.on("data", () => {});
      const result = await executePrompt(
        "ignored",
        makeConfig({
          agentCommand: fakeAgent,
          workspaceRoot: root,
          trustedWorkspace: root,
          completionGraceMs: 150,
          idleTimeoutMs: 0,
          maxDurationMs: 0,
        }),
        stdout,
      );
      assert.equal(result.status, 0);
      assert.equal(result.final, "done-but-stuck");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers (failure) when the agent hangs with no output", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-idle-"));
    try {
      const fakeAgent = join(root, "cursor-agent");
      writeFileSync(
        fakeAgent,
        ["#!/usr/bin/env bash", "exec sleep 600", ""].join("\n"),
      );
      chmodSync(fakeAgent, 0o755);
      const stdout = new PassThrough();
      stdout.on("data", () => {});
      const result = await executePrompt(
        "ignored",
        makeConfig({
          agentCommand: fakeAgent,
          workspaceRoot: root,
          trustedWorkspace: root,
          completionGraceMs: 0,
          idleTimeoutMs: 150,
          maxDurationMs: 0,
        }),
        stdout,
      );
      assert.equal(result.status, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it("resolves the config dir from os.homedir() when HOME is unset", () => {
    // The named `import { homedir }` in prompt.ts reads node:os's raw (mutable)
    // require object at call time, so stubbing homedir on that same cached
    // object changes what prepareClaudeEnv sees. Also clear process.env.HOME so
    // the os.homedir() fallback (not the ambient HOME) is what resolves.
    const osRaw = require("node:os") as { homedir: () => string };
    const root = mkdtempSync(join(tmpdir(), "jaiph-claude-env-homedir-"));
    const origHomedir = osRaw.homedir;
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    osRaw.homedir = () => root;
    try {
      const prepared = prepareClaudeEnv({}, join(root, "workspace"));
      assert.equal(prepared.error, undefined);
      assert.equal(prepared.warning, undefined);
      // A writable <homedir>/.claude means execEnv is returned unchanged and
      // session-env is created there — proving os.homedir() was the source.
      assert.equal(prepared.env.CLAUDE_CONFIG_DIR, undefined);
      assert.ok(existsSync(join(root, ".claude", "session-env")));
    } finally {
      osRaw.homedir = origHomedir;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers execEnv.HOME over os.homedir()", () => {
    const osRaw = require("node:os") as { homedir: () => string };
    const homeRoot = mkdtempSync(join(tmpdir(), "jaiph-claude-env-home-wins-"));
    const homedirRoot = mkdtempSync(join(tmpdir(), "jaiph-claude-env-homedir-unused-"));
    const origHomedir = osRaw.homedir;
    osRaw.homedir = () => homedirRoot;
    try {
      const prepared = prepareClaudeEnv({ HOME: homeRoot }, join(homeRoot, "workspace"));
      assert.equal(prepared.error, undefined);
      // Config resolves under execEnv.HOME, not the os.homedir() stub.
      assert.ok(existsSync(join(homeRoot, ".claude", "session-env")));
      assert.ok(!existsSync(join(homedirRoot, ".claude")));
    } finally {
      osRaw.homedir = origHomedir;
      rmSync(homeRoot, { recursive: true, force: true });
      rmSync(homedirRoot, { recursive: true, force: true });
    }
  });

  it("falls back to ephemeral claude config under the run dir when default is not writable", () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-claude-env-fallback-"));
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    try {
      const blockedPath = join(root, "blocked-config-path");
      writeFileSync(blockedPath, "not-a-directory");
      const prepared = prepareClaudeEnv(
        { CLAUDE_CONFIG_DIR: blockedPath, JAIPH_RUN_DIR: runDir },
        join(root, "workspace"),
      );
      assert.equal(prepared.error, undefined);
      assert.ok(prepared.warning);
      assert.equal(prepared.env.CLAUDE_CONFIG_DIR, join(runDir, "claude-config"));
      assert.ok(existsSync(join(runDir, "claude-config", "session-env")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

// ---------------------------------------------------------------------------
// Prompt env scrub — credential isolation at the backend spawn boundary
// ---------------------------------------------------------------------------

/** Write an executable fake agent that dumps its environment to `envDumpPath`
 *  and then emits a terminal stream-json result event. */
function writeEnvDumpAgent(agentPath: string, envDumpPath: string): void {
  writeFileSync(
    agentPath,
    [
      "#!/usr/bin/env bash",
      `printenv > "${envDumpPath}"`,
      'echo \'{"type":"result","result":"ok"}\'',
      "",
    ].join("\n"),
  );
  chmodSync(agentPath, 0o755);
}

describe("prompt env scrub (runBackend)", () => {
  it("host mode (cursor): an injected secret never reaches the agent; base env and CURSOR_API_KEY do", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-env-scrub-host-"));
    try {
      const envDump = join(root, "agent-env.txt");
      const fakeAgent = join(root, "cursor-agent");
      writeEnvDumpAgent(fakeAgent, envDump);
      const execEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        JAIPH_RUN_DIR: join(root, "run"),
        // Host mode merges `--env` pairs straight into the workflow env — this
        // models `jaiph run --env GITHUB_TOKEN ...`.
        GITHUB_TOKEN: "fake-gh-secret",
        CURSOR_API_KEY: "fake-cursor-key",
      };
      const result = await executePrompt(
        "ignored",
        makeConfig({ agentCommand: fakeAgent, workspaceRoot: root, trustedWorkspace: root }),
        new PassThrough(),
        execEnv,
      );
      assert.equal(result.status, 0);
      const dump = readFileSync(envDump, "utf8");
      assert.ok(!dump.includes("GITHUB_TOKEN"), `agent env must not contain GITHUB_TOKEN:\n${dump}`);
      assert.ok(!dump.includes("fake-gh-secret"), "agent env must not contain the secret value");
      assert.match(dump, /^CURSOR_API_KEY=fake-cursor-key$/m, "backend's own credential must pass");
      assert.match(dump, /^PATH=./m, "base env PATH must pass");
      assert.match(dump, /^JAIPH_RUN_DIR=./m, "JAIPH_ control keys must pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("host mode (claude): scrub applies before spawn; ANTHROPIC_API_KEY and CLAUDE_CONFIG_DIR pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-env-scrub-claude-"));
    const origPath = process.env.PATH;
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const envDump = join(root, "claude-env.txt");
      writeEnvDumpAgent(join(binDir, "claude"), envDump);
      // commandExists("claude") resolves against process.env.PATH.
      process.env.PATH = `${binDir}${delimiter}${origPath ?? ""}`;
      const execEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude-cfg"),
        GITHUB_TOKEN: "fake-gh-secret",
        ANTHROPIC_API_KEY: "fake-anthropic-key",
        CURSOR_API_KEY: "other-backend-key",
      };
      const result = await executePrompt(
        "hello",
        makeConfig({ backend: "claude", workspaceRoot: root, trustedWorkspace: root }),
        new PassThrough(),
        execEnv,
      );
      assert.equal(result.status, 0);
      const dump = readFileSync(envDump, "utf8");
      assert.ok(!dump.includes("GITHUB_TOKEN"), `agent env must not contain GITHUB_TOKEN:\n${dump}`);
      assert.ok(!dump.includes("fake-gh-secret"), "agent env must not contain the secret value");
      assert.ok(!dump.includes("other-backend-key"), "another backend's credential must not pass");
      assert.match(dump, /^ANTHROPIC_API_KEY=fake-anthropic-key$/m, "claude's own credential must pass");
      assert.match(dump, /^CLAUDE_CONFIG_DIR=./m, "CLAUDE_CONFIG_DIR must pass");
      assert.match(dump, /^HOME=./m, "base env HOME must pass");
    } finally {
      process.env.PATH = origPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("docker copy mode: a --env secret crosses into the container env but stops at the prompt subprocess", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-env-scrub-docker-"));
    try {
      const wsDir = join(root, "ws");
      const cloneDir = join(root, "clone");
      const runDir = join(root, "run");
      for (const d of [wsDir, cloneDir, runDir]) mkdirSync(d, { recursive: true });
      const args = buildDockerArgs({
        config: { enabled: true, image: "ubuntu:24.04", imageExplicit: false, network: "default", timeoutSeconds: 300 },
        sourceAbs: join(wsDir, "main.jh"),
        workspaceRoot: wsDir,
        sandboxRunDir: runDir,
        runArgs: [],
        env: { JAIPH_RUN_ID: "r1", CURSOR_API_KEY: "fake-cursor-key", GITHUB_TOKEN: "host-value" },
        isTTY: false,
        sandboxMode: "copy",
        sandboxWorkspaceDir: cloneDir,
        backends: ["cursor"],
        extraEnv: { GITHUB_TOKEN: "fake-gh-secret" },
      });
      // Reconstruct the env the containerized runtime sees: image base + the
      // emitted `-e` pairs (docker.ts owns which keys cross the boundary).
      const containerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root };
      for (let i = 0; i + 1 < args.length; i += 1) {
        if (args[i] !== "-e") continue;
        const eq = args[i + 1].indexOf("=");
        containerEnv[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
      }
      // Existing `--env` contract: the pair crosses the sandbox boundary verbatim.
      assert.equal(containerEnv.GITHUB_TOKEN, "fake-gh-secret");
      assert.equal(containerEnv.CURSOR_API_KEY, "fake-cursor-key");

      const envDump = join(root, "agent-env.txt");
      const fakeAgent = join(root, "cursor-agent");
      writeEnvDumpAgent(fakeAgent, envDump);
      const result = await executePrompt(
        "ignored",
        makeConfig({ agentCommand: fakeAgent, workspaceRoot: wsDir, trustedWorkspace: wsDir }),
        new PassThrough(),
        containerEnv,
      );
      assert.equal(result.status, 0);
      const dump = readFileSync(envDump, "utf8");
      assert.ok(!dump.includes("GITHUB_TOKEN"), `agent env must not contain GITHUB_TOKEN:\n${dump}`);
      assert.ok(!dump.includes("fake-gh-secret"), "agent env must not contain the secret value");
      assert.match(dump, /^CURSOR_API_KEY=fake-cursor-key$/m, "backend's own credential must pass");
      assert.match(dump, /^PATH=./m, "base env PATH must pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
