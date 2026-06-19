import type {
  CatchBody,
  Expr,
  jaiphModule,
  WorkflowStepDef,
} from "../../types";
import { isEnvAllowed } from "../../runtime/docker";

export const E_AGENT_CREDENTIALS = "E_AGENT_CREDENTIALS";

type Backend = "cursor" | "claude" | "codex";

interface BackendUsage {
  backend: Backend;
  /** Human-readable scope: "module config" | "workflow <name>" | "default" | "JAIPH_AGENT_BACKEND env". */
  scope: string;
  /** Model from the same scope, falling back to module-level model. */
  model?: string;
}

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

export interface PreflightArgs {
  mod: jaiphModule;
  inputAbs: string;
  runtimeEnv: Record<string, string | undefined>;
  dockerEnabled: boolean;
}

/**
 * Collect each distinct backend declared in the entry file plus the effective
 * default backend. Order: module-level (if set), workflow-level (in source order,
 * skipping duplicates), then the effective default (skipped if already seen).
 *
 * Deeper per-import-module backend overrides resolved at runtime are out of scope
 * here — entry-file scan is the documented contract for this pre-flight.
 */
function collectBackendUsages(
  mod: jaiphModule,
  runtimeEnv: Record<string, string | undefined>,
): BackendUsage[] {
  const seen = new Map<Backend, BackendUsage>();
  const moduleBackend = mod.metadata?.agent?.backend;
  const moduleModel = mod.metadata?.agent?.defaultModel;
  if (moduleBackend) {
    seen.set(moduleBackend, {
      backend: moduleBackend,
      scope: "module config",
      model: moduleModel,
    });
  }
  for (const wf of mod.workflows) {
    const wfBackend = wf.metadata?.agent?.backend;
    if (!wfBackend || seen.has(wfBackend)) continue;
    const wfModel = wf.metadata?.agent?.defaultModel ?? moduleModel;
    seen.set(wfBackend, {
      backend: wfBackend,
      scope: `workflow ${wf.name}`,
      model: wfModel,
    });
  }
  const envBackendRaw = runtimeEnv.JAIPH_AGENT_BACKEND;
  const defaultBackend = (envBackendRaw || "cursor") as Backend;
  if (!seen.has(defaultBackend)) {
    const scope = envBackendRaw ? "JAIPH_AGENT_BACKEND env" : "default";
    seen.set(defaultBackend, { backend: defaultBackend, scope, model: moduleModel });
  }
  return [...seen.values()];
}

/**
 * True when `key` is set to a non-empty value in the env that will actually
 * reach the agent. When Docker is on, the host-side allowlist (`isEnvAllowed`)
 * runs first — a credential present on the host but not on the allowlist is
 * treated as missing because the container will never see it.
 */
function hasCredential(
  env: Record<string, string | undefined>,
  key: string,
  dockerEnabled: boolean,
): boolean {
  if (dockerEnabled && !isEnvAllowed(key)) return false;
  const v = env[key];
  return typeof v === "string" && v.length > 0;
}

function formatHeader(usage: BackendUsage, inputAbs: string): string {
  const modelPart = usage.model ? ` (model "${usage.model}")` : "";
  return `agent.backend "${usage.backend}"${modelPart} selected by ${usage.scope} in ${inputAbs}`;
}

function dockerSuffix(dockerEnabled: boolean): string {
  return dockerEnabled
    ? " (Docker is on — set the env var on the host so it is forwarded into the container.)"
    : "";
}

function checkClaude(
  usage: BackendUsage,
  args: PreflightArgs,
  out: PreflightResult,
): void {
  const ok =
    hasCredential(args.runtimeEnv, "ANTHROPIC_API_KEY", args.dockerEnabled) ||
    hasCredential(args.runtimeEnv, "CLAUDE_CODE_OAUTH_TOKEN", args.dockerEnabled);
  if (ok) return;
  const header = formatHeader(usage, args.inputAbs);
  const remedy =
    "Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or set ANTHROPIC_API_KEY.";
  if (args.dockerEnabled) {
    out.errors.push(
      `${E_AGENT_CREDENTIALS}: ${header} — neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. ${remedy}${dockerSuffix(true)}`,
    );
  } else {
    out.warnings.push(
      `jaiph: warning: ${header} — neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. ${remedy} A stored Claude CLI login may still work.`,
    );
  }
}

