# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Unify runtime output reporting between Docker and non-Docker modes <!-- dev-ready -->

### Motivation

Output in Docker TTY mode is inconsistent with non-Docker TTY mode. The root cause is divergent code paths in the CLI for handling step output. The design principle for Docker support is: **only inject bash into the container** — all runtime reporting should be handled by the bash stdlib, not by CLI-side branching.

### Problem analysis

Two divergence points cause the inconsistency:

1. **Bash stdlib (`events.sh:167-177`)**: `out_content` is only embedded in `STEP_END` events for dispatched steps (when `JAIPH_DISPATCH_CHANNEL` is set). Non-dispatched steps in Docker have no way to get their output to the CLI since `out_file` lives inside the container.

2. **CLI (`run.ts:427-449` vs `445-449`)**: Docker mode buffers stdout line-by-line, filters out event lines, and re-emits the rest. Non-Docker mode passes stdout chunks through directly. This buffering causes timing/ordering differences in TTY output.

3. **CLI (`run.ts:373-395`)**: The `out_content` vs `readFileSync(out_file)` fallback is Docker-specific branching that should not exist if bash handles reporting uniformly.

### Implementation plan

1. **Always embed `out_content` in `STEP_END` events** (events.sh) — remove the `JAIPH_DISPATCH_CHANNEL` guard so all steps include their stdout in the event payload. This makes the bash stdlib the single source of truth for step output in both modes.

2. **Similarly embed `err_content` in `STEP_END` events** for failed steps, so error reporting (`errors.ts:94-132`) also works without host filesystem access.

3. **Remove CLI file-reading fallback** — `run.ts` should use `out_content` exclusively, eliminating the `readFileSync(event.out_file)` path. Remove the `event.dispatched` guard: show step output whenever the event carries `out_content` or `err_content`, not only for dispatched steps. `errors.ts:readFailedStepOutput()` should prefer embedded `out_content`/`err_content` from `run_summary.jsonl` over reading files from disk.

4. **Large output strategy**: Cap embedded content at 1 MB in the bash stdlib. If stdout exceeds this, truncate with a `[truncated]` marker. The file-based artifact (`out_file`) remains on disk for full output — it just won't be used for CLI display.

5. **Document out-of-scope behavior** — Spell in the codebase (e.g. comment in `run.ts` near the Docker stdout handling) that Docker TTY stdout/stderr merging and line-based demuxing are unchanged by this task; ordering/timing may still differ from non-Docker; address in a follow-up if needed.

### Acceptance criteria

- Step output displays identically in Docker TTY and non-Docker TTY modes.
- The bash stdlib always embeds `out_content` (and `err_content` for failed steps) in `STEP_END` events, regardless of dispatch status.
- The CLI uses `out_content`/`err_content` from events exclusively for display. No `readFileSync` in `run.ts`. In `errors.ts`, only as fallback when the event has no embedded content (e.g. older summaries).
- `out_file`/`err_file` artifacts are still written to disk for debugging/archival but are not read by the CLI for display.
- Embedded content is capped at 1 MB with truncation.
- `readFailedStepOutput()` uses embedded `out_content`/`err_content` from the summary when present; falls back to reading `out_file`/`err_file` only when not in the event (e.g. older summaries).
- The out-of-scope Docker TTY behavior (merged stream, demux, ordering) is documented in the codebase as proposed above.
- All existing e2e tests pass.

### Out of scope

- **Docker TTY stdout/stderr merging** — Docker `-t` merges stderr into stdout; the CLI must still demux event lines from user output. Line-buffering and ordering may differ from non-Docker. This task does not change that behavior; address in a follow-up if needed.

### Remaining concern (resolved)

- **Docker stdout routing** — Unifying `out_content` is sufficient for this task. Stream demuxing/ordering is explicitly out of scope (see above).

---

## Improve e2e tests -- assert full stdout, not only selected lines

### Scope

Only targets `e2e::assert_contains` calls that check **stdout** from `jaiph run`, `jaiph test`, or `jaiph build`. Assertions on stderr, file contents, and intentionally partial checks (e.g. version banner in `80_cli_behavior.sh:17`) remain unchanged.

### Conversion candidates

For each test below, replace the grouped `e2e::assert_contains` calls on the captured stdout variable with a single `e2e::assert_output_equals` call containing the full expected normalized output. Use `e2e::normalize_output` (already in `e2e/lib/common.sh:59-70`) to strip ANSI codes and normalize timing values.

- `61_ensure_recover.sh` lines 34-36, 61 — ensure/recover tree output (4 assertions → 2 full-output checks)
- `90_function_steps.sh` lines 74-75 — argument forwarding tree output
- `91_inbox_dispatch.sh` lines 164-166 — dispatched step tree output
- `22_assign_capture.sh` line 25 — assign workflow tree
- `20_rule_and_prompt.sh` lines 132, 147 — prompt tree output
- `50_cli_and_parse_guards.sh` lines 46-49 — test discovery output
- `82_sibling_parse_error.sh` line 31 — sibling parse success output

### Acceptance criteria

- All candidates above use `e2e::assert_output_equals` instead of `e2e::assert_contains` for stdout checks.
- Assertions on stderr, file contents, and intentionally partial checks remain unchanged.
- All e2e tests pass.

---

## Inbox: Pass event channel as first parameter to the workflow, reuse existing parameter print for workflow (don't do anything custom)

### Questions / concerns to address before development

1. **Missing description & acceptance criteria.** The task is a one-line title. It needs a motivation section explaining *why* the channel should be a positional parameter, an implementation plan, and testable acceptance criteria.

2. **Breaking change to dispatch contract.** Currently dispatched workflows receive `$1` = message content (`inbox.sh:120`). Moving channel to `$1` shifts the message to `$2`, breaking every existing `on … ->` handler. How should backwards compatibility be handled? Is a migration path needed, or is this acceptable as a breaking change?

3. **`JAIPH_DISPATCH_CHANNEL` is used beyond display.** The env var tags JSONL events with `"dispatched": true` and `"channel": "…"` metadata (`events.sh:167-177`). If the channel becomes a positional parameter instead, how does the runtime know a step is dispatched? Options: (a) keep the env var for event metadata and *also* pass channel as `$1`, (b) derive dispatch status from the presence of a channel parameter key, (c) something else. This needs a decision.

4. **Conflict with first queued task.** "Unify runtime output reporting" directly references `JAIPH_DISPATCH_CHANNEL` and the dispatch event metadata path. Changes to dispatch mechanics here could conflict. Should this task be sequenced after that one, or should both be coordinated?

5. **Parameter key registration.** For the standard `formatParamsForDisplay` to render the channel, the transpiler must register it as a named parameter key via `JAIPH_STEP_PARAM_KEYS`. But dispatched workflows are invoked dynamically by the runtime (`inbox.sh`), not statically by transpiled code. How should the parameter key for channel be registered? The runtime would need to export `JAIPH_STEP_PARAM_KEYS='channel,...'` before invocation.

---
