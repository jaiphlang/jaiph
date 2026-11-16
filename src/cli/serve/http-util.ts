/** Parse a JSON object, returning null for non-objects or malformed input. */
export function safeJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Parse a query param as an integer, clamped to `[min, max]`. A missing or
 * malformed value falls back to `fallback` (itself already within range), so a
 * hostile `?limit=` can never widen the page beyond `max`.
 */
export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Decode one URL path segment, returning `null` for malformed percent-encoding
 * (`%zz`, a bare `%`) instead of letting `decodeURIComponent` throw a `URIError`.
 * A caller maps `null` to a normal `404` so a hand-crafted path is an ordinary
 * not-found, never a `500` with an operator error line per request.
 */
export function safeDecodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Accept a caller-supplied correlation/request id only when it is a short,
 * audit-safe token; otherwise return `null` so the caller generates a fresh id.
 * Restricting to `[A-Za-z0-9._:-]` (≤128 chars) means the value can carry no
 * whitespace, `=`, or newline, so it can never forge a `key=value` pair (or a
 * second line) in an operator/audit log built from `key=value` tails.
 */
export function safeCorrelationId(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim();
  if (clean.length === 0 || clean.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(clean) ? clean : null;
}

/**
 * Build a `Content-Disposition: attachment` value that is always a settable HTTP
 * header for any file name. Two forms are emitted:
 * - an ASCII `filename=` fallback — every byte outside printable ASCII (so
 *   `node:http` never throws `ERR_INVALID_CHAR` on a non-Latin1 or control
 *   char), plus `"` and `\`, is replaced by `_` so the quoted-string cannot be
 *   broken out of;
 * - an RFC 5987 `filename*=UTF-8''…` carrying the real UTF-8 name, percent-encoded,
 *   for clients that understand it.
 */
export function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** Percent-encode a string as an RFC 5987 `ext-value` (the part after `UTF-8''`). */
function encodeRfc5987(value: string): string {
  // encodeURIComponent leaves `-_.!~*'()` unescaped; of those `*'()` are not
  // RFC 5987 attr-chars, so encode them too (over-encoding the rest is valid).
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
