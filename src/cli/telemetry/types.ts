/**
 * Shared telemetry types for the post-run export hook. Kept in their own leaf
 * module so both exporters (`otlp.ts` and `sentry.ts`) can import them without
 * an import cycle: `otlp.ts` calls into `sentry.ts` for the Sentry half, while
 * both only need these shapes — not each other's implementations.
 */

/** Options for the shared post-run export hook. */
export interface ExportRunTelemetryOptions {
  /** Absolute host run directory; its `run_summary.jsonl` is the export source. */
  runDir?: string;
  workflow: string;
  exitStatus: number;
  signal: string | null;
  env: NodeJS.ProcessEnv;
  /**
   * Authenticated caller identity for a `jaiph serve` run: surfaced as OTLP
   * resource attributes (`jaiph.principal`, `jaiph.correlation_id`) and Sentry
   * tags. Absent for `jaiph run` / anonymous callers. Never a token or a
   * secret-bearing claim.
   */
  identity?: { principal?: string; correlationId?: string };
}

/** Per-exporter delivery result — `sent`, `skipped` (disabled/no data), or `failed`. */
export type ExportOutcome = "sent" | "skipped" | "failed";
