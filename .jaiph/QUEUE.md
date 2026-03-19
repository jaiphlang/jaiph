# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Improve e2e tests -- assert full stdout, not only selected lines <!-- dev-ready -->

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
