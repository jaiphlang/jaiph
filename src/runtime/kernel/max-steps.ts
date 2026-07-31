/**
 * Optional max-step circuit breaker for the workflow runtime.
 *
 * A runaway workflow — an unbounded `for` loop, a channel/recursion cycle, or a
 * self-referential `run` chain — otherwise has no automatic in-process bound
 * (the per-prompt idle watchdog only covers a single backend call). When
 * `JAIPH_MAX_STEPS` is set to a positive integer, the runtime counts every
 * executed (non-trivia) step across the whole run and aborts once the count
 * exceeds the cap. Unset, empty, non-numeric, or `<= 0` disables the breaker so
 * existing runs behave exactly as before.
 */
export function parseMaxSteps(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_MAX_STEPS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The error/log message emitted when the circuit breaker trips. */
export function maxStepsTrippedMessage(maxSteps: number): string {
  return (
    `E_MAX_STEPS circuit breaker: exceeded JAIPH_MAX_STEPS=${maxSteps} executed steps — ` +
    `aborting to stop a runaway workflow`
  );
}
