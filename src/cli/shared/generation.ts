import { mkdirSync, rmSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { loadModuleGraph, writeModuleGraph, type ModuleGraph } from "../../transpile/module-graph";
import { buildScriptsFromGraph, collectDiagnostics } from "../../transpiler";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectMcpSandboxMode,
  resolveDockerHostRunsRoot,
  isRunningInContainer,
  type DockerRunConfig,
  type SandboxMode,
} from "../../runtime/docker";
import { resolveRuntimeEnv, applySandboxFlags, isUnsafeHostOnly, type SandboxFlags } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import { loadMergedHooks, isProjectHooksTrusted } from "../run/hooks";
import { deriveTools, type McpToolSpec } from "../mcp/tools";
import type { WorkflowCallEnvironment } from "../exec/call";

/** How often `watchFile` polls module sources for hot reload (ms). */
export const WATCH_INTERVAL_MS = 750;

/** Everything one generation of a workflow server needs to serve + call. */
export interface GenerationState {
  graph: ModuleGraph;
  tools: McpToolSpec[];
  callEnv: WorkflowCallEnvironment;
}

/**
 * Load (or reload) everything one generation of a workflow server needs:
 * module graph, compile-time validation, tool derivation, emitted scripts, and
 * the serialized graph the spawned runners consume. Shared by `jaiph mcp` and
 * `jaiph serve`. Throws on parse/loader errors; returns diagnostics without
 * throwing on validation errors.
 */
