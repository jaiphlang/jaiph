// Fail-closed environment allowlists for the two subprocess boundaries:
// prompt backend subprocesses (`runBackend` in ./prompt.ts, via
// `scrubPromptEnv`) and script subprocesses (`NodeWorkflowRuntime`, via
// `buildScriptEnv`). Both start from nothing and forward only what is listed;
// a script additionally receives the host keys its `use` clause requests,
// intersected with the operator's `--env` grant (`JAIPH_ENV_GRANT`).
import { CHAIN_KEY_ENV } from "./emit";

/** Agent backends the runtime can execute prompts against. */
export type AgentBackend = "cursor" | "claude" | "codex";

/**
 * Enumerated credential keys forwarded to an agent per backend.
 * Only the keys for the run's resolved backends cross the boundary — the rest
 * of the `ANTHROPIC_*` / `CLAUDE_*` / `CURSOR_*` / `OPENAI_*` families stay
 * with the workflow process. Anything else reaches a script only through its
 * `use` clause plus the `--env` grant. Must stay in sync with the credential
 * pre-flight (`src/cli/run/preflight-credentials.ts`) and docs/env-vars.md.
 */
export const BACKEND_CREDENTIAL_KEYS: Record<AgentBackend, readonly string[]> = {
  cursor: ["CURSOR_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};

/**
 * Environment variable prefixes forwarded to a prompt agent. Only `JAIPH_*`
 * run-control keys are prefix-forwarded. Agent credentials are NOT
 * prefix-forwarded: only the enumerated per-backend keys in
 * `BACKEND_CREDENTIAL_KEYS` cross, and only for this prompt's backend.
 * Everything else is dropped — fail-closed by design.
 */
export const ENV_ALLOW_PREFIXES = ["JAIPH_"] as const;

/**
 * Host-only `jaiph serve` server keys (bearer token, OIDC config, run limits)
 * excluded from the allowlist. They start with `JAIPH_` but a prompt agent
 * never consumes them, and `JAIPH_SERVE_TOKEN` is the single-operator secret
 * authorising the whole HTTP API (`src/cli/commands/serve.ts`).
 * Forwarding it would let a workflow read the operator token and authenticate
 * back to the server, so the entire family stays out of agent subprocesses.
 */
export const ENV_ALLOW_EXCLUDE_SERVE_PREFIX = "JAIPH_SERVE_";

/** JAIPH_ prefixes carved out of the forwarding allowlist. */
export const ENV_ALLOW_EXCLUDE_PREFIXES = [ENV_ALLOW_EXCLUDE_SERVE_PREFIX] as const;

/**
 * Returns true if `key` may be forwarded to a prompt agent for a run that
 * resolved to `backends`. `JAIPH_*` run-control keys pass regardless of
 * backend (minus the exclusions); credential keys pass only when one of the
 * given backends needs them (`BACKEND_CREDENTIAL_KEYS`). An empty `backends`
 * forwards no credentials — fail-closed.
 */
export function isEnvAllowed(key: string, backends: readonly AgentBackend[]): boolean {
  if (ENV_ALLOW_EXCLUDE_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  // Guard the lookup: `backends` may carry an unrecognized JAIPH_AGENT_BACKEND
  // value at runtime, which forwards nothing rather than throwing.
  return backends.some((backend) => BACKEND_CREDENTIAL_KEYS[backend]?.includes(key) ?? false);
}

/**
 * Non-secret base environment a prompt agent subprocess still needs after the
 * credential scrub: process basics, locale, TLS trust / proxy settings, and
 * the Claude CLI config dir. Exact names, matched case-insensitively —
 * Windows env keys are case-insensitive and commonly arrive as e.g. `Path`.
 */
export const PROMPT_BASE_ENV_NAMES = new Set<string>([
  // POSIX process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "TMP", "TEMP", "TZ",
  // Locale
  "LANG", "LANGUAGE",
  // TLS trust + proxies (agent CLIs behind restricted networks)
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  // Claude CLI config/session location (user-set or added by prepareClaudeEnv)
  "CLAUDE_CONFIG_DIR",
  // Windows process basics (absent and harmless elsewhere)
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "ALLUSERSPROFILE", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
]);

/** Case-insensitive base-env prefixes (locale categories, XDG base dirs). */
export const PROMPT_BASE_ENV_PREFIXES = ["LC_", "XDG_"] as const;

function isPromptBaseEnv(key: string): boolean {
  const upper = key.toUpperCase();
  if (PROMPT_BASE_ENV_NAMES.has(upper)) return true;
  return PROMPT_BASE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Build the environment for a prompt agent subprocess: the base environment
 * (`PROMPT_BASE_ENV_NAMES`/`_PREFIXES`) plus whatever the allowlist forwards
 * for this backend (`isEnvAllowed`: `JAIPH_*` control keys and the backend's
 * own credential keys). Everything else — including `--env`-granted secrets
 * like `GITHUB_TOKEN` — is dropped, fail-closed: granted keys are for `use`
 * script steps, never for the model. `backend` is the raw configured value; an
 * unrecognized backend forwards no credentials.
 */
export function scrubPromptEnv(execEnv: NodeJS.ProcessEnv, backend: string): NodeJS.ProcessEnv {
  const backends = [backend as AgentBackend];
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(execEnv)) {
    if (value === undefined) continue;
    // The audit-chain HMAC key is a JAIPH_ control key the runner needs, but
    // it must never reach the agent itself — drop it here regardless.
    if (key === CHAIN_KEY_ENV) continue;
    if (isEnvAllowed(key, backends) || isPromptBaseEnv(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The `--env` grant hand-off: the CLI (`jaiph run` / `serve` / `mcp` / `test`)
 * writes the comma-separated key names it received via `--env KEY[=VALUE]`
 * into this runner-env variable. A script's `use` key is forwarded only when
 * it appears here — presence of the key on the host env alone is not a grant.
 */
export const ENV_GRANT_ENV = "JAIPH_ENV_GRANT";

/** Parse the `--env` grant key set from a runner env (absent/empty → no grant). */
export function parseEnvGrant(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[ENV_GRANT_ENV] ?? "";
  return new Set(raw.split(",").filter((k) => k.length > 0));
}

/**
 * Runtime contract keys every script subprocess receives — the documented
 * script-facing API surface (docs/env-vars.md), not secrets.
 * `JAIPH_AGENT_BACKEND` is the config-derived (not host-secret) backend name;
 * it is forwarded when scope has it so scripts can observe the effective,
 * config-scoped backend (see the metadata-scope contract tested by e2e 86/87).
 */
export const SCRIPT_CONTRACT_ENV_NAMES = [
  "JAIPH_WORKSPACE",
  "JAIPH_SCRIPTS",
  "JAIPH_RUN_DIR",
  "JAIPH_ARTIFACTS_DIR",
  "JAIPH_AGENT_BACKEND",
] as const;

/**
 * Build the sterile environment for a script subprocess (named script,
 * `import script`, or inline script):
 *  - the prompt base env (process mechanics: PATH, HOME, locale, TLS/proxy);
 *  - the script runtime contract keys (`SCRIPT_CONTRACT_ENV_NAMES`, incl. the
 *    config-scoped `JAIPH_AGENT_BACKEND` when scope has it), plus
 *    `JAIPH_AGENT_MODEL` kept defined (empty when unset) for `set -u` scripts;
 *  - the host keys requested by the script's `use` clause, intersected with
 *    the operator's `--env` grant; values resolve from `grantValues` (the
 *    pristine runner env snapshot), never from workflow scope mutations.
 * Nothing else is forwarded — no ambient host env, no agent credentials, and
 * never `JAIPH_CHAIN_KEY` / `JAIPH_RUN_SUMMARY_FILE` / `JAIPH_SERVE_*`.
 */
export function buildScriptEnv(
  scopeEnv: NodeJS.ProcessEnv,
  useKeys: readonly string[] | undefined,
  grantKeys: ReadonlySet<string>,
  grantValues: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(scopeEnv)) {
    if (value === undefined) continue;
    if (isPromptBaseEnv(key)) out[key] = value;
  }
  for (const key of SCRIPT_CONTRACT_ENV_NAMES) {
    const value = scopeEnv[key];
    if (value !== undefined) out[key] = value;
  }
  out.JAIPH_AGENT_MODEL = scopeEnv.JAIPH_AGENT_MODEL ?? "";
  for (const key of useKeys ?? []) {
    if (!grantKeys.has(key)) continue;
    const value = grantValues[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
