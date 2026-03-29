# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Add workflow-scoped `run async` for script calls (Node runtime only) <!-- dev-ready -->

**Goal**  
Support async fan-out/fan-in in workflows using explicit managed syntax (`run async ...`) instead of shell operators, with deterministic completion at workflow end.

**Problem statement**

- Current managed syntax lacks a first-class async primitive for script calls, so authors cannot express concurrent workflow work without shell-level hacks.
- Existing parallel shell syntax (`&`, `wait`) is not the target language direction under strict managed orchestration.
- We need a Node-runtime-native async model that is explicit, predictable, and compatible with run artifacts/events.

**Scope**

1. Add grammar for async managed calls:
   - `run async <script_ref> [args...]` in workflow bodies.
   - `async` is a keyword modifier on `run` (not a separate statement).
   - `run async` is valid only inside workflows (reject in rules/scripts/tests).
2. Define workflow-scope semantics:
   - each `run async ...` starts immediately and returns control to the next step,
   - the enclosing workflow performs an implicit join before `WORKFLOW_END`,
   - failures are aggregated: if multiple async branches fail, workflow failure reports all failed branches.
3. Constrain scope explicitly:
   - JS runtime support only (no Bash parity requirement),
   - async lifecycle is owned by workflow execution scope,
   - no reintroduction of shell background/wait syntax.
   - explicitly drop prior parallel authoring pattern using `&` and `wait` from current samples/examples.
4. Define invalid forms and diagnostics:
   - reject `const x = run async ...` in v1 (no direct capture result),
   - emit parser/validator errors with actionable guidance (`use run async ...` as a standalone step).
5. Implement runtime support in Node workflow runtime:
   - track pending async step handles per workflow scope,
   - await all pending handles on workflow completion path (success and error paths),
   - preserve stable event/artifact contracts for concurrently executed steps.
6. Update examples/docs and add/adjust tests:
   - migrate current samples that demonstrate parallelism from `&`/`wait` to `run async ...`,
   - remove or rewrite sample snippets that imply shell-level `&`/`wait` is a supported managed pattern,
   - parser/compiler coverage for `run async ...`,
   - runtime/e2e coverage for fan-out/fan-in ordering behavior (e.g. delayed writes resulting in sorted output),
   - failure aggregation coverage when multiple async branches exit non-zero.

**Language-spec snippet (draft)**

```jh
# Valid only in workflow bodies:
workflow default() {
  run async delayed 3
  run async delayed 1
  run async delayed 2
}

# Invalid (v1): capture from async run
workflow invalid_capture() {
  const x = run async delayed 1 "file.txt"  # E_*: async runs cannot be captured
}

# Invalid: async outside workflow
rule invalid_rule {
  run async delayed 1 "file.txt"            # E_*: run async is workflow-only
}
```

The current sample from e2e/sleep-sort.jh should log sorted values

Semantics:

- `run async <script_ref> [args...]` starts a managed script execution and immediately continues to the next workflow step.
- Async handles are tracked in workflow scope; the runtime performs an implicit join before workflow completion.
- Workflow success requires all async branches to succeed.
- If one or more async branches fail, the workflow fails and the error reports all failed async branches (aggregated), including step identity and exit context.
- JS runtime only. Bash parity is explicitly out of scope.

**Acceptance criteria**

- `run async delayed 3`, `run async delayed 1`, `run async delayed 2` parse and execute under Node runtime.
- Workflow does not finish until all workflow-scoped async runs settle.
- Successful async completion produces expected deterministic observable result (for example sorted append output in the sample workflow).
- `const x = run async ...` is rejected with clear diagnostic guidance.
- `run async ...` outside workflows is rejected with clear diagnostic guidance.
- If multiple async runs fail, workflow exits failed with aggregated error context for all failing branches.
- Current samples/docs no longer present `&`/`wait` as the parallel orchestration pattern; they use `run async ...`.
- Step artifacts and `run_summary.jsonl` remain valid and non-corrupt under concurrent async runs.
- No Bash-runtime parity is required for this task.

---

## Allow brace-less `script` and `rule` declarations (separate syntax task) <!-- dev-ready -->

**Goal**  
Allow `script` and `rule` declaration forms without braces while preserving existing braced syntax for backward compatibility.

**Problem statement**

- Current declaration syntax requires braces for `script`/`rule`, which adds ceremony for simple declarations.
- This change is parser/grammar focused and should be delivered independently from async runtime behavior.

**Scope**

