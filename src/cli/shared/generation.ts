import { mkdirSync, rmSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { loadModuleGraph, writeModuleGraph, type ModuleGraph } from "../../transpile/module-graph";
import { collectDiagnostics } from "../../transpile/validate";
import { buildScriptsFromGraph } from "../../transpiler";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectMcpSandboxMode,
  resolveDockerHostRunsRoot,
  type DockerRunConfig,
  type SandboxMode,
} from "../../runtime/docker";
import { resolveRuntimeEnv } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
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

  return {
    state: {
      graph,
      tools,
      callEnv: { inputAbs, workspaceRoot, mod, effectiveConfig, scriptsDir, graphFile, outDir, extraEnv },
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

/**
 * Resolve the shared startup sandbox posture for a workflow server (`jaiph mcp`
 * and `jaiph serve`): the env-driven Docker selection (`jaiph run` semantics),
 * a one-time image preparation when Docker is on, and the credential pre-flight
 * (demoted to warnings — the server may outlive a credential fix). Throws when
 * Docker is enabled but unavailable / the image can't be prepared; the caller
 * turns that into an exit-1. Returns the resolved config + sandbox mode so the
 * caller can print its own startup notice.
 */
export function resolveStartupPosture(
  state: GenerationState,
  inputAbs: string,
  workspaceRoot: string,
  log: (line: string) => void,
): { dockerConfig: DockerRunConfig; sandboxMode: SandboxMode; hostRunsRoot: string } {
  const mod = state.graph.modules.get(inputAbs)!.ast;
  const startupEnv = resolveRuntimeEnv(state.callEnv.effectiveConfig, workspaceRoot, inputAbs);
  const dockerConfig = resolveDockerConfig(resolveModuleMetadata(mod, process.env)?.runtime, startupEnv);
  if (dockerConfig.enabled) {
    // Prepare the image once here rather than per call (a cold pull is slow).
    checkDockerAvailable();
    prepareImage(dockerConfig);
  }
  const sandboxMode = selectMcpSandboxMode(startupEnv);
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
  return { dockerConfig, sandboxMode, hostRunsRoot };
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
 * `rewatch(files)` swaps the watched set (unwatch old, watch new) so each hot
 * reload re-derives the file list from the current module graph; `stop()`
 * unwatches everything on shutdown. The `onChange` callback is the single
 * listener registered against every file, so unwatch matches watch exactly.
 */
export function createSourceWatcher(
  intervalMs: number,
  onChange: () => void,
): { rewatch: (files: string[]) => void; stop: () => void } {
  let watched: string[] = [];
  return {
    rewatch(files: string[]): void {
      for (const f of watched) unwatchFile(f, onChange);
      watched = [...files];
      for (const f of watched) watchFile(f, { interval: intervalMs }, onChange);
    },
    stop(): void {
      for (const f of watched) unwatchFile(f, onChange);
      watched = [];
    },
  };
}
