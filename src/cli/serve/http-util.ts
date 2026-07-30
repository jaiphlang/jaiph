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
