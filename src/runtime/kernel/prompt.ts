// Prompt execution: spawn the configured agent backend and stream its output.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, accessSync, mkdirSync, cpSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { parseStream, type StreamWriter } from "./stream-parser";
import { consumeNextMockResponse, dispatchMockArms, type MockPromptArm } from "./mock";

export type PromptConfig = {
  backend: string;
  agentCommand: string;
  model: string;
  workspaceRoot: string;
  trustedWorkspace: string;
  cursorFlags: string[];
  claudeFlags: string[];
  codexApiKey: string;
  codexApiUrl: string;
  promptFinalFile: string;
  /**
   * Watchdog timeouts for the subprocess backends (claude / cursor / custom).
   * All in milliseconds; `0` disables that watchdog. Optional so existing
   * callers/tests that build a config literal keep working — `runBackend`
   * falls back to the DEFAULT_* constants when a field is omitted.
   */
  completionGraceMs?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
};

/**
 * Layer 1 — completion grace: once the backend emits its terminal `result`
 * event the answer is complete. We give the process this long to exit on its
 * own before terminating it and returning success. Guards the known failure
 * mode where `claude -p` finishes the work but never exits.
 */
export const DEFAULT_PROMPT_COMPLETION_GRACE_MS = 30_000;
/**
 * Layer 2 — idle timeout: if the backend produces no stdout/stderr for this
 * long it is considered hung mid-work. We terminate it and return a non-zero
 * status so the runtime's retry/backoff loop takes over.
 */
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 900_000; // 15m
/**
 * Layer 3 — absolute cap: a single prompt may never run longer than this,
 * regardless of activity. Backstop against slow-but-not-idle hangs.
 */
export const DEFAULT_PROMPT_MAX_DURATION_MS = 7_200_000; // 2h

/** Parse a "seconds" env value into milliseconds; empty/invalid → default. `0` is honored (disables). */
function parseSecondsMs(raw: string | undefined, defaultMs: number): number {
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return defaultMs;
  return Math.floor(seconds * 1000);
}

export type ModelResolution = {
  model: string;
  reason: "explicit" | "flags" | "backend-default";
};

/**
 * Resolve the effective model for the current backend.
 *
 * Selection order:
 * 1. Explicit model (agent.default_model / JAIPH_AGENT_MODEL) → use it.
 * 2. Model embedded in backend flags (--model in claude_flags/cursor_flags) → use it.
 * 3. No model → backend auto-selects (both cursor-agent and claude CLI pick defaults).
 */
export function resolveModel(config: PromptConfig): ModelResolution {
  if (config.model) {
    return { model: config.model, reason: "explicit" };
  }
  // Codex has no CLI flags; model comes from explicit config or backend default only.
  if (config.backend === "codex") {
    return { model: "", reason: "backend-default" };
  }
  // Check if --model is embedded in backend-specific flags.
  const flags = config.backend === "claude" ? config.claudeFlags : config.cursorFlags;
  const modelIdx = flags.indexOf("--model");
  if (modelIdx !== -1 && modelIdx + 1 < flags.length) {
    return { model: flags[modelIdx + 1], reason: "flags" };
  }
  // Both cursor-agent and claude CLI auto-select a model when none is provided.
  return { model: "", reason: "backend-default" };
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): PromptConfig {
  const workspaceRoot = env.JAIPH_WORKSPACE || process.cwd();
  return {
    backend: env.JAIPH_AGENT_BACKEND || "cursor",
    agentCommand: env.JAIPH_AGENT_COMMAND || "cursor-agent",
    model: env.JAIPH_AGENT_MODEL || "",
    workspaceRoot,
    trustedWorkspace: env.JAIPH_AGENT_TRUSTED_WORKSPACE || workspaceRoot,
    cursorFlags: env.JAIPH_AGENT_CURSOR_FLAGS ? env.JAIPH_AGENT_CURSOR_FLAGS.split(/\s+/).filter(Boolean) : [],
    claudeFlags: env.JAIPH_AGENT_CLAUDE_FLAGS ? env.JAIPH_AGENT_CLAUDE_FLAGS.split(/\s+/).filter(Boolean) : [],
    codexApiKey: env.OPENAI_API_KEY || "",
    codexApiUrl: env.JAIPH_CODEX_API_URL || "https://api.openai.com/v1/chat/completions",
    promptFinalFile: env.JAIPH_PROMPT_FINAL_FILE || "",
    completionGraceMs: parseSecondsMs(
      env.JAIPH_PROMPT_COMPLETION_GRACE_SECONDS,
      DEFAULT_PROMPT_COMPLETION_GRACE_MS,
    ),
    idleTimeoutMs: parseSecondsMs(
      env.JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS,
      DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
    ),
    maxDurationMs: parseSecondsMs(env.JAIPH_PROMPT_MAX_SECONDS, DEFAULT_PROMPT_MAX_DURATION_MS),
  };
}

