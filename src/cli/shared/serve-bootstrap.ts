import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { errText } from "../../errors";
import { detectWorkspaceRoot } from "./paths";
import { hasHelpFlag, parseArgs, resolveEnvPairs, type ParsedArgs } from "./usage";
import {
  loadGeneration,
  createGenerationTracker,
  type GenerationState,
  type GenerationTracker,
} from "./generation";
import {
  resolveStartupPosture,
  logStartupPosture,
  type StartupPosture,
} from "./startup-posture";

// Bootstrap shared by the long-lived workflow servers `jaiph mcp` and
// `jaiph serve`. Both parse the same flag set, validate the same `.jh` input,
// load a generation into a temp dir, and resolve the same startup
// posture, then watch sources for hot reload. That shared prefix lives here
// once rather than being copied between the two commands.

/** How often the source watcher polls module sources for hot reload (ms). */
export const WATCH_INTERVAL_MS = 750;

/** Validated CLI arguments shared by the server commands. */
export interface ServerArgs {
  command: "mcp" | "serve";
  parsed: ParsedArgs;
  inputAbs: string;
  workspaceRoot: string;
  extraEnv: Record<string, string>;
  /** Every diagnostic goes to stderr; stdout stays reserved for protocol/scripting. */
  log: (line: string) => void;
}

/** A loaded, posture-resolved server ready to serve calls. */
export interface ServerContext extends ServerArgs {
  tempRoot: string;
  generations: GenerationTracker;
  posture: StartupPosture;
  /** Remove the temp root (emitted scripts + serialized graphs). Idempotent-safe to call once. */
  cleanup: () => void;
}

/**
 * Phase 1: parse + validate the shared flags and `.jh` input. Cheap, side-effect
 * free work that runs before any temp dir is created, so a
 * command can insert its own validation (serve's auth/host/port) between this
 * and {@link startGeneration}. On help or any error, writes the message and
 * returns `{ code }`; on success returns `{ args }`.
 */
export function parseServerArgs(
  command: "mcp" | "serve",
  rest: string[],
  usage: string,
): { code: number } | { args: ServerArgs } {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (hasHelpFlag(rest)) {
    process.stdout.write(usage);
    return { code: 0 };
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rest, command);
  } catch (err) {
    log(errText(err));
    return { code: 1 };
  }
  const { workspace, env, positional } = parsed;
  const input = positional[0];
  if (!input) {
    log(`jaiph ${command} requires a .jh file path`);
    return { code: 1 };
  }
  // `--env` pairs apply to every call/run for the server's lifetime; resolve
  // (and bare-form host lookup / E_ENV_MISSING) once before the server starts.
  let extraEnv: Record<string, string>;
  try {
    extraEnv = resolveEnvPairs(env, process.env);
  } catch (err) {
    log(errText(err));
    return { code: 1 };
  }
  const inputAbs = resolve(input);
  if (!existsSync(inputAbs) || !statSync(inputAbs).isFile() || extname(inputAbs) !== ".jh") {
    log(`jaiph ${command} expects a single .jh file`);
    return { code: 1 };
  }
  const workspaceRoot = workspace ? resolve(workspace) : detectWorkspaceRoot(dirname(inputAbs));
  if (workspace && (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory())) {
    log(`--workspace path is not a directory: ${workspaceRoot}`);
    return { code: 1 };
  }
  return { args: { command, parsed, inputAbs, workspaceRoot, extraEnv, log } };
}

/**
 * Phase 2: create the temp root, load generation 0, and resolve + announce the
 * startup posture. Expensive work (credential pre-flight),
 * so callers run their cheap validation first. `noun` names what the server
 * executes in the startup notice ("runs" for HTTP, "tool calls" for MCP). On
 * failure logs, removes the temp root, and returns `{ code: 1 }`.
 */
