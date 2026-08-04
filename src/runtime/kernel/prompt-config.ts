import { basename } from "node:path";

// Prompt configuration, model resolution, and backend argument building. Split
// out of `prompt.ts` so each prompt concern stays under the analyzability line
// cap. Pure functions over the runtime env / config — no process spawning.

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
  reason: "explicit" | "flags" | "backend-default" | "none";
};

/** Run-tree label when the backend CLI auto-selects a model (not passed to `--model`). */
export const BACKEND_DEFAULT_MODEL_LABEL = "default";

/** Model token for STEP_START/STEP_END; does not affect backend CLI args. */
export function modelForStepEvent(res: ModelResolution): string {
  if (res.model.length > 0) return res.model;
  if (res.reason === "backend-default") return BACKEND_DEFAULT_MODEL_LABEL;
  return "";
}

/**
 * Resolve the effective model for the current backend.
 *
 * Selection order:
 * 1. Explicit model (agent.model / JAIPH_AGENT_MODEL) → use it.
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
  // Custom agent commands don't have a model concept — suppress the label.
  if (isCustomCommand(config)) {
    return { model: "", reason: "none" };
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

/**
 * Build prompt config for one invocation. `JAIPH_AGENT_MODEL` (user env) wins;
 * otherwise `configModel` from in-file metadata applies for this prompt only.
 */
export function resolvePromptConfig(env: NodeJS.ProcessEnv, configModel?: string): PromptConfig {
  const config = resolveConfig(env);
  if (!config.model && configModel) {
    config.model = configModel;
  }
  return config;
}

/** Basename of the agent command's first token (`/usr/bin/my-agent -x` → `my-agent`). */
function agentCommandName(config: PromptConfig): string {
  return basename(config.agentCommand.split(/\s+/)[0]);
}

/** True when the cursor backend uses a custom command (not cursor-agent). */
export function isCustomCommand(config: PromptConfig): boolean {
  if (config.backend !== "cursor") return false;
  return agentCommandName(config) !== "cursor-agent";
}

/** Resolve the display name for a prompt step (backend name or custom command basename). */
export function resolvePromptStepName(config: PromptConfig): string {
  if (isCustomCommand(config)) {
    return agentCommandName(config);
  }
  return config.backend || "cursor";
}

export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAIPH_TEST_MODE === "1";
}

/**
 * Escape a string the way bash `printf "%q"` does (backslash-escaping).
 * Matches jaiph::format_shell_command output exactly.
 *
 * Exported so the workflow runtime can shell-quote every value it interpolates
 * into a `sh -c` shell-fallthrough line (see `interpolateWithCaptures` in
 * `node-workflow-runtime.ts`), keeping the single canonical escaper here.
 */
export function shellQuote(s: string): string {
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

/** Build the command args for the selected backend. */
export function buildBackendArgs(config: PromptConfig, promptText: string): { command: string; args: string[] } {
  if (config.backend === "codex") {
    const model = config.model || "gpt-4o";
    return { command: "codex-api", args: ["--model", model, "--url", config.codexApiUrl] };
  }
  if (config.backend === "claude") {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
    // Pass --model from agent.model when set and not already in claude_flags.
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