1. Define accepted brace-less forms for `script` and `rule` declarations.
2. Update parser/AST to support both old (braced) and new (brace-less) forms.
3. Keep transpiler/runtime behavior unchanged for equivalent declarations.
4. Add parser + golden coverage for mixed usage and ambiguity edge cases.
5. Update docs/spec examples to show canonical preferred syntax.

**Acceptance criteria**

- Brace-less `script` and `rule` declarations parse successfully.
- Existing braced declarations remain fully supported.
- No runtime behavior change beyond syntax acceptance.
- Tests cover both declaration styles and prevent parsing ambiguities.

---

## Scope `agent.default_model` / agent metadata to the workflow (no sticky env) <!-- dev-ready -->

**Goal**  
Per-workflow `config { agent.backend = "cursor"; agent.default_model = "composer" }` must affect **only** that workflow’s execution, not sibling workflows or later steps that run in the same Node process.

**Problem statement**

- Today, workflow metadata is merged into `scope.env` via `applyMetadataScope` in [`src/runtime/kernel/node-workflow-runtime.ts`](src/runtime/kernel/node-workflow-runtime.ts). That mutates the env object carried into child scopes.
- Shallow copies still share the same underlying `process.env`-backed object in common paths, so `JAIPH_AGENT_MODEL` (and related keys) set for one workflow can **leak** to another—e.g. `e2e/async.jh` intends Composer only for `cursor_say_hello`, but `agent.default_model = "composer"` is a poor choice until scoping is fixed because it can influence what subsequent workflows see in the same run.
- Locked-env keys (`JAIPH_*_LOCKED`) help CLI overrides but do **not** fix metadata bleed between two workflows that both rely on file config.

**Scope**

1. Introduce a **stack** (or explicit push/pop) of agent-related env overrides when entering/leaving `executeManagedStep` for a workflow (and optionally rule), restoring previous values on exit.
2. Alternatively, resolve agent fields at prompt time from workflow metadata without writing `JAIPH_AGENT_MODEL` into the shared env map used by siblings.
3. Add regression coverage (unit or e2e): parallel `run wf_a &` / `run wf_b &` where only `wf_a` sets `agent.default_model`; assert `wf_b` still sees the global/default model.
4. Update docs/examples (`e2e/async.jh`, README snippets) to recommend the safe pattern once fixed; until then, prefer env-based `JAIPH_AGENT_MODEL` for one-off experiments or split entry files.

**Acceptance criteria**

- Sibling workflows in one `default` run do not inherit another workflow’s `agent.default_model` / `agent.backend` unless explicitly shared via parent module config.
- No regression for `JAIPH_*_LOCKED` CLI semantics from [`src/cli/run/env.ts`](src/cli/run/env.ts).
- Targeted test proves isolation for the async / parallel case.

---

## Re-enable inbox dispatch parity test coverage (e2e 91) <!-- dev-ready -->

**Goal**  
Unskip `e2e/tests/91_inbox_dispatch.sh` and restore end-to-end coverage for channel routing + dispatch lifecycle.

**Problem statement**

- The suite is currently skipped early with `Node inbox route dispatch parity is not implemented yet`.
- This leaves send/route behavior and dispatch observability under-tested in Node runtime migration.

**Scope**

1. Implement missing inbox route dispatch parity in Node runtime (`send`, `channel -> targets`, receiver args, multi-target fanout).
2. Restore deterministic tree expectations for display checks in e2e 91.
3. Re-enable dispatch lifecycle event checks (`INBOX_DISPATCH_START/COMPLETE`) if those are still in contract.
4. Unskip `e2e/tests/91_inbox_dispatch.sh`.

**Acceptance criteria**

- `e2e/tests/91_inbox_dispatch.sh` runs (not skipped) and passes.
- Receiver files/content assertions pass across all scenarios in that script.
- Event contract stays consistent with reporting consumers.

---

## Restore run-summary dispatch contract assertions (e2e 88) <!-- dev-ready -->

**Goal**  
Bring back strict `run_summary.jsonl` coverage that validates dispatch lifecycle and error events expected by downstream consumers.

**Problem statement**

- `e2e/tests/88_run_summary_event_contract.sh` was softened:
  - dropped `LOGERR` requirements,
  - removed `INBOX_DISPATCH_START/COMPLETE` pairing checks,
  - removed payload-preview checks.
- This weakens regression detection for reporting/event APIs.

**Scope**

1. Decide current event contract (including dispatch and `LOGERR`) and document it.
2. Reintroduce assertions in e2e 88 to match intended contract.
3. If runtime no longer emits some events, either restore emitters or explicitly version/deprecate the contract with migration notes.