/** True when the cursor backend uses a custom command (not cursor-agent). */
export function isCustomCommand(config: PromptConfig): boolean {
  if (config.backend !== "cursor") return false;
  const command = config.agentCommand.split(/\s+/)[0];
  return basename(command) !== "cursor-agent";
}

/** Resolve the display name for a prompt step (backend name or custom command basename). */
export function resolvePromptStepName(config: PromptConfig): string {
  if (isCustomCommand(config)) {
    return basename(config.agentCommand.split(/\s+/)[0]);
  }
  return config.backend || "cursor";
}

function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAIPH_TEST_MODE === "1";
}

/**
 * Escape a string the way bash `printf "%q"` does (backslash-escaping).
 * Matches jaiph::format_shell_command output exactly.
 */
function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  // If the string contains only safe chars, return as-is
  if (/^[a-zA-Z0-9_./:@=,+%-]+$/.test(s)) return s;
  // Use $'...' quoting for strings with control characters (newlines, tabs, etc.)
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return "$'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      .replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r") + "'";
  }
  // Backslash-escape special characters (matches printf %q for simple cases)
  return s.replace(/([^a-zA-Z0-9_./:@=,+%-])/g, "\\$1");
}

/** Format a shell command for log display (matches jaiph::format_shell_command). */
function formatShellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Build the command args for the selected backend. */
export function buildBackendArgs(config: PromptConfig, promptText: string): { command: string; args: string[] } {
  if (config.backend === "codex") {
    const model = config.model || "gpt-4o";
    return { command: "codex-api", args: ["--model", model, "--url", config.codexApiUrl] };
  }
  if (config.backend === "claude") {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
    // Pass --model from agent.default_model when set and not already in claude_flags.
    if (config.model && !config.claudeFlags.includes("--model")) {
      args.push("--model", config.model);
    }
    args.push(...config.claudeFlags);
    return { command: "claude", args };
  }
  // cursor backend (or custom command)
  const commandParts = config.agentCommand.split(/\s+/).filter(Boolean);
  const command = commandParts[0];
  if (isCustomCommand(config)) {
    // Custom commands: no cursor-specific flags; prompt piped via stdin.
    return { command, args: commandParts.slice(1) };
  }
  const baseArgs = [...commandParts.slice(1), "--print", "--output-format", "stream-json", "--stream-partial-output"];
  baseArgs.push("--workspace", config.workspaceRoot);
  if (config.model) baseArgs.push("--model", config.model);
  baseArgs.push("--trust", config.trustedWorkspace);
  baseArgs.push(...config.cursorFlags);
  baseArgs.push(promptText);
  return { command, args: baseArgs };
}

