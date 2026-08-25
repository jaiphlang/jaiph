import { existsSync, readFileSync } from "node:fs";
import { errText } from "../../errors";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveShell } from "../../runtime";
import type { HookConfig, HookEventName, HookPayload } from "../../types";
import type { RunEmitter } from "./emitter";
import type { StepEvent } from "./events";

const HOOKS_FILENAME = "hooks.json";

/** Path to global hooks config: ~/.jaiph/hooks.json */
export function globalHooksPath(): string {
  return join(homedir(), ".jaiph", HOOKS_FILENAME);
}

/** Path to project-local hooks config: <workspace>/.jaiph/hooks.json */
export function projectHooksPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".jaiph", HOOKS_FILENAME);
}

/**
 * Operator opt-in (`JAIPH_TRUST_PROJECT_HOOKS=1|true`) that trusts the current
 * workspace's project-local `.jaiph/hooks.json`. Absent it, the project file is
 * ignored: its commands run on the *host* CLI, so a cloned/untrusted repo
 * must not execute arbitrary host commands on `jaiph run` without an explicit
 * trust decision.
 * The global `~/.jaiph/hooks.json` is the operator's own and stays trusted.
 * Read from the host env only, never from workflow config — the file must not
 * be able to trust itself.
 */
export function isProjectHooksTrusted(env: Record<string, string | undefined>): boolean {
  return env.JAIPH_TRUST_PROJECT_HOOKS === "1" || env.JAIPH_TRUST_PROJECT_HOOKS === "true";
}

/** Validate and normalize raw JSON to HookConfig. Returns null if invalid. */
export function parseHookConfig(raw: string, sourceLabel: string): HookConfig | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const out: HookConfig = {};
    const events: HookEventName[] = [
      "run_start",
      "run_end",
      "step_start",
      "step_end",
    ];
    for (const event of events) {
      const v = (parsed as Record<string, unknown>)[event];
      if (v === undefined) continue;
      if (!Array.isArray(v)) continue;
      const commands: string[] = [];
      for (const item of v) {
        if (typeof item === "string" && item.length > 0) {
          commands.push(item);
        }
      }
      if (commands.length > 0) {
        out[event] = commands;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Load config from path if file exists and is valid JSON. Returns null on missing or invalid. */
function loadHookConfig(path: string): HookConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const config = parseHookConfig(raw, path);
    if (config === null) {
      process.stderr.write(`jaiph hooks: invalid or unsupported config at ${path}, skipping\n`);
      return null;
    }
    return config;
  } catch {
    process.stderr.write(`jaiph hooks: failed to read ${path}, skipping\n`);
    return null;
  }
}

/** Merged config: project-local overrides global for each event. */
export interface MergedHookConfig {
  run_start: string[];
  run_end: string[];
  step_start: string[];
  step_end: string[];
}

function emptyMerged(): MergedHookConfig {
  return {
    run_start: [],
    run_end: [],
    step_start: [],
    step_end: [],
  };
}

/**
 * Load global and project hook configs and merge with precedence:
 * project-local entries override global for each event (per-event override).
 * Returns merged config; if both files absent or invalid, returns empty arrays for all events.
 *
 * `trustProjectHooks` gates the project-local file behind an explicit
 * per-workspace trust decision (finding M-10). When false, a present-and-valid
 * `<workspace>/.jaiph/hooks.json` is ignored (with a one-line stderr notice) so
 * its host commands never run without operator consent; the global
 * `~/.jaiph/hooks.json` is unaffected either way.
 */
export function loadMergedHooks(
  workspaceRoot: string,
  trustProjectHooks: boolean,
): MergedHookConfig {
  const merged = emptyMerged();
  const globalPath = globalHooksPath();
  const projectPath = projectHooksPath(workspaceRoot);

  const globalConfig = loadHookConfig(globalPath);
  const rawProjectConfig = loadHookConfig(projectPath);
  const projectHasCommands =
    rawProjectConfig !== null && Object.keys(rawProjectConfig).length > 0;
  if (projectHasCommands && !trustProjectHooks) {
    process.stderr.write(
      `jaiph hooks: project-local hooks at ${projectPath} are ignored (untrusted workspace) — ` +
        `they run host commands in the CLI process. Set JAIPH_TRUST_PROJECT_HOOKS=1 to trust ` +
        `this workspace. Global ~/.jaiph/hooks.json still runs.\n`,
    );
  }
  const projectConfig = trustProjectHooks ? rawProjectConfig : null;

  const events: HookEventName[] = [
    "run_start",
    "run_end",
    "step_start",
    "step_end",
  ];
  for (const event of events) {
    const projectCommands = projectConfig?.[event];
    const globalCommands = globalConfig?.[event];
    if (projectCommands && projectCommands.length > 0) {
      merged[event] = [...projectCommands];
    } else if (globalCommands && globalCommands.length > 0) {
      merged[event] = [...globalCommands];
    }
  }
  return merged;
}