export function loadGeneration(
  inputAbs: string,
  workspaceRoot: string,
  tempRoot: string,
  generation: number,
  extraEnv: Record<string, string>,
  log: (line: string) => void,
  label: string,
  sandboxFlags: SandboxFlags = {},
): { state?: GenerationState; failures: string[] } {
  const graph = loadModuleGraph(inputAbs, workspaceRoot);
  const diag = collectDiagnostics(graph);
  if (diag.errors.length > 0) {
    return {
      failures: diag.sorted().map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`),
    };
  }

  const mod = graph.modules.get(inputAbs)!.ast;
  const { tools, warnings } = deriveTools(mod, inputAbs);
  for (const w of warnings) log(`${label}: ${w}`);

  const outDir = join(tempRoot, `gen-${generation}`);
  mkdirSync(outDir, { recursive: true });
  const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
  const graphFile = join(outDir, ".jaiph-module-graph.json");
  writeModuleGraph(graphFile, graph);

  const resolvedModuleMetadata = resolveModuleMetadata(mod, process.env);
  const effectiveConfig = metadataToConfig(resolvedModuleMetadata);

  // Hooks reload with the generation, so a hooks.json edit is picked up on the
  // next source change like every other per-generation input. Project-local
  // hooks stay gated behind the per-workspace trust opt-in (finding M-10); the
  // server reads it from the host env, the same as `jaiph run`.
  const hooks = loadMergedHooks(workspaceRoot, isProjectHooksTrusted(process.env));

  return {
    state: {
      graph,
      tools,
      callEnv: { inputAbs, workspaceRoot, mod, effectiveConfig, scriptsDir, graphFile, outDir, extraEnv, sandboxFlags, hooks },
    },
    failures: [],
  };
}

/** One live generation with the refcount that keeps its scripts dir alive. */
interface LiveGeneration {
  state: GenerationState;
  refs: number;
  superseded: boolean;
}

/** A lease on one generation, held by one in-flight call. */
export interface GenerationLease {
  /** The generation live when the call started; stable for the call's lifetime. */
  state: GenerationState;
  /** Settle the lease (idempotent). The last release of a superseded generation deletes its out dir. */
  release: () => void;
}

export interface GenerationTracker {
  /** The generation new calls should bind to. */
  current: () => GenerationState;
  /** Lease the current generation for one call; release when the call settles. */
  acquire: () => GenerationLease;
  /** Install a new generation; the previous one is deleted once its last lease settles. */
  swap: (next: GenerationState) => void;
}

/**
 * Refcounted generation lifecycle shared by `jaiph mcp` and `jaiph serve`. A
 * hot reload must not delete the superseded generation's out dir (emitted
 * scripts + serialized graph) while a call started under it is still running —
 * the runner spawns each script step from that dir for the whole run. Calls
 * lease the generation live at call start; a superseded generation's dir is
 * removed only when its last lease is released (immediately on swap when idle).
 */
export function createGenerationTracker(initial: GenerationState): GenerationTracker {
  let current: LiveGeneration = { state: initial, refs: 0, superseded: false };
  const maybeDelete = (gen: LiveGeneration): void => {
    if (gen.superseded && gen.refs === 0) {
      rmSync(gen.state.callEnv.outDir, { recursive: true, force: true });
    }
  };
  return {
    current: () => current.state,
    acquire(): GenerationLease {
      const gen = current;
      gen.refs += 1;
      let released = false;
      return {
        state: gen.state,
        release(): void {
          if (released) return;
          released = true;
          gen.refs -= 1;
          maybeDelete(gen);
        },
      };
    },
    swap(next: GenerationState): void {
      const prev = current;
      current = { state: next, refs: 0, superseded: false };
      prev.superseded = true;
      maybeDelete(prev);
    },
  };
}

/** Startup sandbox posture of a workflow server, resolved once and applied to every call. */
export interface StartupPosture {
  dockerConfig: DockerRunConfig;
  sandboxMode: SandboxMode;
  hostRunsRoot: string;
  /** True when Docker is off *because of* the unsafe opt-in (not config/platform). */
  unsafeHostOnly: boolean;
}

/**
 * Resolve the shared startup sandbox posture for a workflow server (`jaiph mcp`
 * and `jaiph serve`): sandbox flags normalized into env (`jaiph run` semantics —
 * a flag/env posture conflict throws `E_FLAG_CONFLICT` here, before anything is
 * spawned), the env-driven Docker selection, a one-time image preparation when
 * Docker is on, and the credential pre-flight (demoted to warnings — the server
 * may outlive a credential fix). Throws when Docker is enabled but unavailable /
 * the image can't be prepared; the caller turns that into an exit-1. Returns the
 * resolved posture so the caller can print the startup notice and apply the same
 * posture to every call.
 */
export function resolveStartupPosture(
  state: GenerationState,
  inputAbs: string,
  workspaceRoot: string,
  log: (line: string) => void,
): StartupPosture {
  const mod = state.graph.modules.get(inputAbs)!.ast;
  const startupEnv = resolveRuntimeEnv(state.callEnv.effectiveConfig, workspaceRoot, inputAbs);
  applySandboxFlags(startupEnv, state.callEnv.sandboxFlags ?? {});
  const dockerConfig = resolveDockerConfig(resolveModuleMetadata(mod, process.env)?.runtime, startupEnv);
  if (dockerConfig.enabled) {
    // Prepare the image once here rather than per call (a cold pull is slow).
    checkDockerAvailable();
    prepareImage(dockerConfig);
  }
  const sandboxMode = selectMcpSandboxMode(startupEnv);
  const unsafeHostOnly = isUnsafeHostOnly(dockerConfig.enabled, startupEnv);
  // Consent gate for the long-lived server modes (finding M-1). `jaiph run`
  // confirms unsafe host-only interactively; a server has no prompt, so the
  // consent is an explicit `--unsafe` / `--yes` on this command line. An
  // ambient `JAIPH_UNSAFE=true` inherited from the shell (e.g. left over from a
  // prior host-only `jaiph run`) is NOT consent and is refused here, before any
  // tool call can run unsandboxed. Inside a container the container itself is
  // the sandbox (the runtime image bakes JAIPH_UNSAFE=true), so an inherited
  // value is the documented standalone posture — allowed, mirroring `jaiph run`.
  if (unsafeHostOnly) {
    const flags = state.callEnv.sandboxFlags ?? {};
    if (!flags.unsafe && !flags.yes && !isRunningInContainer()) {
      throw new Error(
        "E_UNSAFE_NO_CONSENT jaiph mcp / jaiph serve refuses host-only execution requested only by an " +
          "inherited JAIPH_UNSAFE=true. Pass --unsafe (or --yes) on the command line to explicitly consent " +
          "to running every call on the host with no sandbox.",
      );
    }
  }
  // Credential pre-flight once at startup (warnings only: the server may outlive
  // a credential fix, and per-call failures still surface).
  const credPreflight = preflightAgentCredentials({
    mod,
    inputAbs,
    runtimeEnv: startupEnv,
    dockerEnabled: dockerConfig.enabled,
  });
  for (const w of [...credPreflight.warnings, ...credPreflight.errors]) log(w);
  // Host-visible runs root (same formula the runtime uses to place a run dir).
  // Docker keeps it within the workspace so the bind mount can expose it; host
  // mode allows an out-of-workspace absolute `JAIPH_RUNS_DIR`.
  const hostRunsRoot = dockerConfig.enabled
    ? resolveDockerHostRunsRoot(workspaceRoot, startupEnv)
    : resolveHostRunsRoot(workspaceRoot, startupEnv);
  return { dockerConfig, sandboxMode, hostRunsRoot, unsafeHostOnly };
}

/**
 * Print the effective sandbox posture once at server startup — the single
 * notice both `jaiph serve` and `jaiph mcp` emit, so the wording (and the
 * consent story it states) cannot drift between modes. `noun` names what the
 * server executes ("runs" for HTTP, "tool calls" for MCP).
 */
export function logStartupPosture(
  label: string,
  noun: string,
  posture: StartupPosture,
  workspaceRoot: string,
  log: (line: string) => void,
): void {
  if (posture.dockerConfig.enabled) {
    if (posture.sandboxMode === "inplace") {
      log(
        `${label}: ${noun} execute in a Docker sandbox in-place on ${workspaceRoot} ` +
          "(inplace opt-in: effects land live on the workspace).",
      );
    } else {
      log(`${label}: ${noun} execute in a Docker sandbox (${posture.sandboxMode} mode; workspace isolated).`);
    }
  } else if (posture.unsafeHostOnly) {
    for (const line of formatUnsafeServerBanner(label, noun)) log(line);
  } else {
    log(`${label}: ${noun} execute on the host with no sandbox.`);
  }
}

/**
 * Loud, multi-line startup banner for unsafe host-only server mode (finding
 * M-1). Replaces the single stderr notice so an operator cannot miss that every
 * call runs on the host with no sandbox — full filesystem and credential access.
 * Emitted only after the consent gate in `resolveStartupPosture` has confirmed
 * an explicit `--unsafe` / `--yes` (or an in-container standalone posture).
 */
export function formatUnsafeServerBanner(label: string, noun: string): string[] {
  const bar = "=".repeat(72);
  return [
    bar,
    `⚠️  ${label}: UNSAFE MODE — SANDBOXING DISABLED`,
    `    ${noun} execute on the host with no sandbox: full filesystem and host`,
    "    environment access, including credentials. No isolation.",
    bar,
  ];
}

/** Host runs root: absolute `JAIPH_RUNS_DIR` as-is, relative under the workspace, else `.jaiph/runs`. */
function resolveHostRunsRoot(workspaceRoot: string, env: Record<string, string | undefined>): string {
  const configured = env.JAIPH_RUNS_DIR;
  if (configured && configured.length > 0) {
    return configured.startsWith("/") ? configured : join(workspaceRoot, configured);
  }
  return join(workspaceRoot, ".jaiph", "runs");
}

/**
 * A `watchFile`-based source watcher shared by `jaiph mcp` and `jaiph serve`.
 * `rewatch(files)` reconciles the watched set to `files` (unwatch only those
 * that left, watch only those that arrived) so each hot reload re-derives the
 * file list from the current module graph; `stop()` unwatches everything on
 * shutdown. The `onChange` callback is the single listener registered against
 * every file, so unwatch matches watch exactly.
 *
 * A file that survives a reload keeps its existing `watchFile` untouched:
 * re-watching resets `watchFile`'s baseline, which it captures with an
 * asynchronous initial stat that fires no callback — so an edit landing before
 * that stat completes would be silently absorbed into the new baseline and
 * never detected. Leaving persistent files alone keeps their live baseline
 * (and the poll that catches the next edit) intact.
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
