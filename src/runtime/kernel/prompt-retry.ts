/**
 * Retry policy for prompt-execution (transport) failures.
 *
 * Schema: a fixed sequence of delays (ms) to wait before each retry attempt.
 * `delays.length + 1` total attempts (1 initial + N retries). Schedule the
 * default sequence escalates: 15s, 1m, 10m, 30m, 2h — total ~2h41m wall-clock
 * for a full failure run. Under Docker the container timeout
 * (`runtime.docker_timeout_seconds`, default 3600s) caps this; raise it via
 * the metadata key or JAIPH_DOCKER_TIMEOUT for workflows that need the full
 * retry budget inside a sandbox.
 */
export const DEFAULT_PROMPT_RETRY_DELAYS_MS: readonly number[] = [
  15_000,
  60_000,
  600_000,
  1_800_000,
  7_200_000,
];

/**
 * Resolve the retry delay schedule from environment.
 *
 * - JAIPH_PROMPT_RETRY=0 → disable retries (returns []).
 * - JAIPH_PROMPT_RETRY_DELAYS="15000,60000" → override schedule (comma list of ms).
 * - Otherwise → DEFAULT_PROMPT_RETRY_DELAYS_MS.
 *
 * Throws on invalid input (non-numeric entries, negative values) so the
 * misconfiguration surfaces as a clear step error rather than silently
 * falling back to the default.
 */
export function resolvePromptRetryDelays(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number[] {
  const disable = env.JAIPH_PROMPT_RETRY;
  if (disable !== undefined && disable.trim() === "0") {
    return [];
  }
  const raw = env.JAIPH_PROMPT_RETRY_DELAYS;
  if (raw === undefined || raw.trim() === "") {
    return [...DEFAULT_PROMPT_RETRY_DELAYS_MS];
  }
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(
      `JAIPH_PROMPT_RETRY_DELAYS is set but has no delay entries; expected comma-separated ms (e.g. "15000,60000") or unset`,
    );
  }
  const delays: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) {
      throw new Error(
        `JAIPH_PROMPT_RETRY_DELAYS contains invalid entry "${part}"; expected non-negative integers (ms)`,
      );
    }
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `JAIPH_PROMPT_RETRY_DELAYS contains invalid entry "${part}"; expected non-negative integers (ms)`,
      );
    }
    delays.push(n);
  }
  return delays;
}

/**
 * setTimeout-based sleep that races against an AbortSignal. When the signal
 * fires, the pending timer is cleared and the promise rejects with an
 * abort-marked Error so the retry loop exits promptly without further
 * executePrompt calls.
 */
export function defaultPromptSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PromptRetryAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new PromptRetryAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PromptRetryAbortError extends Error {
  constructor() {
    super("prompt retry aborted");
    this.name = "PromptRetryAbortError";
  }
}

export function isPromptRetryAbortError(err: unknown): err is PromptRetryAbortError {
  return err instanceof PromptRetryAbortError;
}

/** Render a backoff delay for human log messages (e.g. "15s", "1m", "2h"). */
export function formatRetryDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/** Single-line summary of an error string for log messages. */
export function summarizeError(err: string): string {
  const trimmed = err.trim();
  if (trimmed.length === 0) return "(no error message)";
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  if (firstLine.length === 0) return "(no error message)";
  const MAX = 200;
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine;
}
