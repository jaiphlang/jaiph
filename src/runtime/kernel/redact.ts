/**
 * Credential redaction shared by every surface that persists or returns
 * workflow output: the durable `run_summary.jsonl` writes in
 * `RuntimeEventEmitter`, and the call-result text composed for `jaiph serve`
 * and `jaiph mcp` (`src/cli/exec/call.ts`). One definition of "credential"
 * keeps the journal, HTTP, and MCP surfaces in agreement.
 */

const CREDENTIAL_KEY_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET", "_API_TOKEN"] as const;

export function isCredentialKey(key: string): boolean {
  const upper = key.toUpperCase();
  return CREDENTIAL_KEY_SUFFIXES.some((s) => upper.endsWith(s));
}

/** Replace each credential env value (≥8 chars) found in `text` with [REDACTED]. */
export function redactCredentials(text: string, env: NodeJS.ProcessEnv): string {
  let result = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !isCredentialKey(key)) continue;
    result = result.split(value).join("[REDACTED]");
  }
  return result;
}
