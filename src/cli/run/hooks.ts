import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HookConfig, HookEventName, HookPayload } from "../../types";
import type { RunEmitter } from "./emitter";

const HOOKS_FILENAME = "hooks.json";

/** Path to global hooks config: ~/.jaiph/hooks.json */
export function globalHooksPath(): string {
  return join(homedir(), ".jaiph", HOOKS_FILENAME);
}

/** Path to project-local hooks config: <workspace>/.jaiph/hooks.json */
export function projectHooksPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".jaiph", HOOKS_FILENAME);
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
      "workflow_start",
      "workflow_end",
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
  workflow_start: string[];
  workflow_end: string[];
  step_start: string[];
  step_end: string[];
}

function emptyMerged(): MergedHookConfig {
  return {
    workflow_start: [],
    workflow_end: [],
    step_start: [],
    step_end: [],
  };
}

/**
 * Load global and project hook configs and merge with precedence:
 * project-local entries override global for each event (per-event override).
 * Returns merged config; if both files absent or invalid, returns empty arrays for all events.
 */
export function loadMergedHooks(workspaceRoot: string): MergedHookConfig {
  const merged = emptyMerged();
  const globalPath = globalHooksPath();
  const projectPath = projectHooksPath(workspaceRoot);

  const globalConfig = loadHookConfig(globalPath);
  const projectConfig = loadHookConfig(projectPath);

  const events: HookEventName[] = [
    "workflow_start",
    "workflow_end",
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
      const child = spawn("sh", ["-c", cmd], {
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
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`jaiph hooks: failed to run ${cmd}: ${message}\n`);
    }
  }
}

/** Subscribe to emitter events and invoke hooks for each lifecycle event. */
export function registerHooksSubscriber(
  emitter: RunEmitter,
  config: MergedHookConfig,
  inputAbs: string,
  workspaceRoot: string,
): void {
  emitter.on("step_start", (data) => {
    runHooksForEvent(config, "step_start", {
      event: "step_start",
      workflow_id: data.event.run_id,
      step_id: data.eventId,
      step_kind: data.event.kind,
      step_name: data.event.name,
      timestamp: data.event.ts || new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
    });
  });

  emitter.on("step_end", (data) => {
    runHooksForEvent(config, "step_end", {
      event: "step_end",
      workflow_id: data.event.run_id,
      step_id: data.eventId,
      step_kind: data.event.kind,
      step_name: data.event.name,
      status: data.event.status ?? 1,
      elapsed_ms: data.event.elapsed_ms ?? 0,
      timestamp: data.event.ts || new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
      out_file: data.event.out_file || undefined,
      err_file: data.event.err_file || undefined,
    });
  });

  emitter.on("workflow_start", (payload) => {
    runHooksForEvent(config, "workflow_start", payload);
  });

  emitter.on("workflow_end", (payload) => {
    runHooksForEvent(config, "workflow_end", payload);
  });
}
