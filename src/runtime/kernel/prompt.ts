// JS kernel: prompt execution.
// Called from bash: echo "$prompt_text" | node kernel/prompt.js [preview] [named_args...]
// Env vars: JAIPH_AGENT_BACKEND, JAIPH_AGENT_COMMAND, JAIPH_AGENT_MODEL,
//   JAIPH_AGENT_TRUSTED_WORKSPACE, JAIPH_AGENT_CURSOR_FLAGS, JAIPH_AGENT_CLAUDE_FLAGS,
//   OPENAI_API_KEY, JAIPH_CODEX_API_URL,
//   JAIPH_WORKSPACE, JAIPH_TEST_MODE, JAIPH_MOCK_DISPATCH_SCRIPT,
//   JAIPH_MOCK_RESPONSES_FILE, JAIPH_PROMPT_FINAL_FILE

import { spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, accessSync, mkdirSync, cpSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { parseStream, type StreamWriter } from "./stream-parser";
import { readNextMockResponse, mockDispatch } from "./mock";

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
};

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

export type ProcNode = {
  pid: number;
  ppid: number;
  elapsedSeconds: number;
  command: string;
};

const DEFAULT_TAIL_KILL_POLL_MS = 15_000;
const DEFAULT_TAIL_MAX_AGE_SECONDS = 10 * 60;

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

export function parseEtimeToSeconds(raw: string): number {
  const value = raw.trim();
  if (value.length === 0) return 0;
  const daySplit = value.split("-");
  const hasDays = daySplit.length === 2;
  const dayPart = hasDays ? daySplit[0] : "0";
  const timePart = hasDays ? daySplit[1] : daySplit[0];
  if (!timePart) return 0;
  const day = Number(dayPart);
  const parts = timePart.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (parts.length === 3) {
    [hour, minute, second] = parts;
  } else if (parts.length === 2) {
    [minute, second] = parts;
  } else if (parts.length === 1) {
    [second] = parts;
  } else {
    return 0;
  }
  return day * 86_400 + hour * 3_600 + minute * 60 + second;
}

function isTailProcess(command: string): boolean {
  return /(^|\/)tail$/.test(command.trim());
}

function listProcessNodes(): ProcNode[] {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const out = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,etime=,comm="], { encoding: "utf8" });
  if (out.status !== 0) return [];
  const text = String(out.stdout ?? "");
  const nodes: ProcNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const elapsedSeconds = parseEtimeToSeconds(m[3] ?? "");
    const command = m[4] ?? "";
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    nodes.push({ pid, ppid, elapsedSeconds, command });
  }
  return nodes;
}

export function selectTailToKill(nodes: ProcNode[], rootPid: number, minAgeSeconds: number): ProcNode | undefined {
  const byParent = new Map<number, ProcNode[]>();
  for (const n of nodes) {
    const arr = byParent.get(n.ppid) ?? [];
    arr.push(n);
    byParent.set(n.ppid, arr);
  }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const depthByPid = new Map<number, number>([[rootPid, 0]]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const children = byParent.get(cur.pid) ?? [];
    for (const child of children) {
      if (depthByPid.has(child.pid)) continue;
      const depth = cur.depth + 1;
      depthByPid.set(child.pid, depth);
      queue.push({ pid: child.pid, depth });
    }
  }
  let best: { node: ProcNode; depth: number } | undefined;
  for (const n of nodes) {
    const depth = depthByPid.get(n.pid);
    if (depth === undefined) continue;
    if (!isTailProcess(n.command)) continue;
    if (n.elapsedSeconds < minAgeSeconds) continue;
    if (!best || depth > best.depth || (depth === best.depth && n.elapsedSeconds > best.node.elapsedSeconds)) {
      best = { node: n, depth };
    }
  }
  return best?.node;
}