**Acceptance criteria**

- e2e 88 asserts the full intended contract and passes.
- Event payload shape remains stable for reporting server consumers.

---

## Fix argument forwarding regression in function/rule/workflow calls (e2e 90) <!-- dev-ready -->

**Goal**  
Restore expected positional argument forwarding (`$1`, `$2`, …) across `run`, `ensure`, and nested workflow invocations.

**Problem statement**

- `e2e/tests/90_function_steps.sh` currently expects `|` instead of `one|two words`, indicating missing/empty forwarded args.
- This is a behavioral regression from prior runtime expectations.

**Scope**

1. Trace argument mapping in Node runtime for `executeRunRef`, `executeRule`, script invocation, and workflow nested calls.
2. Restore correct propagation to scripts/rules/workflows.
3. Revert e2e 90 assertions to exact `one|two words` behavior.

**Acceptance criteria**

- e2e 90 passes with exact arg forwarding assertions (`one|two words`).
- Tree display params remain consistent with actual forwarded values.

---

## Normalize log/logerr message quoting (remove outer literal quotes) <!-- dev-ready -->

**Goal**  
Make `log "$value"` and `logerr "$value"` display the resolved value without extra surrounding quote characters.

**Problem statement**

- Current output often renders with quotes (e.g. `ℹ "message"`), which is noisy and confusing in tree view.
- This appears to stem from preserving outer literal quotes in parsed log message tokens.

**Scope**

1. Adjust log/logerr interpolation path to strip only outer wrapping quotes when they come from literal syntax.
2. Preserve inner quotes and multiline content.
3. Update e2e expectations affected by log display text.

**Acceptance criteria**

- Tree/log output no longer adds synthetic outer quotes for standard `log "$x"` usage.
- No regression for multiline logging or escaping behavior.

---

## Decide fate of deprecated redirect/pipeline test (e2e 96) <!-- dev-ready -->

**Goal**  
Resolve whether `e2e/tests/96_run_stdout_redirect.sh` should be removed, replaced, or re-enabled.

**Problem statement**

- The file is currently an always-skip placeholder for unsupported shell redirection around `run` steps.
- Keeping permanently skipped tests creates maintenance noise.

**Scope**

1. Choose one path:
   - remove test and document non-goal,
   - keep but mark as explicit non-goal with rationale in docs,
   - or implement support and unskip.
2. Align with migration docs/QUEUE so status is explicit.

**Acceptance criteria**

- No ambiguous permanently-skipped test without documented rationale.
- e2e suite communicates supported syntax clearly.

---

## Enforce compile-time rejection for unsafe interpolation and backtick substitutions <!-- dev-ready -->

**Goal**  
Fail fast at compile/validation time for syntax patterns that currently degrade into runtime shell behavior (for example literal `${1:-}` propagation or backtick command substitution in orchestration text).

**Problem statement**

- Some invalid/unsafe interpolation patterns currently pass parsing and fail only at runtime with confusing shell errors.
- Backticks in orchestration strings can trigger command substitution side effects instead of being rejected as unsupported syntax.
- This causes delayed failures and makes debugging harder in long workflows.

**Scope**

1. Add validator/compiler checks that reject unsupported shell-style default expansion in orchestration value contexts (for example `${var:-fallback}`) unless explicitly supported by language spec.
2. Add checks that reject backtick command substitution patterns in orchestration text/metadata where shell execution is not intended.
3. Ensure error messages are actionable and point to source location + recommended replacement.
4. Add unit/acceptance coverage for both positive and negative cases.
5. Update docs/grammar to clarify what interpolation forms are allowed vs rejected at compile time.

**Acceptance criteria**

- Invalid interpolation/backtick patterns fail before execution with deterministic compile/validation errors.
- Runtime no longer surfaces shell-level errors for these rejected patterns.
- Tests cover regressions and docs match implemented validation rules.

---

## Show prompt model in run tree output (gray label) <!-- dev-ready -->

**Goal**  
Include model/backend context directly in prompt step lines in live run output, e.g. `prompt cursor "..."` (model/backend rendered in gray).

**Problem statement**

- Current prompt tree lines show prompt preview but not model/backend identity.
- During mixed-backend workflows (for example async Cursor + Claude), this makes it harder to verify routing at a glance.
- Prompt artifacts contain backend details, but live tree visibility is missing.

**Scope**