/** Check if a command exists in PATH. */
function commandExists(cmd: string): boolean {
  if (!cmd) return false;
  if (cmd.includes("/")) {
    try {
      accessSync(cmd, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, cmd);
    try {
      accessSync(full, fsConstants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

function isDirWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

type ClaudeEnvPreparation = {
  env: NodeJS.ProcessEnv;
  warning?: string;
  error?: string;
};

/**
 * Ensure Claude CLI has a writable config/session directory.
 * Falls back to workspace-local `.jaiph/claude-config` when home config is not writable.
 */
export function prepareClaudeEnv(execEnv: NodeJS.ProcessEnv, workspaceRoot: string): ClaudeEnvPreparation {
  const home = execEnv.HOME || process.env.HOME || "";
  const defaultConfigDir = home ? join(home, ".claude") : "";
  const configuredDir = execEnv.CLAUDE_CONFIG_DIR || defaultConfigDir;

  if (configuredDir) {
    try {
      mkdirSync(join(configuredDir, "session-env"), { recursive: true });
      if (isDirWritable(join(configuredDir, "session-env"))) {
        return { env: execEnv };
      }
    } catch {
      // Fallback to workspace-local config.
    }
  }

  const fallbackConfigDir = join(workspaceRoot, ".jaiph", "claude-config");
  try {
    mkdirSync(fallbackConfigDir, { recursive: true });
    // Seed the fallback with the user's existing config (auth, settings) so the
    // Claude CLI keeps its credentials when only session-env was unwritable.
    if (
      configuredDir &&
      configuredDir !== fallbackConfigDir &&
      existsSync(configuredDir) &&
      !existsSync(join(fallbackConfigDir, "config.json"))
    ) {
      try {
        cpSync(configuredDir, fallbackConfigDir, { recursive: true });
      } catch {
        // If source config is malformed/inaccessible, continue with clean fallback.
      }
    }
    const fallbackSessionDir = join(fallbackConfigDir, "session-env");
    mkdirSync(fallbackSessionDir, { recursive: true });
    if (!isDirWritable(fallbackSessionDir)) {
      return {
        env: execEnv,
        error:
          `jaiph: Claude backend requires writable session state, but cannot write ` +
          `'${fallbackSessionDir}'. Fix permissions or set CLAUDE_CONFIG_DIR to a writable path.`,
      };
    }
    return {
      env: { ...execEnv, CLAUDE_CONFIG_DIR: fallbackConfigDir },
      warning:
        `jaiph: Claude config dir '${configuredDir || "<unset>"}' is not writable; ` +
        `using workspace fallback '${fallbackConfigDir}'.`,
    };
  } catch {
    return {
      env: execEnv,
      error:
        `jaiph: Claude backend could not initialize writable session state. ` +
        `Set CLAUDE_CONFIG_DIR to a writable directory and retry.`,
    };
  }
}

const CODEX_DEFAULT_MODEL = "gpt-4o";

/** Run a prompt against the OpenAI Chat Completions API with streaming. */
function runCodexBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  stderr: NodeJS.WritableStream,
): Promise<{ final: string; status: number }> {
  if (!config.codexApiKey) {
    stderr.write(
      'jaiph: agent.backend is "codex" but OPENAI_API_KEY is not set. ' +
      "Set the OPENAI_API_KEY environment variable to your OpenAI API key.\n",
    );
    return Promise.resolve({ final: "", status: 1 });
  }

  const model = config.model || CODEX_DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: promptText }],
    stream: true,
  });

  const url = new URL(config.codexApiUrl);
  const isHttps = url.protocol === "https:";
  const httpMod = isHttps
    ? (require("node:https") as typeof import("node:https"))
    : (require("node:http") as typeof import("node:http"));

  return new Promise((resolve) => {
    const req = httpMod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.codexApiKey}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (chunk: Buffer) => {
            errBody += chunk.toString();
          });
          res.on("end", () => {
            let msg = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(errBody) as Record<string, unknown>;
              const errObj = parsed.error as Record<string, unknown> | undefined;
              if (errObj && typeof errObj.message === "string") msg += `: ${errObj.message}`;
            } catch {
              // Use raw status code only.
            }
            stderr.write(`jaiph: codex API error: ${msg}\n`);
            resolve({ final: "", status: 1 });
          });
          return;
        }

        let final = "";
        let wroteFinalHeader = false;
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data) as Record<string, unknown>;
              const choices = obj.choices as Array<Record<string, unknown>> | undefined;
              const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
              const content = delta?.content;
              if (typeof content === "string" && content.length > 0) {
                if (!wroteFinalHeader) {
                  writer.writeFinal("Final answer:\n");
                  wroteFinalHeader = true;
                }
                writer.writeFinal(content);
                final += content;
              }
            } catch {
              // Skip malformed SSE line.
            }
          }
        });

        res.on("end", () => {
          resolve({ final, status: 0 });
        });

        res.on("error", (err: Error) => {
          stderr.write(`jaiph: codex stream error: ${err.message}\n`);
          resolve({ final, status: 1 });
        });
      },
    );

    req.on("error", (err: Error) => {
      stderr.write(`jaiph: codex API request failed: ${err.message}\n`);
      resolve({ final: "", status: 1 });
    });

    req.write(body);
    req.end();
  });
}