function startTailWatchdog(rootPid: number, stderr: NodeJS.WritableStream, env: NodeJS.ProcessEnv): () => void {
  const pollMs = Number(env.JAIPH_PROMPT_TAIL_KILL_POLL_MS ?? String(DEFAULT_TAIL_KILL_POLL_MS));
  const minAgeSeconds = Number(env.JAIPH_PROMPT_TAIL_MAX_AGE_SECONDS ?? String(DEFAULT_TAIL_MAX_AGE_SECONDS));
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(minAgeSeconds) || minAgeSeconds <= 0) {
    return () => {};
  }
  const timer = setInterval(() => {
    try {
      const nodes = listProcessNodes();
      const target = selectTailToKill(nodes, rootPid, minAgeSeconds);
      if (!target) return;
      try {
        process.kill(target.pid, "SIGTERM");
        stderr.write(
          `jaiph: killed stale tail subprocess pid=${target.pid} age_s=${target.elapsedSeconds} (threshold=${minAgeSeconds})\n`,
        );
      } catch {
        // Process may already be gone; ignore.
      }
    } catch {
      // Best-effort watchdog only.
    }
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}

const CODEX_DEFAULT_MODEL = "gpt-4o";

/** Run a prompt against the OpenAI Chat Completions API with streaming. */
function runCodexBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
): Promise<{ final: string; status: number }> {
  if (!config.codexApiKey) {
    process.stderr.write(
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
            process.stderr.write(`jaiph: codex API error: ${msg}\n`);
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
          process.stderr.write(`jaiph: codex stream error: ${err.message}\n`);
          resolve({ final, status: 1 });
        });
      },
    );

    req.on("error", (err: Error) => {
      process.stderr.write(`jaiph: codex API request failed: ${err.message}\n`);
      resolve({ final: "", status: 1 });
    });

    req.write(body);
    req.end();
  });
}

/** Run the backend process and parse its streaming output. */
function runBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  execEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ final: string; status: number }> {
  // Codex uses HTTP API, not a CLI subprocess.
  if (config.backend === "codex") {
    return runCodexBackend(config, promptText, writer);
  }

  // Pre-flight check for claude backend
  if (config.backend === "claude" && !commandExists("claude")) {
    process.stderr.write(
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
        process.stderr.write(`${prepared.error}\n`);
        resolve({ final: "", status: 1 });
        return;
      }
      if (prepared.warning) {
        process.stderr.write(`${prepared.warning}\n`);
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
    const stopTailWatchdog = startTailWatchdog(child.pid ?? -1, process.stderr, childEnv);

    child.on("error", (err) => {
      stopTailWatchdog();
      process.stderr.write(`jaiph: failed to start ${command}: ${err.message}\n`);
      resolve({ final: "", status: 1 });
    });

    if (useStdin && child.stdin) {
      child.stdin.write(promptText);
      child.stdin.end();
    }

    // Custom commands: collect raw stdout without JSON stream parsing.
    if (isCustom) {
      let final = "";
      let wroteHeader = false;
      child.stderr?.pipe(process.stderr);
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (!wroteHeader) {
          writer.writeFinal("Final answer:\n");
          wroteHeader = true;
        }
        writer.writeFinal(text);
        final += text;
      });
      child.on("close", (code) => {
        stopTailWatchdog();
        resolve({ final, status: code ?? 0 });
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
    } else {
      // Cursor: parse only stdout; pipe stderr through to process stderr
      parseInput = child.stdout!;
      child.stderr?.pipe(process.stderr);
    }

    parseStream(parseInput, writer).then((final) => {
      child.on("close", (code) => {
        stopTailWatchdog();
        resolve({ final, status: code ?? 0 });
      });
      if (child.exitCode !== null) {
        stopTailWatchdog();
        resolve({ final, status: child.exitCode });
      }
    });
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
): Promise<{ final: string; status: number }> {
  writePromptTranscriptHeader(stdout, config, promptText);

  // Test mode: check mocks first
  if (isTestMode(execEnv)) {
    const dispatchScript = execEnv.JAIPH_MOCK_DISPATCH_SCRIPT || "";
    if (dispatchScript) {
      const result = mockDispatch(promptText, dispatchScript);
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
    const mockFile = execEnv.JAIPH_MOCK_RESPONSES_FILE || "";
    if (mockFile) {
      const mockResult = readNextMockResponse(mockFile);
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

  const result = await runBackend(config, promptText, writer, execEnv);
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