1. Extend prompt step rendering to include model/backend label in start lines, using a dim/gray style.
2. Ensure label works for both direct prompt and captured prompt forms.
3. Decide canonical display format (for example `prompt <backend> "<preview>"` or `prompt model=<backend> "<preview>"`) and keep docs/examples consistent.
4. Keep non-TTY output readable without ANSI and avoid noisy duplication in params.
5. Add tests for display formatting/parsing paths to lock behavior.

**Acceptance criteria**

- Prompt lines in run tree visibly include backend/model label.
- Label is rendered gray/dim in TTY mode and plain text in non-TTY mode.
- Async mixed-backend workflows show different prompt labels per branch.
- Docs samples are updated to reflect final prompt line format.

---

## Allow backticks in prompt strings as literal characters <!-- dev-ready -->

**Goal**  
Support backticks inside `prompt "..."` strings without parse errors.

**Problem statement**

- Current parser rejects backticks inside prompt literals (`E_PARSE prompt cannot contain backticks`).
- Desired behavior: backticks are treated as regular text characters in Jaiph prompt strings.
- Important: this is not Bash command substitution. Backticks must not trigger expansion/execution semantics.

**Scope**

1. Update prompt-string parsing to accept `` ` `` in prompt literals.
2. Keep variable interpolation rules unchanged (`$var` / `${...}` semantics stay as-is).
3. Ensure emitted Bash/JS runtime passes backticks through unchanged in prompt payload.
4. Add tests for prompt literals containing backticks (including mixed content with variables).

**Acceptance criteria**

- Prompt literals containing backticks parse successfully.
- Runtime output/prompt payload preserves literal backticks.
- No command substitution behavior is introduced by backticks.
- Existing prompt parsing/interpolation tests remain green.

---

## Add `jaiph format <file>` command <!-- dev-ready -->

**Goal.** Provide an opinionated formatter for `.jh` files that normalizes indentation and spacing.

**Scope.**

1. Add a `format` subcommand to the CLI (`cli/commands/format.ts`). Accepts one or more file paths (`.jh` / `.jph`).
2. Parse each file into the AST, then re-emit the source from the AST with consistent formatting.
3. Support a `--indent` flag (default: `2` spaces). Accepts an integer for the number of spaces per indent level.
4. Write the formatted output back to the file in-place (like `gofmt`). Add `--check` flag that exits non-zero if the file would change (for CI).
5. Formatting rules:
   - Consistent indentation within construct bodies (`workflow`, `rule`, `script`).
   - One blank line between top-level constructs.
   - No trailing whitespace.
   - Consistent spacing around `=` in `const` declarations.
   - Preserve comments in their relative position.
6. If the file fails to parse, emit the parse error and exit non-zero (do not silently corrupt).

**Acceptance criteria.**

- `jaiph format file.jh` reformats the file in-place with 2-space indent.
- `jaiph format --indent 4 file.jh` uses 4-space indent.
- `jaiph format --check file.jh` exits 0 if already formatted, non-zero otherwise.
- Formatting is idempotent: running `jaiph format` twice produces the same output.
- Parse errors produce a clear message and non-zero exit (file is not modified).
- Round-trip: formatted file parses identically to the original (AST equality).
- Unit test and e2e test covering basic formatting and `--check` mode.

---

## Add Codex backend support for prompts <!-- dev-ready -->

**Goal.** Add a first-class `codex` backend so Jaiph can execute `prompt` steps through Codex with consistent request/response behavior, streaming semantics, and error handling aligned with existing backends.

**Scope.**

1. **Backend config.**
   - Add `codex` as a supported backend option in config parsing/validation.
   - Define required env vars/settings (for example API key, model, optional base URL) with clear validation errors when missing.
2. **Runtime adapter.**
   - Implement a Codex client adapter in runtime prompt execution path.
   - Map Jaiph prompt input to Codex request payload, including system/user text, schema mode, and temperature/options used by existing backends where applicable.
3. **Structured returns compatibility.**
   - Ensure `prompt ... returns '{ ... }'` works with Codex output parsing and existing schema validation.
   - Keep behavior parity for invalid JSON / schema mismatch errors.
4. **Streaming and logging behavior.**
   - Match existing backend behavior for streaming tokens and final captured output.
   - Ensure run artifacts/logging include backend name and useful failure details without leaking secrets.
5. **Tests and docs.**
   - Add/extend unit tests for backend selection, request mapping, and response parsing.
   - Add integration or e2e coverage using mocked Codex responses.
   - Update docs (`README.md`, `docs/cli.md`, `docs/getting-started.md`) with setup and usage examples for `codex`.

**Acceptance criteria.**

- Setting backend to `codex` routes all `prompt` calls through the Codex adapter.
- Missing/invalid Codex configuration fails fast with actionable error messages.
- Plain text prompts and `returns` schema prompts both work with Codex.
- Streaming and non-streaming output behavior matches current backend contract.
- Unit/integration tests for Codex backend pass with the existing suite.
- Docs include Codex setup, required env vars, and a minimal working example.

---

## Auto-detect available prompt model for selected backend <!-- dev-ready -->

**Goal.** When backend is configured but model is not explicitly set (or is unavailable), Jaiph should automatically select a usable model instead of failing with a generic configuration error.

**Problem statement**

- Current backend setup requires users to manually provide a valid model identifier.
- Model availability can differ by account/region/provider updates, causing avoidable runtime failures.
- We need a predictable fallback strategy that keeps `jaiph run`/`jaiph test` usable with minimal setup.

**Scope.**

1. Add backend-specific model auto-detection in prompt runtime path (starting with `codex`, designed to extend to other backends).
2. Detection order:
   - Use explicit model from config/env if set and available.
   - If missing/unavailable, query provider for available models and select best default by defined policy.
   - If provider query fails, fall back to a documented static default (if safe), otherwise fail with actionable guidance.
3. Define deterministic selection policy (for example: preferred model list by backend, then first compatible model).
4. Emit clear diagnostics/logging:
   - indicate selected model and whether it was auto-detected or user-specified,
   - provide explicit remediation when no compatible model is available.
5. Update docs (`README.md`, `docs/cli.md`, `docs/getting-started.md`) with model resolution behavior and override examples.
6. Add tests for:
   - explicit model success path,
   - missing model with successful auto-detect,
   - unavailable explicit model with fallback,
   - no available models failure path.

**Acceptance criteria.**

- `jaiph run` works without explicit model config when provider offers at least one compatible model.
- If configured model is unavailable, Jaiph auto-selects a compatible model (per policy) and reports that decision.
- If no compatible model exists, error message is actionable and includes next steps.
- Behavior is covered by unit/integration tests and does not regress existing prompt flows.

---

## Reporting server does not mark SIGKILL-terminated runs as ended <!-- dev-ready -->

**Problem.** When `jaiph run` is killed by SIGKILL (or any signal that prevents the normal `WORKFLOW_END` event from being written to `run_summary.jsonl`), the reporting server (`jaiph report`) continues to show the run as active/in-progress indefinitely. There is no `WORKFLOW_END` event to trigger transition to a terminal state.

**Goal.** The reporting server should detect runs that will never complete and mark them as failed/terminated in the UI.

**Approach (investigate and pick one).**

1. **Stale-run detection** — The server already polls `run_summary.jsonl`. If a run has had no new events for a configurable timeout (e.g. `JAIPH_REPORT_STALE_RUN_SEC`, default 120s) and the originating process is no longer alive, mark the run as terminated/stale in the API and UI.
2. **PID-file or lock-file approach** — `jaiph run` writes a PID file (or holds a lock) in the run directory. The reporting server checks whether that PID is still alive; if not, the run is dead.
3. **Hybrid** — Combine timeout heuristic with PID liveness check for reliability.

**Acceptance criteria.**

- A run killed with `kill -9` (SIGKILL) is eventually shown as failed/terminated in `jaiph report`, not stuck as active forever.
- Normal runs that complete with `WORKFLOW_END` are unaffected.
- The detection mechanism has a reasonable latency (under 2–3 poll cycles).
- E2e or integration test: start a run, kill it with SIGKILL, verify `GET /api/active` eventually returns empty and `GET /api/runs` shows the run as failed/terminated.

---

## Direct return from run/ensure in workflows and rules <!-- dev-ready -->

**Goal.** Support direct return capture from managed calls, e.g. `return run my_script` and `return ensure my_rule`, without requiring an intermediate variable.

**Problem statement**

- Current behavior treats `return run ...` / `return ensure ...` as inline shell text and fails validation under strict shell-step ban.
- Authors currently need boilerplate:
  - `msg = run my_script`
  - `return "$msg"`
- This is verbose and inconsistent with the intent of managed-step-first syntax.

**Scope**

1. Extend parser/AST so `return` can accept `run`/`ensure` expression forms.
2. Reuse existing managed call validation for the referenced script/rule.
3. Emit transpilation/runtime behavior equivalent to managed capture + return:
   - `tmp = run ...`
   - `return "$tmp"`
4. Keep existing string return behavior unchanged.
5. Add unit + acceptance + e2e coverage for both success and failure paths.

**Acceptance criteria**

- `return run hello_impl` works in workflow/rule bodies.
- `return ensure ci_passes` works in workflow/rule bodies.
- Validation errors remain deterministic for unknown/invalid refs.
- Behavior matches current `capture + return` semantics.

---

## Distribution migration: ship `jaiph` as Bun standalone executable <!-- dev-ready -->

**Goal.** Replace Node-based distribution with a standalone Bun-compiled executable so users can run Jaiph without Node runtime installation.

**Scope.**

1. Add Bun build target for CLI/runtime binary (`bun build --compile`).
2. Produce release artifacts for supported OS/arch matrix.
3. Update install/release scripts and docs to download the standalone binary.
4. Validate runtime behavior parity between development run mode and compiled binary mode.
5. Keep `jaiph run`, `jaiph test`, `jaiph build`, `jaiph report`, `jaiph init`, and `jaiph use` behavior stable.

**Acceptance criteria.**

- Standalone binary runs on supported targets without Node installed.
- Core commands pass smoke/integration checks in compiled mode.
- Installer and docs are updated to binary-first flow.
- No regression in `.jaiph/runs` artifacts, event stream, or reporting server behavior.

---

## Named parameters for workflows, rules, and scripts <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Design Decision #16, Implementation Plan Phase 3f.

**Goal.** Replace positional `$1`/`$2` boilerplate with named parameters in construct declarations. Parameters become local variables inside the body.

**Before:**
```
workflow implement {
  const task = "$1"
  const role_name = "$2"
  const role = run select_role "$role_name"
  ...
}

