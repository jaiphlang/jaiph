import { existsSync, mkdtempSync, rmSync, statSync, unwatchFile, watchFile } from "node:fs";
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

/** How often `watchFile` polls module sources for hot reload (ms). */
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
 * A `watchFile`-based source watcher. `rewatch(files)` reconciles the watched
 * set to `files` (unwatch only those that left, watch only those that arrived);
 * `stop()` unwatches everything. The `onChange` callback is the single listener
 * registered against every file, so unwatch matches watch exactly.
 *
 * A file that survives a reload keeps its existing `watchFile` untouched:
 * re-watching resets `watchFile`'s baseline, which it captures with an
 * asynchronous initial stat that fires no callback — so an edit landing before
 * that stat completes would be silently absorbed into the new baseline and
 * never detected. Leaving persistent files alone keeps their live baseline intact.
 */
export function createSourceWatcher(
  intervalMs: number,
  onChange: () => void,
): { rewatch: (files: string[]) => void; stop: () => void } {
  let watched = new Set<string>();
  return {
    rewatch(files: string[]): void {
      const next = new Set(files);
      for (const f of watched) if (!next.has(f)) unwatchFile(f, onChange);
      for (const f of next) if (!watched.has(f)) watchFile(f, { interval: intervalMs }, onChange);
      watched = next;
    },
    stop(): void {
      for (const f of watched) unwatchFile(f, onChange);
      watched = new Set();
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
