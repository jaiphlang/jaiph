// Fail-closed environment allowlist for prompt backend subprocesses
// (`runBackend` in ./prompt.ts). Trusted `run` steps keep the full workflow
// env; only what crosses to an agent is filtered here.
import { CHAIN_KEY_ENV } from "./emit";

/** Agent backends the runtime can execute prompts against. */
export type AgentBackend = "cursor" | "claude" | "codex";

/**
 * Enumerated credential keys forwarded to an agent per backend.
 * Only the keys for the run's resolved backends cross the boundary — the rest
 * of the `ANTHROPIC_*` / `CLAUDE_*` / `CURSOR_*` / `OPENAI_*` families stay
 * with the workflow process. Anything else goes through `--env` / `trusted_envs`
 * for trusted `run` steps. Must stay in sync with the credential pre-flight
 * (`src/cli/run/preflight-credentials.ts`) and docs/env-vars.md.
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
 * own credential keys). Everything else — including `--env`-injected secrets
 * like `GITHUB_TOKEN` — is dropped, fail-closed: credentials are for trusted
 * `run` steps, never for the model. `backend` is the raw configured value; an
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