type PromptWatchdog = {
  /** Record backend activity (an stdout/stderr chunk); resets the idle timer. */
  bump: () => void;
  /** Record that the backend emitted its terminal result event (Layer 1). */
  markComplete: (finalSoFar: string) => void;
  /** Stop all timers; call once the prompt has settled. */
  clear: () => void;
};

/**
 * Install the three watchdog layers over a spawned backend child process:
 *
 *  1. Completion grace — once the backend signals completion (`markComplete`),
 *     give it `completionGraceMs` to exit on its own, then terminate it and
 *     settle with success. Fixes the case where `claude -p` finishes the work
 *     but the process never exits (so the output stream never closes).
 *  2. Idle timeout — if no output arrives for `idleTimeoutMs`, treat the run
 *     as hung mid-work, terminate it, and settle with failure (status 1) so the
 *     runtime's retry/backoff loop takes over.
 *  3. Absolute cap — terminate and fail past `maxDurationMs` regardless of
 *     activity, as a backstop against slow-but-not-idle hangs.
 *
 * `onExpire(status, reason, finalSoFar)` fires at most once. By the time it
 * runs the child has already been sent SIGTERM (escalating to SIGKILL after a
 * short delay), so the caller only needs to settle its promise.
 */
export function installPromptWatchdog(
  child: ChildProcess,
  config: PromptConfig,
  backend: string,
  stderr: NodeJS.WritableStream,
  onExpire: (status: number, reason: string, finalSoFar: string) => void,
): PromptWatchdog {
  const completionGraceMs = config.completionGraceMs ?? DEFAULT_PROMPT_COMPLETION_GRACE_MS;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_PROMPT_MAX_DURATION_MS;

  let fired = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let maxTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let lastFinal = "";

  const clear = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (graceTimer) clearTimeout(graceTimer);
    idleTimer = maxTimer = graceTimer = undefined;
  };

  const killChild = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // no-op
    }
    const escalate = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, 5000);
    escalate.unref?.();
  };

  const expire = (status: number, reason: string): void => {
    if (fired) return;
    fired = true;
    clear();
    stderr.write(`jaiph: ${reason}; terminating ${backend} backend.\n`);
    killChild();
    onExpire(status, reason, lastFinal);
  };

  const armIdle = (): void => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => expire(1, `prompt produced no output for ${Math.round(idleTimeoutMs / 1000)}s`),
      idleTimeoutMs,
    );
    idleTimer.unref?.();
  };

  if (maxDurationMs > 0) {
    maxTimer = setTimeout(
      () => expire(1, `prompt exceeded the ${Math.round(maxDurationMs / 1000)}s maximum duration`),
      maxDurationMs,
    );
    maxTimer.unref?.();
  }
  armIdle();

  return {
    bump: () => armIdle(),
    markComplete: (finalSoFar: string) => {
      lastFinal = finalSoFar;
      if (completionGraceMs <= 0 || fired || graceTimer) return;
      graceTimer = setTimeout(
        () =>
          expire(
            0,
            `prompt completed but ${backend} did not exit within ${Math.round(completionGraceMs / 1000)}s`,
          ),
        completionGraceMs,
      );
      graceTimer.unref?.();
    },
    clear,
  };
}