function checkCursor(
  usage: BackendUsage,
  args: PreflightArgs,
  out: PreflightResult,
): void {
  if (hasCredential(args.runtimeEnv, "CURSOR_API_KEY", args.dockerEnabled)) return;
  const header = formatHeader(usage, args.inputAbs);
  const remedy =
    "Set CURSOR_API_KEY (or run `cursor-agent login` for host runs).";
  if (args.dockerEnabled) {
    out.errors.push(
      `${E_AGENT_CREDENTIALS}: ${header} — CURSOR_API_KEY is not set. ${remedy}${dockerSuffix(true)}`,
    );
  } else {
    out.warnings.push(
      `jaiph: warning: ${header} — CURSOR_API_KEY is not set. ${remedy} A stored cursor-agent login may still work.`,
    );
  }
}

function checkCodex(
  usage: BackendUsage,
  args: PreflightArgs,
  out: PreflightResult,
): void {
  if (hasCredential(args.runtimeEnv, "OPENAI_API_KEY", args.dockerEnabled)) return;
  const header = formatHeader(usage, args.inputAbs);
  const remedy = "Set OPENAI_API_KEY to your OpenAI API key.";
  out.errors.push(
    `${E_AGENT_CREDENTIALS}: ${header} — OPENAI_API_KEY is not set. ${remedy}${dockerSuffix(args.dockerEnabled)}`,
  );
}

function exprIsPrompt(e: Expr): boolean {
  return e.kind === "prompt";
}

function catchBodyHasPrompt(c: CatchBody): boolean {
  if ("single" in c) return stepHasPrompt(c.single);
  return c.block.some(stepHasPrompt);
}

function stepHasPrompt(s: WorkflowStepDef): boolean {
  switch (s.type) {
    case "exec":
      if (exprIsPrompt(s.body)) return true;
      if (s.catch && catchBodyHasPrompt(s.catch)) return true;
      if (s.recover && catchBodyHasPrompt(s.recover)) return true;
      return false;
    case "const":
      return exprIsPrompt(s.value);
    case "return":
      return exprIsPrompt(s.value);
    case "send":
      return exprIsPrompt(s.value);
    case "say":
      return exprIsPrompt(s.message);
    case "if":
      return s.body.some(stepHasPrompt) || (s.elseBody?.some(stepHasPrompt) ?? false);
    case "for_lines":
      return s.body.some(stepHasPrompt);
    case "trivia":
      return false;
  }
}

/** True when any workflow or rule in the entry file contains a `prompt` step. */
function entryFileUsesPrompt(mod: jaiphModule): boolean {
  for (const wf of mod.workflows) {
    if (wf.steps.some(stepHasPrompt)) return true;
  }
  for (const rule of mod.rules) {
    if (rule.steps.some(stepHasPrompt)) return true;
  }
  return false;
}

/** True when the entry file declares an agent backend at any config scope. */
function entryFileHasExplicitBackend(mod: jaiphModule): boolean {
  if (mod.metadata?.agent?.backend) return true;
  return mod.workflows.some((wf) => Boolean(wf.metadata?.agent?.backend));
}

/**
 * Host-side credential check, keyed to the backend(s) the entry file selects.
 *
 * Rules per task spec:
 *  - codex   → hard error on host AND Docker (no CLI-login fallback).
 *  - claude  → Docker: hard error; host: warn only (stored CLI login may work).
 *  - cursor  → Docker: hard error; host: warn only.
 *
 * Skip entirely when the entry file neither declares an explicit backend nor
 * uses any `prompt` step — there is nothing the runtime would credential against,
 * so a warning would be a false positive.
 *
 * Also skip entirely in unsafe mode (`JAIPH_UNSAFE` / `--unsafe`): that is the
 * explicit "run on the host, trust my environment" escape hatch, so neither the
 * host warnings nor the codex hard error should fire — a logged-in agent CLI
 * works, and the runtime backend guards remain as a backstop.
 */
export function preflightAgentCredentials(args: PreflightArgs): PreflightResult {
  const out: PreflightResult = { errors: [], warnings: [] };
  if (args.runtimeEnv.JAIPH_UNSAFE === "true") {
    return out;
  }
  if (!entryFileHasExplicitBackend(args.mod) && !entryFileUsesPrompt(args.mod)) {
    return out;
  }
  for (const usage of collectBackendUsages(args.mod, args.runtimeEnv)) {
    if (usage.backend === "codex") checkCodex(usage, args, out);
    else if (usage.backend === "claude") checkClaude(usage, args, out);
    else if (usage.backend === "cursor") checkCursor(usage, args, out);
  }
  return out;
}
