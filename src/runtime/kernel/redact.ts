/**
 * Credential redaction shared by every surface that persists or returns
 * workflow output: the durable `run_summary.jsonl` writes in
 * `RuntimeEventEmitter` — which the OTLP export (`otlp.ts`), the Sentry export
 * (`sentry.ts`), and `GET /v1/runs/{id}/events` (`handler.ts`) all read back
 * verbatim — and the call-result text composed for `jaiph serve` and
 * `jaiph mcp` (`src/cli/exec/call.ts`). One definition of "credential" keeps the
 * journal, telemetry, HTTP, and MCP surfaces in agreement.
 *
 * Detection is name-based: a value is redacted only when its env key looks like
 * a credential (`isCredentialKey`). For each such value we redact the raw value
 * and its common re-encodings (base64, base64url, hex, URL-encoded), so a secret
 * that has been transported through one of those canonical forms is still caught.
 *
 * Explicit non-guarantee: redaction is literal-substring replacement of the
 * value and the known encodings above. A secret that is transformed some other
 * way — split across output chunks, JSON-string-escaped, gzipped, re-chunked, or
 * embedded as the password inside an opaque connection string (e.g. a
 * `DATABASE_URL`, whose key name does not itself look like a credential) — is
 * NOT guaranteed to be redacted. Treat the raw per-step capture files, and the
 * run directory as a whole, as sensitive regardless.
 */

// Case-insensitive substrings that mark a key as credential-bearing. Substring
// (not suffix) matching is deliberate: it catches `AWS_SECRET_ACCESS_KEY`,
// `AWS_ACCESS_KEY_ID`, `STRIPE_SECRET_KEY`, `SSH_PRIVATE_KEY`, and
// `SERVICE_CREDENTIALS` that a suffix rule misses.
const CREDENTIAL_KEY_SUBSTRINGS = [
  "SECRET",
  "PASSWORD",
  "PASSPHRASE",
  "TOKEN",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "API_KEY",
  "CREDENTIAL",
] as const;

// Short markers that would over-match as substrings (`PATH` contains `PAT`), so
// they only count as credential-bearing at the end of the key.
const CREDENTIAL_KEY_SUFFIXES = ["_PAT", "_DSN"] as const;

/**
 * Minimum credential value length to redact. Lowered from the original 8 so
 * short secrets are covered; a small floor still avoids turning 1-3 char values
 * (which collide with ordinary output tokens) into blanket redaction.
 */
const MIN_CREDENTIAL_VALUE_LEN = 4;

export function isCredentialKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (CREDENTIAL_KEY_SUBSTRINGS.some((s) => upper.includes(s))) return true;
  return CREDENTIAL_KEY_SUFFIXES.some((s) => upper.endsWith(s));
}

/**
 * Every canonical re-encoding of a secret value we scan for, longest-first so a
 * padded base64 form is replaced before its unpadded base64url prefix. Forms
 * shorter than the floor are dropped (short encodings collide with plain text).
 */
function credentialForms(value: string): string[] {
  const buf = Buffer.from(value, "utf8");
  const forms = [
    value,
    buf.toString("base64"),
    buf.toString("base64url"),
    buf.toString("hex"),
    encodeURIComponent(value),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of forms) {
    if (f.length < MIN_CREDENTIAL_VALUE_LEN || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Replace each credential env value found in `text` — and its base64 /
 * base64url / hex / URL-encoded forms — with `[REDACTED]`. See the module header
 * for the literal-substring non-guarantee.
 */
export function redactCredentials(text: string, env: NodeJS.ProcessEnv): string {
  let result = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_CREDENTIAL_VALUE_LEN || !isCredentialKey(key)) continue;
    for (const form of credentialForms(value)) {
      result = result.split(form).join("[REDACTED]");
    }
  }
  return result;
}
