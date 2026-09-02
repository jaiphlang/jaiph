import type {
  CatchBody,
  Expr,
  jaiphModule,
  StepDef,
} from "../../types";
import type { AgentBackend } from "../../runtime";

export const E_AGENT_CREDENTIALS = "E_AGENT_CREDENTIALS";

interface BackendUsage {
  backend: AgentBackend;
  /** Human-readable scope: "module config" | "def <name>" | "default" | "JAIPH_AGENT_BACKEND env". */
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
}

/**
 * Collect each distinct backend declared in the entry file plus the effective
 * default backend. Order: module-level (if set), def-level (in source order,
 * skipping duplicates), then the effective default (skipped if already seen).
 *
 * Deeper per-import-module backend overrides resolved at runtime are out of scope
 * here — entry-file scan is the documented contract for this pre-flight.
 */
function collectBackendUsages(
  mod: jaiphModule,
  runtimeEnv: Record<string, string | undefined>,
): BackendUsage[] {
  const seen = new Map<AgentBackend, BackendUsage>();
  const moduleBackend = mod.metadata?.agent?.backend;
  const moduleModel = mod.metadata?.agent?.model;
  if (moduleBackend) {
    seen.set(moduleBackend, {
      backend: moduleBackend,
      scope: "module config",
      model: moduleModel,
    });
  }
  for (const wf of mod.defs) {
    const wfBackend = wf.metadata?.agent?.backend;
    if (!wfBackend || seen.has(wfBackend)) continue;
    const wfModel = wf.metadata?.agent?.model ?? moduleModel;
    seen.set(wfBackend, {
      backend: wfBackend,
      scope: `def ${wf.name}`,
      model: wfModel,
    });
  }
  const envBackendRaw = runtimeEnv.JAIPH_AGENT_BACKEND;
  const defaultBackend = (envBackendRaw || "cursor") as AgentBackend;
  if (!seen.has(defaultBackend)) {
    const scope = envBackendRaw ? "JAIPH_AGENT_BACKEND env" : "default";
    seen.set(defaultBackend, { backend: defaultBackend, scope, model: moduleModel });
  }
  return [...seen.values()];
}

/**
 * True when `key` is set to a non-empty value in the env that will actually
 * reach the agent.
 */
function hasCredential(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const v = env[key];
  return typeof v === "string" && v.length > 0;
}

function formatHeader(usage: BackendUsage, inputAbs: string): string {
  const modelPart = usage.model ? ` (model "${usage.model}")` : "";
  return `agent.backend "${usage.backend}"${modelPart} selected by ${usage.scope} in ${inputAbs}`;
}

function checkCursor(
  usage: BackendUsage,
  args: PreflightArgs,
  out: PreflightResult,
): void {
  if (hasCredential(args.runtimeEnv, "CURSOR_API_KEY")) return;
  const header = formatHeader(usage, args.inputAbs);
  const remedy =
    "Set CURSOR_API_KEY (or run `cursor-agent login`).";
  out.warnings.push(
    `jaiph: warning: ${header} — CURSOR_API_KEY is not set. ${remedy} A stored cursor-agent login may still work.`,
  );
}

function checkCodex(
  usage: BackendUsage,
  args: PreflightArgs,
  out: PreflightResult,
): void {
  if (hasCredential(args.runtimeEnv, "OPENAI_API_KEY")) return;
  const header = formatHeader(usage, args.inputAbs);
  const remedy = "Set OPENAI_API_KEY to your OpenAI API key.";
  out.errors.push(
    `${E_AGENT_CREDENTIALS}: ${header} — OPENAI_API_KEY is not set. ${remedy}`,
  );
}

function exprIsPrompt(e: Expr): boolean {
  return e.kind === "prompt";
}

function catchBodyHasPrompt(c: CatchBody): boolean {
  if ("single" in c) return stepHasPrompt(c.single);
  return c.block.some(stepHasPrompt);
}

function stepHasPrompt(s: StepDef): boolean {
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
    case "local_decl":
      if (s.decl.kind === "prompt") return true;
      if (s.decl.kind === "def") return s.decl.def.steps.some(stepHasPrompt);
      return false;
    case "trivia":
      return false;
  }
}

/** True when any workflow or rule in the entry file contains a `prompt` step. */
function entryFileUsesPrompt(mod: jaiphModule): boolean {
  for (const wf of mod.defs) {
    if (wf.steps.some(stepHasPrompt)) return true;
  }
  return false;
}

/** True when the entry file declares an agent backend at any config scope. */
function entryFileHasExplicitBackend(mod: jaiphModule): boolean {
  if (mod.metadata?.agent?.backend) return true;
  return mod.defs.some((wf) => Boolean(wf.metadata?.agent?.backend));
}

/**
 * Host-side credential check, keyed to the backend(s) the entry file selects.
 *
 *  - codex   → hard error (no CLI-login fallback).
 *  - cursor  → warn only (stored CLI login may work).
 *  - claude  → no check (stored Claude CLI login is the host path).
 *
 * Skip entirely when the entry file neither declares an explicit backend nor
 * uses any `prompt` step — there is nothing the runtime would credential against,
 * so a warning would be a false positive.
 */
export function preflightAgentCredentials(args: PreflightArgs): PreflightResult {
  const out: PreflightResult = { errors: [], warnings: [] };
  if (!entryFileHasExplicitBackend(args.mod) && !entryFileUsesPrompt(args.mod)) {
    return out;
  }
  for (const usage of collectBackendUsages(args.mod, args.runtimeEnv)) {
    if (usage.backend === "codex") checkCodex(usage, args, out);
    else if (usage.backend === "cursor") checkCursor(usage, args, out);
  }
  return out;
}