/**
 * Run all commands registered for the given event with the given payload.
 * Payload is passed as JSON on stdin. Best-effort: failures are logged to stderr
 * and do not throw or affect return value.
 */
export function runHooksForEvent(
  config: MergedHookConfig,
  event: HookEventName,
  payload: HookPayload,
): void {
  const commands = config[event];
  if (!commands || commands.length === 0) return;

  const payloadJson = JSON.stringify(payload);

  for (const cmd of commands) {
    try {
      const child = spawn(resolveShell(), ["-c", cmd], {
        stdio: ["pipe", "ignore", "pipe"],
        env: { ...process.env },
      });
      if (child.stdin) {
        child.stdin.on("error", (err) => {
          process.stderr.write(`jaiph hooks: failed to write payload to ${cmd}: ${err.message}\n`);
        });
      }
      if (child.stdin?.writable) {
        // Best-effort payload delivery. If the hook process exits early,
        // stdin can emit EPIPE asynchronously; the error listener above handles it.
        child.stdin.end(payloadJson, "utf8");
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      child.on("error", (err) => {
        process.stderr.write(`jaiph hooks: error running ${cmd}: ${err.message}\n`);
      });
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          process.stderr.write(`jaiph hooks: command exited with ${code}: ${cmd}\n`);
        }
      });
    } catch (err) {
      const message = errText(err);
      process.stderr.write(`jaiph hooks: failed to run ${cmd}: ${message}\n`);
    }
  }
}

/**
 * Build the `step_start` hook payload from a parsed runtime step event. One
 * builder for every invocation mode (direct `jaiph run`, `jaiph serve` HTTP
 * runs, `jaiph mcp` tool calls) so the payload contract cannot drift.
 */
export function stepStartHookPayload(
  event: StepEvent,
  stepId: string,
  inputAbs: string,
  workspaceRoot: string,
): HookPayload {
  return {
    event: "step_start",
    run_id: event.run_id,
    step_id: stepId,
    step_kind: event.kind,
    step_name: event.name,
    timestamp: event.ts || new Date().toISOString(),
    run_path: inputAbs,
    workspace: workspaceRoot,
  };
}

/** Build the `step_end` hook payload — shared across all three invocation modes. */
export function stepEndHookPayload(
  event: StepEvent,
  stepId: string,
  inputAbs: string,
  workspaceRoot: string,
): HookPayload {
  return {
    event: "step_end",
    run_id: event.run_id,
    step_id: stepId,
    step_kind: event.kind,
    step_name: event.name,
    status: event.status ?? 1,
    elapsed_ms: event.elapsed_ms ?? 0,
    timestamp: event.ts || new Date().toISOString(),
    run_path: inputAbs,
    workspace: workspaceRoot,
    out_file: event.out_file || undefined,
    err_file: event.err_file || undefined,
  };
}

/** Subscribe to emitter events and invoke hooks for each lifecycle event. */
export function registerHooksSubscriber(
  emitter: RunEmitter,
  config: MergedHookConfig,
  inputAbs: string,
  workspaceRoot: string,
): void {
  emitter.on("step_start", (data) => {
    runHooksForEvent(config, "step_start", stepStartHookPayload(data.event, data.eventId, inputAbs, workspaceRoot));
  });

  emitter.on("step_end", (data) => {
    runHooksForEvent(config, "step_end", stepEndHookPayload(data.event, data.eventId, inputAbs, workspaceRoot));
  });

  emitter.on("run_start", (payload) => {
    runHooksForEvent(config, "run_start", payload);
  });

  emitter.on("run_end", (payload) => {
    runHooksForEvent(config, "run_end", payload);
  });
}