/** Run the backend process and parse its streaming output. */
function runBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  execEnv: NodeJS.ProcessEnv = process.env,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ final: string; status: number }> {
  // Codex uses HTTP API, not a CLI subprocess.
  if (config.backend === "codex") {
    return runCodexBackend(config, promptText, writer, stderr);
  }

  // Pre-flight check for claude backend
  if (config.backend === "claude" && !commandExists("claude")) {
    stderr.write(
      'jaiph: agent.backend is "claude" but the Claude CLI (claude) was not found in PATH. ' +
      'Install the Anthropic Claude CLI or set agent.backend = "cursor" (or JAIPH_AGENT_BACKEND=cursor).\n',
    );
    return Promise.resolve({ final: "", status: 1 });
  }

  return new Promise((resolve) => {
    const { command, args } = buildBackendArgs(config, promptText);
    const isClaude = config.backend === "claude";
    const isCustom = isCustomCommand(config);
    let childEnv: NodeJS.ProcessEnv = execEnv;
    if (isClaude) {
      const prepared = prepareClaudeEnv(execEnv, config.workspaceRoot);
      if (prepared.error) {
        stderr.write(`${prepared.error}\n`);
        resolve({ final: "", status: 1 });
        return;
      }
      if (prepared.warning) {
        stderr.write(`${prepared.warning}\n`);
      }
      childEnv = prepared.env;
    }
    // Cursor: stdin is not used (prompt is passed as arg), stderr passes through to caller.
    // Claude / custom: stdin receives prompt, stdout is parsed or collected raw.
    const useStdin = isClaude || isCustom;
    const child = nodeSpawn(command, args, {
      stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    // Single-settle guard shared by the normal-exit path and every watchdog.
    let settled = false;
    let exitCode: number | null = null;
    // Extra stream to tear down on settle (the claude `merged` PassThrough).
    let extraStream: { destroy: () => void } | undefined;
    const settle = (final: string, status: number): void => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      // Release Node's handles on the child's pipes. Without this, a descendant
      // that outlives the child while holding the stdout write end (the classic
      // `claude -p` hang) keeps these streams — and the event loop — alive even
      // after we've terminated the child and resolved. Destroying here lets the
      // runtime move on (and ultimately exit) regardless.
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        extraStream?.destroy();
      } catch {
        // best-effort cleanup
      }
      resolve({ final, status });
    };

    // Watchdog layers (completion grace / idle / absolute cap). For custom
    // commands only layers 2 and 3 apply — there is no result event to trigger
    // layer 1, so markComplete is simply never called.
    const watchdog = installPromptWatchdog(
      child,
      config,
      isCustom ? command : config.backend,
      stderr,
      (status, _reason, finalSoFar) => settle(finalSoFar, status),
    );

    child.on("error", (err) => {
      stderr.write(`jaiph: failed to start ${command}: ${err.message}\n`);
      settle("", 1);
    });
    child.on("exit", (code) => {
      exitCode = code;
    });

    if (useStdin && child.stdin) {
      child.stdin.write(promptText);
      child.stdin.end();
    }

    // Custom commands: collect raw stdout without JSON stream parsing.
    if (isCustom) {
      let final = "";
      let wroteHeader = false;
      child.stderr?.pipe(stderr);
      child.stderr?.on("data", () => watchdog.bump());
      child.stdout?.on("data", (chunk: Buffer) => {
        watchdog.bump();
        const text = chunk.toString();
        if (!wroteHeader) {
          writer.writeFinal("Final answer:\n");
          wroteHeader = true;
        }
        writer.writeFinal(text);
        final += text;
      });
      child.on("close", (code) => {
        settle(final, code ?? exitCode ?? 0);
      });
      return;
    }

    let parseInput: import("node:stream").Readable;
    if (isClaude) {
      // Claude: merge stdout + stderr for parsing (matches bash `2>&1 |` behavior)
      const { PassThrough } = require("node:stream") as typeof import("node:stream");
      const merged = new PassThrough();
      child.stdout?.pipe(merged);
      child.stderr?.pipe(merged);
      child.on("close", () => merged.end());
      parseInput = merged;
      extraStream = merged;
    } else {
      // Cursor: parse only stdout; pipe stderr through to process stderr
      parseInput = child.stdout!;
      child.stderr?.pipe(stderr);
    }

    parseStream(parseInput, writer, {
      onComplete: (finalSoFar) => watchdog.markComplete(finalSoFar),
    }).then((final) => {
      // Stream ended — process closed, or the watchdog already killed it and
      // settled (in which case `settle` here is a no-op).
      const close = (code: number | null): void => settle(final, code ?? exitCode ?? 0);
      if (child.exitCode !== null || exitCode !== null) {
        close(child.exitCode ?? exitCode);
      } else {
        child.on("close", (code) => close(code));
      }
    });

    // Reset the idle watchdog on every chunk. Attached after parseStream so the
    // cursor backend (whose stdout IS the parse input) does not drop the first
    // chunk to a premature switch into flowing mode.
    child.stdout?.on("data", () => watchdog.bump());
    child.stderr?.on("data", () => watchdog.bump());
  });
}