export function startGeneration(
  args: ServerArgs,
  noun: string,
): { code: number } | { ctx: ServerContext } {
  const { command, inputAbs, workspaceRoot, extraEnv, log } = args;
  const label = `jaiph ${command}`;
  const tempRoot = mkdtempSync(join(tmpdir(), `jaiph-${command}-`));
  const cleanup = (): void => rmSync(tempRoot, { recursive: true, force: true });

  let generations: GenerationTracker;
  try {
    const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, 0, extraEnv, log, label);
    if (!loaded.state) {
      for (const f of loaded.failures) log(f);
      cleanup();
      return { code: 1 };
    }
    generations = createGenerationTracker(loaded.state);
  } catch (err) {
    log(errText(err));
    cleanup();
    return { code: 1 };
  }

  let posture: StartupPosture;
  try {
    posture = resolveStartupPosture(generations.current(), inputAbs, workspaceRoot, log);
    logStartupPosture(label, noun, posture, workspaceRoot, log);
  } catch (err) {
    log(errText(err));
    cleanup();
    return { code: 1 };
  }

  return { ctx: { ...args, tempRoot, generations, posture, cleanup } };
}

/**
 * A polling source watcher. `rewatch(files)` reconciles the watched set to
 * `files` (drop those that left, add those that arrived); `stop()` drops
 * everything and halts polling. A single shared interval stats every watched
 * file and fires `onChange` once per tick if any fingerprint moved.
 *
 * The baseline for each newly watched file is captured *synchronously* at watch
 * time. `node:fs`'s `watchFile` instead captures its baseline with an
 * asynchronous initial stat that fires no callback — under load that stat can be
 * delayed past the client's first edit, silently absorbing the edit into the
 * baseline so it is never detected. Capturing the baseline synchronously closes
 * that window. A file that survives a reload keeps its existing baseline
 * untouched, so an edit landing mid-reload is still seen on the next tick.
 */
export function createSourceWatcher(
  intervalMs: number,
  onChange: () => void,
): { rewatch: (files: string[]) => void; stop: () => void } {
  const baselines = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  // A change-detecting fingerprint: size and mtime move on any edit; a missing
  // file collapses to a sentinel so delete/recreate reads as a change too.
  const fingerprint = (f: string): string => {
    try {
      const s = statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "absent";
    }
  };
  const poll = (): void => {
    let changed = false;
    for (const [f, prev] of baselines) {
      const now = fingerprint(f);
      if (now !== prev) {
        baselines.set(f, now);
        changed = true;
      }
    }
    if (changed) onChange();
  };
  return {
    rewatch(files: string[]): void {
      const next = new Set(files);
      for (const f of [...baselines.keys()]) if (!next.has(f)) baselines.delete(f);
      for (const f of next) if (!baselines.has(f)) baselines.set(f, fingerprint(f));
      if (!timer && baselines.size > 0) timer = setInterval(poll, intervalMs);
    },
    stop(): void {
      baselines.clear();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Start the hot-reload watcher shared by both servers: on any watched source
 * change, re-validate and swap the current generation (a validation failure
 * keeps the previous generation serving). `onReloaded` runs the per-server side
 * effect after a successful swap (e.g. MCP's `notifications/tools/list_changed`).
 * `nouns` phrases the two log lines so wording stays per-command.
 */
export function startReloadWatcher(
  ctx: ServerContext,
  nouns: { reloaded: string; keepPrevious: string },
  onReloaded?: (state: GenerationState) => void,
): { rewatch: (files: string[]) => void; stop: () => void } {
  const { command, inputAbs, workspaceRoot, tempRoot, extraEnv, generations, log } = ctx;
  const label = `jaiph ${command}`;
  let generation = 0;
  let reloading = false;
  const onSourceChange = (): void => {
    if (reloading) return;
    reloading = true;
    try {
      generation += 1;
      const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, label);
      if (!loaded.state) {
        log(`${label}: reload failed; keeping the previous ${nouns.keepPrevious}:`);
        for (const f of loaded.failures) log(`  ${f}`);
        return;
      }
      generations.swap(loaded.state);
      watcher.rewatch([...loaded.state.graph.modules.keys()]);
      onReloaded?.(loaded.state);
      log(`${label}: sources reloaded (${loaded.state.tools.length} ${nouns.reloaded})`);
    } catch (err) {
      log(`${label}: reload failed; keeping the previous ${nouns.keepPrevious}: ${errText(err)}`);
    } finally {
      reloading = false;
    }
  };
  const watcher = createSourceWatcher(WATCH_INTERVAL_MS, onSourceChange);
  watcher.rewatch([...generations.current().graph.modules.keys()]);
  return watcher;
}
