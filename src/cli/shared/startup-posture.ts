import { join } from "node:path";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectMcpSandboxMode,
  resolveDockerHostRunsRoot,
  isRunningInContainer,
  type DockerRunConfig,
  type SandboxMode,
} from "../../runtime";
import { resolveModuleMetadata } from "../../config";
import { resolveRuntimeEnv, applySandboxFlags, isUnsafeHostOnly } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import type { GenerationState } from "./generation-state";

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
