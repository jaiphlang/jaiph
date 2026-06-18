# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Retry agent prompts on transient failure with escalating backoff #dev-ready

### Context

Agent prompts execute in `runPromptStep` (`src/runtime/kernel/node-workflow-runtime.ts`, ~lines 1204-1288). The backend (claude / cursor / codex) is invoked via `executePrompt(...)` (line ~1248, defined in `src/runtime/kernel/prompt.ts:499`). Today a backend failure surfaces as `result.status !== 0` (line ~1258) and `runPromptStep` immediately returns `{ ok: false, ... }`, which aborts the step (and, absent a `recover`/`catch`, the whole workflow). **There is no retry and no backoff** at the prompt-execution level (the existing `recover` construct at lines ~801-844 is a separate, user-authored, no-delay loop).

Agent backends fail transiently all the time — rate limits, API outages, network blips, the CLI crashing. This task adds automatic retry with an **escalating backoff schedule** around the prompt execution, and logs every failure and retry through the same facility as the `log`/`logerr` constructs.

### Behavior

- **What is retried:** only **execution/transport failure** — the `result.status !== 0` path where the backend process itself failed (spawn failure, non-zero exit, API/HTTP error from the codex backend). 
- **What is NOT retried:** deterministic post-processing failures in the same function — invalid JSON (`"prompt returned invalid JSON"`) and schema validation (`"prompt response failed schema validation"`). These fail identically on re-run; retrying them with multi-minute waits is pointless. They keep returning `{ ok: false }` immediately as today.
- **Backoff schedule (default):** after the initial attempt fails, wait and retry on this fixed sequence of delays, then give up:
  - `15s` → `1m` → `10m` → `30m` → `2h` → **terminate**.
  - That is 5 retry delays = up to **6 total attempts**. Represent as a constant delay array `[15_000, 60_000, 600_000, 1_800_000, 7_200_000]` ms.
  - After the last delay's attempt still fails, propagate failure exactly as today (`runPromptStep` returns `{ ok: false, result, output }`) so any enclosing `recover`/`catch` still runs and otherwise the workflow aborts. Retry composes **below** `recover` — backoff is exhausted before the failure reaches the recover loop.
- **Logging (always, regardless of recover/catch):** use the same emitter facility as `log`/`logerr` — `this.emitter.emitLog("LOGERR", …)` (writes both the live `__JAIPH_EVENT__` stderr line and the durable run-summary file, per `runtime-event-emitter.ts:191-206`). Log on every failed attempt and on final termination. Messages must include: attempt number / total, the backend, a trimmed error summary, and (for a retry) the delay before the next attempt; (for termination) that retries are exhausted and the step is failing. Use `LOGERR` (these are errors); a single `LOG` line announcing the upcoming wait is also acceptable.
- **Each attempt is a fresh `executePrompt` call** and must be observable (emit prompt start/end events per attempt, or equivalent), not a single silent loop.

### Testability + cancellation (required, not optional)

- The sleep must be **injectable** (e.g. a `sleep(ms)` dependency / clock seam on the runtime), and the delay schedule **parameterizable**, so tests assert the full sequence with zero real wall-clock wait. A test that needs to actually wait 2h is not acceptable.
- The wait must be **interruptible**: workflow abort / SIGINT must not block on an in-progress backoff sleep — abort the sleep and stop retrying promptly.

### Configurability

- Default schedule is the fixed sequence above. Provide an optional override consistent with existing knobs (e.g. `JAIPH_PROMPT_RETRY_DELAYS` as a comma-separated ms/duration list, and a disable switch such as `JAIPH_PROMPT_RETRY=0` → no retries, fail on first failure). Override parsing is a should-have; the default schedule is the must-have. Invalid override values error clearly rather than silently falling back.

### Interactions to document (in code comments / task notes, no code change required)

- Under Docker, total wall-clock for a full backoff (~2h41m) exceeds the default `runtime.docker_timeout_seconds` (3600s). So in a sandboxed run the retries are effectively capped by the container timeout unless the user raises it. Note this where the schedule constant is defined.

### Out of scope

- Adding a general per-prompt execution timeout (separate concern; noted as absent today). Do not add one here.
- Changing the `recover`/`catch` construct.
- Retrying non-prompt steps (`run`/`ensure`/inline scripts).

### Acceptance criteria (each verified by a test that fails when violated, using the injected sleep + a short test schedule)

- A prompt whose backend returns non-zero on the first N attempts and succeeds on attempt N+1 (for N within the schedule) ultimately returns `{ ok: true }`, and the captured value/output is that of the successful attempt.
- The delays requested between attempts equal the schedule in order (assert the exact sequence of values passed to the injected sleep, e.g. `[15000, 60000, 600000, 1800000, 7200000]` with the default schedule).
- A prompt that fails on every attempt makes exactly 6 total `executePrompt` calls and then returns `{ ok: false, ... }` with the final error (no 7th attempt).
- After exhausting retries, an enclosing `recover`/`catch` still executes (compose-below-recover proven).
- Invalid JSON / schema-validation failures are **not** retried: exactly 1 `executePrompt` call, immediate `{ ok: false }` (sleep never called).
- Every failed attempt and the final termination emit a `LOGERR` (or LOG+LOGERR) via `emitter.emitLog`, each carrying attempt number and (for retries) the next delay; assert by capturing emitted log events. Logging happens even when no `recover`/`catch` is present.
- `JAIPH_PROMPT_RETRY=0` disables retry: 1 attempt, sleep never called. A custom `JAIPH_PROMPT_RETRY_DELAYS` overrides the sequence; an invalid value errors.
- Abort/SIGINT during a backoff wait stops retrying promptly (no further `executePrompt` calls after abort).