function writeFinalFile(filePath: string, content: string): void {
  if (filePath) {
    try {
      writeFileSync(filePath, content, "utf8");
    } catch {
      // Best-effort final capture
    }
  }
}

/** Remove only surrounding blank lines while preserving inner formatting. */
function trimSurroundingBlankLines(input: string): string {
  return input.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

/** Write Command:/Prompt: headers (same for real runs and test mocks) for run artifacts. */
function writePromptTranscriptHeader(
  stdout: NodeJS.WritableStream,
  config: PromptConfig,
  promptText: string,
): void {
  if (!promptText) return;
  const { command, args } = buildBackendArgs(config, promptText);
  let commandLog: string;
  if (config.backend === "codex") {
    commandLog = formatShellCommand([command, ...args]);
  } else if (config.backend === "claude" || isCustomCommand(config)) {
    // Claude and custom commands: prompt piped via stdin.
    commandLog = `printf %s ${shellQuote(promptText)} \\| ${formatShellCommand([command, ...args])}`;
  } else {
    commandLog = formatShellCommand([command, ...args]);
  }
  stdout.write(`Command:\n${commandLog}\n\n`);
  stdout.write(`Prompt:\n${promptText}\n\n`);
}

/** Core prompt execution logic. Returns final text and exit status. */
export async function executePrompt(
  promptText: string,
  config: PromptConfig,
  stdout: NodeJS.WritableStream,
  /** Workflow/runtime env (JAIPH_TEST_MODE and mocks); defaults to process.env for CLI entry. */
  execEnv: NodeJS.ProcessEnv = process.env,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ final: string; status: number }> {
  writePromptTranscriptHeader(stdout, config, promptText);

  // Test mode: check mocks first
  if (isTestMode(execEnv)) {
    const armsJson = execEnv.JAIPH_MOCK_PROMPT_ARMS_JSON || "";
    if (armsJson) {
      let arms: MockPromptArm[] = [];
      try {
        arms = JSON.parse(armsJson) as MockPromptArm[];
      } catch {
        stderr.write(`jaiph: invalid JAIPH_MOCK_PROMPT_ARMS_JSON\n`);
        return { final: "", status: 1 };
      }
      const result = dispatchMockArms(promptText, arms);
      if (result.status === 0) {
        writeFinalFile(config.promptFinalFile, result.response);
        stdout.write(result.response);
        if (!result.response.endsWith("\n")) {
          stdout.write("\n");
        }
        return { final: result.response, status: 0 };
      }
      return { final: "", status: result.status };
    }
    const responsesJson = execEnv.JAIPH_MOCK_RESPONSES_JSON || "";
    if (responsesJson) {
      const mockResult = consumeNextMockResponse(responsesJson);
      if (mockResult !== null) {
        writeFinalFile(config.promptFinalFile, mockResult);
        stdout.write(mockResult);
        if (!mockResult.endsWith("\n")) {
          stdout.write("\n");
        }
        return { final: mockResult, status: 0 };
      }
    }
    // No mock set or no match: fall through to real backend
  }

  const writer: StreamWriter = {
    writeReasoning: (text) => stdout.write(text),
    writeFinal: (text) => stdout.write(text),
  };

  const result = await runBackend(config, promptText, writer, execEnv, stderr);
  const final =
    config.backend === "cursor"
      ? trimSurroundingBlankLines(result.final)
      : result.final;
  writeFinalFile(config.promptFinalFile, final);
  if (promptText) {
    stdout.write("\n");
  }
  return { final, status: result.status };
}

/** Read prompt text from stdin. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

// Main entry point when run as script
async function main(): Promise<void> {
  const stdinText = await readStdin();
  const promptText = stdinText || process.argv.slice(2).join(" ");
  const config = resolveConfig();
  const result = await executePrompt(promptText, config, process.stdout);
  process.exit(result.status);
}

// Run only when executed directly (not when imported for testing)
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`jaiph kernel: ${err}\n`);
    process.exit(1);
  });
}