script check_hash() {
  local actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ]
}
```

**After:**
```
workflow implement(task, role_name) {
  const role = run select_role "$role_name"
  ...
}

script check_hash(file_path, expected_hash) {
  local actual=$(sha256sum "$file_path" | cut -d' ' -f1)
  [ "$actual" = "$expected_hash" ]
}
```

**Scope.**

1. **AST**: add `params?: Array<{ name: string; default?: string }>` to `WorkflowDef`, `RuleDef`, `ScriptDef`.
2. **Parser**: recognize `name(param1, param2)` and `name(param1, param2 = "default")` in all three construct declarations. Parentheses are optional when there are no params — `workflow default { ... }` remains valid.
3. **Transpiler (workflows/rules)**: emit `local param1="$1"; local param2="$2"` at the top of the function body. For defaults: `local param2="${2:-default}"`.
4. **Transpiler (bash scripts)**: prepend `local param1="$1"; ...` to the generated script file. For non-bash shebangs, params are documentary only.
5. **Validator**: check call-site arity against declared params. Missing required args = validation error. Extra args beyond declared params = validation warning.
6. **Update all `.jaiph/*.jh` files** to use named params where applicable.
7. **Update all `e2e/*.jh` fixtures** to use named params.
8. **Update test fixtures and golden outputs**.

**Acceptance criteria.**

- `workflow implement(task, role_name) { ... }` parses and `$task`, `$role_name` are available as locals.
- `script check(value) { ... }` works — `$value` available in bash body.
- Default params work: `workflow deploy(env, dry_run = "false")` — `$dry_run` is `"false"` when not provided.
- No-param constructs still work without parentheses: `workflow default { ... }`.
- Arity validation: `run implement` with zero args errors when `implement` declares two required params.
- Both calling conventions work: `run implement "$t" "$r"` (positional) and `run implement task="$t" role_name="$r"` (named).
- Non-bash scripts: params are documentary, no transpiler output for them.
- All existing tests pass after migration.
- Unit test and e2e test covering named params, defaults, and arity validation.

---

## Inline construct interpolation: `${run ref}` and `${ensure ref}` in strings <!-- dev-ready -->

**Goal.** Allow `run` and `ensure` calls inline inside `${}` interpolation in orchestration strings, eliminating the need for a temporary `const` when the result is only used once.

**Before:**
```
const branch = run git.current_branch
log "Deploying from ${branch}"
const ci_log = "${ci_log_dir}/ensure_ci_passes_${repo_dir}.last.log"
```

**After (also valid):**
```
log "Deploying from ${run git.current_branch}"
const ci_log = "${ci_log_dir}/ensure_ci_passes_${repo_dir}.last.log"
```

Both `$var` and `${var}` remain valid for variable interpolation. `${}` is additionally required when embedding construct calls.

**Syntax.**

```
${run <ref> [args]}        # inline run capture — stdout becomes the interpolated value
${ensure <ref> [args]}     # inline ensure capture — stdout becomes the interpolated value
${var}                     # variable lookup (existing)
$var                       # variable lookup shorthand (existing, keep)
```

**Constraints.**

- Only `run` and `ensure` are allowed inline. `prompt` is excluded (heavyweight, deserves its own step).
- No nesting: `${run foo "${run bar}"}` is a parser error. Use `const` for composition.
- Failure in `${run ref}` or `${ensure ref}` fails the enclosing step (same semantics as standalone `run`/`ensure`).
- Allowed in: `const` RHS expressions, `log`, `logerr`, `fail`, `return`, `send` RHS.
- Not allowed in: `prompt` text (prompt interpolation is handled by the runtime, not the transpiler).

**Scope.**

1. **Parser**: detect `${run ...}` and `${ensure ...}` inside string literals in orchestration constructs. Produce new AST nodes or annotate existing string expressions with embedded captures.
2. **Validator**: validate refs inside inline interpolations using the same rules as standalone `run`/`ensure` (kind checks, import resolution).
3. **Transpiler**: emit `$(symbol::ref "$@")` for inline `${run ref}` and `$(symbol::ref "$@")` for `${ensure ref}` within the enclosing bash string.
4. **Error messages**: clear guidance when users try `${prompt ...}` or nested `${run ... ${run ...}}`.

**Acceptance criteria.**

- `log "Value: ${run compute_x}"` works — inline run capture interpolated into log output.
- `const msg = "Branch: ${run git.current_branch}"` works — inline capture in const RHS.
- `${ensure git.is_clean}` works inline — failure propagates to enclosing step.
- `${prompt ...}` is a parser error with guidance.
- Nested `${run ... ${run ...}}` is a parser error with guidance.
- Bare `$var` and `${var}` continue to work for variable interpolation.
- Unit tests and e2e test covering inline interpolation.

---

## Dot notation for JSON field access: `${var.field}` <!-- dev-ready -->

**Goal.** Access fields from `prompt ... returns` responses using dot notation instead of underscore-joined variable names.

**Before:**
```
const response = prompt "..." returns '{ message: string, severity: string }'
log "Message: ${response_message}, Severity: ${response_severity}"
```

**After:**
```
const response = prompt "..." returns '{ message: string, severity: string }'
log "Message: ${response.message}, Severity: ${response.severity}"
```

Dot notation makes the field relationship explicit. `${response.message}` clearly means "field `message` of `response`" — `$response_message` is ambiguous (could be a standalone variable).

**Implementation.** This is syntactic sugar in the parser/transpiler. Bash doesn't support dots in variable names, so `${response.message}` transpiles to `${response_message}` (the existing runtime mechanism). No runtime changes needed.

**Scope.**

1. **Parser**: recognize `${identifier.field}` in string interpolation. Distinguish from import refs (import refs only appear after `run`/`ensure`, not inside `${}`).
2. **Transpiler**: emit `${identifier_field}` for `${identifier.field}` — direct mapping to the existing underscore-joined variables generated by `prompt_capture_with_schema`.
3. **Validator**: verify that `identifier` is a `const` with a `prompt_capture` RHS that has a `returns` schema containing `field`. Emit clear error if the field doesn't exist in the schema.
4. **Deprecate underscore form**: keep `$response_message` working but document `${response.message}` as the canonical form. Consider a parser warning in a future version.

**Acceptance criteria.**

- `${response.message}` works wherever `$response_message` works today.
- Validator catches typos: `${response.typo}` errors with "field 'typo' not in schema for 'response'".
- Both `${response.message}` and `$response_message` work (backward compatibility).
- Works with all schema types: string, number, boolean.
- Unit test and e2e test covering dot notation field access.

---

## Anonymous inline scripts <!-- dev-ready -->

**Goal.** Allow inline `script "body"` as a step in workflows and rules, eliminating the need to name trivial one-liner scripts.

**Before:**
```
script npm_run_test_ci() {
  npm run test:ci
}

rule ci_passes {
  run npm_run_test_ci
}
```

**After (also valid):**
```
rule ci_passes {
  script "npm run test:ci"
}
```

Anonymous scripts are syntactic sugar. The transpiler auto-generates a named script file under the hood (e.g. `_anon_ci_passes_1`). Same isolation, same shebang, same separate executable file.

**Syntax.**

```
script "single line body"
script "
  multiline
  body
"
const result = script "echo hello"
```

Custom shebang — first line of the string:
```
script "#!/usr/bin/env node
const x = JSON.parse(process.argv[2]);
process.exit(x.valid ? 0 : 1);
"
```

**Constraints.**

- Anonymous scripts follow all the same rules as named scripts: full isolation, positional args only, stdout for values, exit code for success/failure.
- Shebang detection works the same way: if the first line of the body starts with `#!`, it becomes the shebang; otherwise `#!/usr/bin/env bash` is used.
- Allowed in workflows and rules (same places where `run <script_ref>` is allowed).
- Capture supported: `const result = script "echo hello"` captures stdout.
- The auto-generated name is deterministic (derived from enclosing construct name + position) so builds are reproducible.

**Spec update.** Decision #6 changes from "Every shell operation requires a **named `script`**" to "Every shell operation runs through a `script`. Named scripts are preferred; anonymous `script "body"` is available for trivial operations."

**Scope.**

1. **AST**: add new step type `{ type: "script_inline"; body: string; shebang?: string; captureName?: string; loc: SourceLoc }`.
2. **Parser**: recognize `script "..."` (and `const x = script "..."`) as a step in workflows and rules. Extract shebang from first line if present.
3. **Transpiler**: auto-generate a named script file from the inline body. Use deterministic naming: `_anon_<construct>_<index>`. Emit the call as `"$JAIPH_SCRIPTS/_anon_..." "$@"`.
4. **Validator**: apply the same keyword guard as named scripts (bash-only guard for default shebang, skip for custom).
5. **Tests**: unit test for parsing and emission, e2e test with inline script in a rule and a workflow.

**Acceptance criteria.**

- `script "npm run test:ci"` works in rules and workflows.
- Multiline string bodies work.
- Custom shebang in anonymous scripts works.
- `const result = script "echo hello"` captures stdout.
- Auto-generated script files appear in `build/scripts/` with `+x`.
- Builds are deterministic (same input → same auto-generated names).
- All existing tests pass.

---

## Unified mock syntax for all constructs in test files <!-- dev-ready -->

**Goal.** All Jaiph constructs (`prompt`, `rule`, `workflow`, `script`) support both simple string mocks and block body mocks with a consistent syntax.

**Current state.** `mock prompt` supports simple string and block forms. `mock workflow`, `mock rule`, `mock function` only support block body form. `mock function` needs renaming to `mock script`.

**Syntax.**

Prompt (unnamed — applies to all prompts in the test):
```
mock prompt "static response"
mock prompt { <jaiph script code — receives same params as prompt, returns value via stdout> }
```

Named mocks (qualified ref: `name` for local, `alias.name` for imported):
```
mock prompt classify_role "surgical"
mock rule git.is_clean "ok"
mock workflow deploy "done"
mock script select_role "reductionist-role-text"

mock rule git.is_clean { <regular jaiph script code> }
mock workflow deploy { <regular jaiph script code> }
mock script select_role { <regular jaiph script code> }
```

Block bodies receive the same positional args as the real construct and return values via stdout (same contract as scripts).

**Scope.**

1. **Rename** `mock function` → `mock script` in parser (`parse/tests.ts`) and AST (`test_mock_function` → `test_mock_script`). Update `emit-test.ts` accordingly.
2. **Add simple string form** for `mock workflow`, `mock rule`, `mock script`. Currently these only accept `{ body }`. Add parsing for `mock <type> <ref> "response"` that transpiles to a function echoing the string.
3. **Rework `mock prompt { ... }` block** — replace the current `if $1 contains` / `respond` DSL with regular script code (receives prompt text as `$1`, returns value via stdout). Keep the old `if/elif/respond` form working during transition or drop it if you prefer a clean cut.
4. **Add named prompt mock** — `mock prompt <ref> "response"` to mock a specific prompt step by name (when prompts are captured into a `const`).
5. **Update emit-test.ts** — emit mock dispatch for all forms. Simple string mocks emit `echo "response"`. Block mocks emit the body verbatim.
6. **Update existing tests** — rename `mock function` → `mock script` in all `.test.jh` files.

**Acceptance criteria.**

- `mock script <ref> "response"` works (simple string mock for scripts).
- `mock rule <ref> "response"` works (simple string mock for rules).
- `mock workflow <ref> "response"` works (simple string mock for workflows).
- `mock script <ref> { body }` works (block mock, same as before but renamed).
- `mock prompt "response"` still works (unnamed, all prompts).
- `mock prompt { body }` uses regular script code, not `if/respond` DSL.
- Qualified refs work: `mock rule git.is_clean "ok"`.
- `mock function` is no longer accepted (parser error with guidance to use `mock script`).
- All existing test files updated and passing.
- E2e test covering simple string mock for each construct type.

---
