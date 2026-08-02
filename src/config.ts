import type { EnvDeclDef, WorkflowMetadata } from "./types";
import { configValueHasInterpolation } from "./parser";

/**
 * Substitute `${var}` / `${var.field}` references with their resolved values.
 *
 * When `quoteValue` is supplied, every substituted value is passed through it
 * first. Shell-fallthrough lines pass `shellQuote` here so caller-controlled
 * values (params, captures, `for_lines` iterators, channel payloads) are
 * escaped before they reach `sh -c`, and can never introduce command
 * substitution or shell metacharacter breakouts. Non-shell positions
 * (const/return/send/say/prompt) omit it and keep the raw value.
 *
 * Lives here (config layer) rather than under `runtime/` so config resolution
 * can reuse it without importing upward into the runtime; the runtime imports
 * it downward through `runtime-arg-parser`.
 */
export function interpolate(
  input: string,
  vars: Map<string, string>,
  env?: NodeJS.ProcessEnv,
  quoteValue?: (s: string) => string,
): string {
  const lookup = (key: string): string => vars.get(key) ?? env?.[key] ?? "";
  const q = quoteValue ?? ((s: string) => s);
  return input.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\}/g, (_m, base, field) => {
    if (!field) return q(lookup(String(base)));
    // Dot field access: parse JSON stored in the base variable and extract the field.
    const raw = lookup(String(base));
    try {
      const obj = JSON.parse(raw);
      return q(obj != null && typeof obj === "object" && field in obj ? String(obj[field]) : "");
    } catch {
      return q("");
    }
  });
}

export type JaiphConfig = {
  agent?: {
    model?: string;
    command?: string;
    backend?: "cursor" | "claude" | "codex";
    trustedWorkspace?: string;
    cursorFlags?: string;
    claudeFlags?: string;
  };
  run?: {
    debug?: boolean;
    logsDir?: string;
  };
};

/** Convert in-file workflow metadata to JaiphConfig shape for runtime env resolution. */
export function metadataToConfig(metadata: WorkflowMetadata | undefined): JaiphConfig {
  if (!metadata) {
    return {};
  }
  const cfg: JaiphConfig = {};
  if (metadata.agent) {
    cfg.agent = { ...metadata.agent };
  }
  if (metadata.run) {
    cfg.run = { ...metadata.run };
  }
  return cfg;
}

/** Resolve module-level `config { }` string interpolation from module `const` values and env. */
export function resolveModuleMetadata(
  mod: { metadata?: WorkflowMetadata; envDecls?: EnvDeclDef[] },
  env?: NodeJS.ProcessEnv,
): WorkflowMetadata | undefined {
  if (!mod.metadata) return undefined;
  const vars = buildConstVars(mod.envDecls, undefined, env);
  return interpolateWorkflowMetadata(mod.metadata, vars, env);
}

function interpolateStringField(
  value: string,
  vars: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): string {
  return configValueHasInterpolation(value) ? interpolate(value, vars, env) : value;
}

/** Build a variable map from module-level `const` declarations (with chained interpolation). */
export function buildConstVars(
  envDecls: EnvDeclDef[] | undefined,
  parent?: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): Map<string, string> {
  const vars = new Map<string, string>(parent ? Array.from(parent.entries()) : []);
  if (!envDecls) return vars;
  for (const decl of envDecls) {
    vars.set(decl.name, interpolate(decl.value, vars, env));
  }
  return vars;
}

/** Resolve `${…}` references in workflow/module metadata string fields. */
export function interpolateWorkflowMetadata(
  metadata: WorkflowMetadata,
  vars: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): WorkflowMetadata {
  const out: WorkflowMetadata = {};
  if (metadata.agent) {
    out.agent = {};
    if (metadata.agent.model !== undefined) {
      out.agent.model = interpolateStringField(metadata.agent.model, vars, env);
    }
    if (metadata.agent.command !== undefined) {
      out.agent.command = interpolateStringField(metadata.agent.command, vars, env);
    }
    if (metadata.agent.backend !== undefined) {
      out.agent.backend = interpolateStringField(metadata.agent.backend, vars, env) as
        | "cursor"
        | "claude"
        | "codex";
    }
    if (metadata.agent.trustedWorkspace !== undefined) {
      out.agent.trustedWorkspace = interpolateStringField(metadata.agent.trustedWorkspace, vars, env);
    }
    if (metadata.agent.cursorFlags !== undefined) {
      out.agent.cursorFlags = interpolateStringField(metadata.agent.cursorFlags, vars, env);
    }
    if (metadata.agent.claudeFlags !== undefined) {
      out.agent.claudeFlags = interpolateStringField(metadata.agent.claudeFlags, vars, env);
    }
  }
  if (metadata.run) {
    out.run = { ...metadata.run };
    if (metadata.run.logsDir !== undefined) {
      out.run.logsDir = interpolateStringField(metadata.run.logsDir, vars, env);
    }
  }
  if (metadata.runtime) {
    out.runtime = { ...metadata.runtime };
    if (metadata.runtime.dockerImage !== undefined) {
      out.runtime.dockerImage = interpolateStringField(metadata.runtime.dockerImage, vars, env);
    }
    if (metadata.runtime.dockerNetwork !== undefined) {
      out.runtime.dockerNetwork = interpolateStringField(metadata.runtime.dockerNetwork, vars, env);
    }
  }
  // trusted_envs keys are literal env var names — never interpolated.
  if (metadata.trustedEnvs) {
    out.trustedEnvs = [...metadata.trustedEnvs];
  }
  if (metadata.module) {
    out.module = {};
    if (metadata.module.name !== undefined) {
      out.module.name = interpolateStringField(metadata.module.name, vars, env);
    }
    if (metadata.module.version !== undefined) {
      out.module.version = interpolateStringField(metadata.module.version, vars, env);
    }
    if (metadata.module.description !== undefined) {
      out.module.description = interpolateStringField(metadata.module.description, vars, env);
    }
  }
  return out;
}
