# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Inbox: Pass event channel as first parameter to the workflow, reuse existing parameter print for workflow (don't do anything custom)

### Questions / concerns to address before development

1. **Missing description & acceptance criteria.** The task is a one-line title. It needs a motivation section explaining *why* the channel should be a positional parameter, an implementation plan, and testable acceptance criteria.

2. **Breaking change to dispatch contract.** Currently dispatched workflows receive `$1` = message content (`inbox.sh:120`). Moving channel to `$1` shifts the message to `$2`, breaking every existing `on … ->` handler. How should backwards compatibility be handled? Is a migration path needed, or is this acceptable as a breaking change?

3. **`JAIPH_DISPATCH_CHANNEL` is used beyond display.** The env var tags JSONL events with `"dispatched": true` and `"channel": "…"` metadata (`events.sh:167-177`). If the channel becomes a positional parameter instead, how does the runtime know a step is dispatched? Options: (a) keep the env var for event metadata and *also* pass channel as `$1`, (b) derive dispatch status from the presence of a channel parameter key, (c) something else. This needs a decision.

4. **Conflict with first queued task.** "Unify runtime output reporting" directly references `JAIPH_DISPATCH_CHANNEL` and the dispatch event metadata path. Changes to dispatch mechanics here could conflict. Should this task be sequenced after that one, or should both be coordinated?

5. **Parameter key registration.** For the standard `formatParamsForDisplay` to render the channel, the transpiler must register it as a named parameter key via `JAIPH_STEP_PARAM_KEYS`. But dispatched workflows are invoked dynamically by the runtime (`inbox.sh`), not statically by transpiled code. How should the parameter key for channel be registered? The runtime would need to export `JAIPH_STEP_PARAM_KEYS='channel,...'` before invocation.

---

## Fix prompt/agent step output: show only final answer, not full agent transcript

When a workflow runs a `prompt` (or agent) step, the displayed output currently includes the full agent transcript: "Command:", "Prompt:", "Reasoning:", "Final answer:", and the final answer text is repeated multiple times (streaming chunks plus log). Example: `CI=true e2e/say_hello.jh Mike` shows the full cursor-agent invocation details and triplicated greeting.

**Expected:** Only the final answer (the actual response to the user) should be shown in the workflow output. Strip or hide Command/Prompt/Reasoning headers and deduplicate so the final answer appears once.

**Likely area:** Code that formats or streams output from `cursor-agent` (or equivalent) in the engineer/run path; possibly `--output-format stream-json` handling and how "Final answer" vs other parts are extracted and printed.

---
