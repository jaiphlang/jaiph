---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Bootstrap Skill (for Agents)

## Overview

This page is an **agent skill**: it tells an AI assistant how to **author** Jaiph workflows (`.jh` files) and what a sensible `.jaiph/` layout looks like. It is not a full language specification — use [Grammar](grammar.md) for syntax and validation details, [Configuration](configuration.md) for `config` keys, [Inbox & Dispatch](inbox.md) for channels, and [Sandboxing](sandboxing.md) for rule design vs optional Docker isolation.

**Jaiph** is a small language for agentic workflows: **orchestration** (rules, prompts, managed calls) and **bash in `script` definitions**. The **Node workflow runtime** (`NodeWorkflowRuntime`) interprets the parsed AST directly — there is no bash transpilation of workflow bodies on the execution path. Before `jaiph run` / `jaiph test`, **`buildScripts()`** parses each reachable workspace **`*.jh`** module, runs **compile-time validation** (`validateReferences`), and writes extracted **`script`** files only (`*.test.jh` is not walked for emit). The workflow runner then **`buildRuntimeGraph()`** loads modules with **parse-only** imports (validation is not repeated there). See [Architecture](architecture).

**Contracts (CLI vs runtime):** **Live:** `__JAIPH_EVENT__` JSON lines on **stderr only** (CLI progress and **hooks** — hooks are **CLI-only**, driven by that stream). **Durable:** `.jaiph/runs/...` and **`run_summary.jsonl`**. Channels are enforced at compile time and executed in the runtime (in-memory queue + inbox files under the run dir); they are not hooks.

The **JS kernel** (`src/runtime/kernel/`) handles **prompt** execution, **managed script subprocesses**, **inbox** queues and dispatch, and **event/summary emission**. **Rule** bodies run in-process; user **`script`** bodies run as separate OS processes (bash by default, polyglot via fence lang tags like `` ```node ``, `` ```python3 `` or a leading `#!` shebang in the body).

**Test lane:** `jaiph test` runs **`*.test.jh`** in-process (`node-test-runner.ts`): **`buildScripts(workspace)`**, then **`buildRuntimeGraph(testFile)` once per file**, mocks, and assertions — same `NodeWorkflowRuntime` as `jaiph run`.

**After `jaiph init`**, a repository gets `.jaiph/bootstrap.jh` (a prompt that tells the agent to read `.jaiph/jaiph-skill.md`) and a copy of this file. The expected outcome is a **minimal workflow set** for safe feature work: preflight checks, an implementation workflow, verification, and a `workflow default` entrypoint that wires them together (with an optional human-or-agent “review” step when you use a task queue).

**Concepts:**

- **Rules** — Structured checks: `ensure` (other **rules** only), `run` (**scripts** only — not workflows), `const`, brace `if`, `fail`, `log`/`logerr`, `return "…"` / `return run script()` / `return ensure rule()`. No raw shell lines, `prompt`, inbox send/route, `wait`, or `ensure … recover`. Under `jaiph run`, rule bodies are executed **in-process** by the Node runtime; when a rule runs a **script**, that script is a normal managed subprocess (same as scripts from workflows) — see [Sandboxing](sandboxing.md).
- **Workflows** — Named sequences of **Jaiph-only** steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, inbox **send** (`channel_ref <- …`) and **route** (`channel_ref -> workflow`), brace `if` only, `run async`, and `wait` (a no-op in the Node runtime — useful as a placeholder; **not** allowed in rules). Unrecognized lines are errors — put bash in **`script`** definitions and call with `run`.
- **Scripts** — Top-level **`script`** definitions are **bash (or shebang interpreter) source**, not Jaiph orchestration. Defined with `script name = "body"` (single-line), `script name = identifier` (identifier referencing an existing binding), or `script name = ``` ... ``` ` (fenced block). The compiler treats all script bodies as **opaque text**: it does not parse lines as Jaiph steps, reject keywords, strip quotes, or validate cross-script calls. This means embedded `node -e` heredocs, inline Python, `const` assignments in JS, and any other valid shell construct compile without interference. Use `return N` / `return $?` for exit status and **stdout** (`echo` / `printf`) for string data to callers. From a **workflow** or **rule**, call with **`run fn()`**. Cannot be used with `ensure`, are not valid inbox route targets, cannot be exported, and must not be invoked through `$(...)` or as a bare shell step. **Polyglot scripts:** use a fence lang tag (`` ```<tag> ``) to select an interpreter — the tag maps directly to `#!/usr/bin/env <tag>`. Any tag is valid (no hardcoded allowlist). For example: `` ```node ``, `` ```python3 ``, `` ```ruby ``, `` ```lua ``. Alternatively, if no fence tag is present, the first non-empty body line may start with `#!` (e.g. `#!/usr/bin/env lua`), which becomes the script's shebang and the body is emitted verbatim (you cannot combine a fence tag with a manual shebang — that is an error). Without either, `#!/usr/bin/env bash` is used and the emitter applies only lightweight bash-specific transforms (`return` normalization, `local`/`export`/`readonly` spacing, import alias resolution). Quoted-string and identifier RHS always use the default runtime (shell). Scripts are extracted to a `scripts/` directory under the run output tree (`jaiph run --target <dir>` sets that tree; without `--target` the CLI uses a temporary directory) and executed via **`JAIPH_SCRIPTS`**. **Inline scripts:** For trivial one-off commands, use `run script() "body"` or `` run script() ``` ... ``` `` directly in a workflow or rule step instead of declaring a named `script` definition. The body (a double-quoted string or fenced block) follows the `script(...)` call; optional comma-separated arguments go inside the parentheses: `run script("arg") "echo $1"`. Fenced blocks support lang tags for polyglot inline scripts: `` run script() ```python3 ... ``` ``. For quoted-string bodies, polyglot support works via embedded shebang: `run script() "#!/usr/bin/env python3\nprint('hello')"`. Capture forms: `x = run script() "echo val"` and `` const x = run script() ``` ... ``` ``. Inline scripts use deterministic hash-based artifact names (`__inline_<hash>`) and run with the same isolation as named scripts. `run async script(…)` is not supported.
- **Channels** — Top-level `channel <name>` declarations; **send** uses `channel_ref <- …`, **route** uses `channel_ref -> workflow` (see [Inbox & Dispatch](inbox.md)). Channel names share the per-module namespace with rules, workflows, scripts, and module-scoped `local` / `const` variables.
- **ensure** — Runs a rule; succeeds if exit code is 0. In **workflows only**, optional `recover` is a bounded retry loop (default **3** rounds, overridable with **`JAIPH_ENSURE_MAX_RETRIES`**). **`ensure … recover` is not allowed in rule bodies** (`E_VALIDATE`). When `recover` is used, all rule arguments must appear **before** `recover` (e.g. `ensure rule(arg) recover { … }`, **not** `ensure rule() recover(arg) { … }`). A bare `recover` without a body is a parse error.
- **run** — Invokes a workflow or script (local or `alias.name`). Must not target a rule or arbitrary shell command. **Does not forward positional args implicitly** — pass them explicitly (e.g. `run wf(arg1)`, `run helper_fn(arg1)`).
- **prompt** — Sends text to the configured agent. The body can be a single-line `"string"`, a bare identifier referencing an existing binding, or a fenced `` ``` ... ``` `` block for multiline text. Optional `returns` schema validates one line of JSON from the agent. Multiline double-quoted strings are no longer supported — use a fenced block instead.

**Audience:** Agents that produce or edit `.jh` files.

---

## Safe delivery loop (any repository)

Use this loop whenever you add or change Jaiph workflows so failures surface before work is handed back:

1. **Preflight** — Run the project’s readiness checks if they exist (often `jaiph run .jaiph/readiness.jh` or a named preflight workflow). When the repo ships native tests (`*.test.jh`), run `jaiph test` before large edits when practical.
2. **Implement** — Edit `.jh` modules using only constructs described in [Grammar](grammar.md); keep managed-call rules (`ensure` for rules, `run` for workflows and scripts); keep bash inside **`script`** bodies only (no raw shell in workflow/rule bodies).
3. **Format** — Run `jaiph format <file.jh ...>` on all authored or modified `.jh` files before committing. This normalizes whitespace, indentation, and definition order to the canonical style. Use `jaiph format --check <file.jh ...>` to verify formatting without writing (non-zero exit on drift — useful in CI).
4. **Verify** — Run `jaiph test` (whole workspace or a focused path) and any verification workflow the repo defines (commonly `jaiph run .jaiph/verification.jh`). Fix failures you introduce.
5. **Inspect (optional)** — Use `jaiph report --workspace .` to browse `.jaiph/runs` when you need the reporting UI or raw step logs instead of only the terminal tree.

**CLI synopsis:** `jaiph --help` prints the supported commands (in the Jaiph repo this text is maintained in `src/cli/shared/usage.ts`). Full flags and environment variables: [CLI Reference](cli.md).

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

When this skill conflicts with the compiler or runtime, follow the implementation. For language rules and validation codes, [Grammar](grammar.md) is the detailed reference. Published docs: [jaiph.org](https://jaiph.org).

`jaiph init` copies this skill into `.jaiph/jaiph-skill.md` only when the installed Jaiph bundle includes a skill file. If sync is skipped, point `JAIPH_SKILL_PATH` at this file (or `docs/jaiph-skill.md` in a checkout) and run `jaiph init` again — see [CLI Reference](cli.md).

Ignore any outdated Markdown that contradicts the above.

## What to Produce

A **minimal workflow set** under `.jaiph/` that matches the delivery loop above:

1. **Preflight** — Rules and `ensure` for repo state and required tools (e.g. clean git, required binaries). Expose a small workflow (e.g. `workflow default` in `readiness.jh`) that runs these checks.
2. **Review (optional)** — A workflow that reviews queued tasks before development starts (any filename, e.g. `ba_review.jh`). An agent prompt evaluates the next task for clarity, consistency, conflicts, and feasibility, then either marks it as ready or exits with questions. The implementation workflow gates on this marker so unreviewed tasks cannot proceed. This repository’s `.jaiph/architect_review.jh` is one concrete example; it uses `QUEUE.md` as the task queue.
3. **Implementation** — A workflow that drives coding changes (typically via `prompt`), e.g. `workflow implement` in `main.jh`. When using a task queue, the implementation workflow should check that the first task is marked as ready (e.g. via a `<!-- dev-ready -->` marker) before proceeding.
4. **Verification** — Rules and a `workflow default` for lint/test/build (e.g. `verification.jh`). Complement this with repo-native `*.test.jh` suites run by `jaiph test` where appropriate.
5. **Entrypoint** — A single `workflow default` (e.g. in `.jaiph/main.jh`) that runs: preflight → (optional) review → implementation → verification. This is what `jaiph run .jaiph/main.jh "..."` executes.

Prefer composable modules over one large file.

## Language Rules You Must Respect

- **Imports:** `import "path.jh" as alias`. Path must be double-quoted. Path is relative to the importing file. If the path has no extension, the compiler appends `.jh`.
- **Definitions:** `channel name` (inbox endpoint); `rule name() { ... }` or `rule name(params) { ... }`, `workflow name() { ... }` or `workflow name(params) { ... }`, `script name = "body"` or `script name = ``` ... ``` `. **Parentheses are required on all rule and workflow definitions** — even when parameterless (e.g. `workflow default() { ... }`, `rule check() { ... }`). Omitting `()` before `{` is a parse error with a fix hint. Named parameters go inside the parentheses — e.g. `workflow implement(task, role) { ... }`, `rule gate(path) { ... }`. At runtime, named params are bound alongside positional `arg1`…`arg9`. The compiler validates call-site arity when the callee declares params. Named scripts require a name at the definition site; for anonymous one-off commands use inline scripts: `run script() "body"`. Omitting the body is `E_PARSE`. Optional `export` before `rule` or `workflow` marks it as public (see [Grammar](grammar.md)). Optional `config { ... }` at the top of a file sets agent, run, and runtime options. An optional `config { ... }` block can also appear inside a `workflow { ... }` body (before any steps) to override module-level settings for that workflow only — only `agent.*` and `run.*` keys are allowed; `runtime.*` yields `E_PARSE` (see [Configuration](configuration.md#workflow-level-config)). Config values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings (see [Grammar](grammar.md) and [Configuration](configuration.md)).
- **Module-scoped variables:** `local name = value` or `const name = value` (same value forms). Prefer **`const`** for new files. Accessible as `${name}` inside orchestration strings in the same module. Names share the unified namespace with channels, rules, workflows, and scripts — duplicates are `E_PARSE`. Not exportable; module-scoped only.
- **Steps:**
  - **ensure** — `ensure ref([args...])` runs a rule (local or `alias.rule_name`); args are comma-separated inside parentheses. **Bare identifier arguments** are supported and preferred: `ensure check(status)` is equivalent to `ensure check("${status}")` — the identifier must reference a known variable (`const`, capture, or `arg1`–`arg9`); unknown names fail with `E_VALIDATE`. **Standalone `"${identifier}"` in call arguments is rejected** — use the bare form instead. In **workflows only**, optionally `ensure ref([args]) recover <body>`: bounded retry loop (run rule; on failure run recover body; repeat until the rule passes or max attempt rounds, then exit 1). Default **3** rounds (`JAIPH_ENSURE_MAX_RETRIES`). Inside a recover body, **`${arg1}`** is the full merged stdout+stderr produced by the failed rule execution, including output from nested scripts and rules. The payload refreshes per retry attempt. Full output still lives in step **`.out` / `.err`** artifacts. If **`${arg1}`** is empty for your rule, persist diagnostics before prompting or assert non-empty.
  - **run** — `run ref([args...])` runs a workflow or script (local or `alias.name`); explicit args are comma-separated inside parentheses. **`run` does not forward args by default** — pass positional args explicitly (e.g. `run wf(arg1)`, `run util_fn(arg2)`). **Bare identifier arguments** are supported and preferred: `run greet(name)` is equivalent to `run greet("${name}")` — the identifier must reference a known variable (`const`, capture, or `arg1`–`arg9`); unknown names fail with `E_VALIDATE`. **Standalone `"${identifier}"` in call arguments is rejected** — use the bare form instead (e.g. `run greet(name)` not `run greet("${name}")`). Quoted strings with additional text around the interpolation (e.g. `"prefix_${name}"`) are still allowed. Jaiph keywords cannot be used as bare identifiers. Also supports **inline scripts**: `run script(["arg1", ...]) "body"` — see Scripts section above.
  - **log** — `log "message"` writes the expanded message to **stdout** and emits a **`LOG`** event; the CLI shows it in the progress tree at the current depth. Double-quoted string; `${identifier}` interpolation works at runtime. **Bare identifier form:** `log foo` (no quotes) expands to `log "${foo}"` — the variable's value is logged. Works with `const`, capture, named parameters, and `arg1`–`arg9`. **Inline capture interpolation** is also supported: `${run ref([args])}` and `${ensure ref([args])}` execute a managed call and inline the result (e.g. `log "Got: ${run greet()}"`). Nested inline captures are rejected. **`LOG`** events and `run_summary.jsonl` store the **same** message string (JSON-escaped for the payload). No spinner, no timing — a static annotation. See [CLI Reference](cli.md) for tree formatting. Useful for marking workflow phases (e.g. `log "Starting analysis phase"`).
  - **logerr** — `logerr "message"` is identical to `log` except the message goes to **stderr** and the event type is **`LOGERR`**. In the progress tree, `logerr` lines use a red `!` instead of the dim `ℹ` used by `log`. Same quoting, interpolation, and bare identifier rules as `log` (e.g. `logerr err_msg`).
  - **Send** — After `<-`, use a **double-quoted literal**, **`${var}`**, **`run ref([args])`**, or standalone `<-` (forward `${arg1}`). Raw shell on the RHS is rejected — use `const x = run helper()` then `channel <- "${x}"`, or `channel <- run fmt_fn()`. Combining capture and send (`name = channel <- …`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
  - **Route** — `channel -> workflow_ref` (inside an orchestrator workflow) registers a static routing rule: when a message arrives on `channel`, call that **workflow** (local or `alias.workflow`) with `${arg1}=message`, `${arg2}=channel`, `${arg3}=sender`. Scripts and rules are not valid route targets. Multiple targets are comma-separated (`ch -> wf1, wf2`). Routes are declarations, not executable steps. The dispatch queue drains after the orchestrator completes. **`NodeWorkflowRuntime` does not cap dispatch iterations** — avoid circular sends that grow the queue without bound. See [Inbox & Dispatch](inbox.md).
  - **Bindings and capture** — `const name = …` or `name = …`. For **`ensure`** / **`run` to a workflow or rule**, capture is the callee’s explicit **`return "…"`**. For **`run` to a script**, capture follows **stdout** from the script body. **`prompt`** capture is the agent answer. **`const`** RHS cannot use `$(...)` or disallowed `${...}` forms — use a **`script`** and `const x = run helper(…)`. **`const`** must not use a **bare** `ref(args…)` call shape: use **`const x = run ref(args…)`** (or **`ensure`** for rules), not **`const x = ref(args…)`** — the compiler fails with **`E_PARSE`** and suggests the **`run`** form. Do not put Jaiph symbols inside `$(...)` — use `ensure` / `run`. See [Grammar](grammar.md#step-output-contract).
  - **return** — `return "value"` / `return "${var}"` sets the managed return value. Also supports **direct managed calls**: `return run ref(args)` and `return ensure ref(args)` — these execute the target and use its result as the return value, equivalent to `const x = run ref(args)` then `return "${x}"`. Same ref validation rules as standalone `run`/`ensure`.
  - **fail** — `fail "reason"` aborts with stderr message and non-zero exit (workflows; fails the rule when used inside a rule).
  - **wait** — `wait` is a no-op step in the Node runtime (advances control flow without doing work). **Workflows only** — `wait` in a rule is a parse-time error.
  - **run async** — `run async ref([args...])` starts a workflow or script concurrently. All pending async steps are implicitly joined before the workflow completes; failures are aggregated. Capture (`name = run async ...`) is not supported. Workflows only — rejected in rules.
- **Prompts:** Three body forms: (1) **single-line string** `prompt "..."` — double-quoted, single line only; (2) **identifier** `prompt myVar` — uses the value of an existing binding; (3) **fenced block** `prompt ``` ... ``` ` — for multiline text, opening `` ``` `` on the same line as `prompt`. Multiline double-quoted strings are rejected — use a fenced block instead. All forms support `${identifier}` interpolation (`${varName}`, `${arg1}`). **Inline capture interpolation** is also supported: `${run ref([args])}` and `${ensure ref([args])}` inside the prompt string or fenced body (e.g. `prompt "Fix: ${ensure get_diagnostics()}"`). Nested inline captures are rejected. Bare `$varName` is not valid in orchestration strings. `$(...)` and `${var:-fallback}` are rejected. Capture: `name = prompt "..."`, `const x = prompt myVar`, `const y = prompt ``` ... ``` `. Optional **typed prompt:** `name = prompt "..." returns "{ field: type, ... }"` or `name = prompt myVar returns "..."` (flat schema; types `string`, `number`, `boolean`) validates the agent's JSON and sets `${name}` plus per-field variables accessible via **dot notation** — `${name.field}` (preferred) or the underscore form `${name_field}`. Dot notation is validated at compile time: the variable must be a typed prompt capture and the field must exist in the schema. **Orchestration bindings are strings:** typed fields are coerced with `String()` after JSON validation, so e.g. a numeric field is still the text `"42"` in scope. See [Grammar](grammar.md).
- **Conditionals:** Only **brace form** in workflows:
  - `if [not] ensure some_rule([args]) { ... } [ else if [not] ensure|run ref([args]) { ... } ] [ else { ... } ]`
  - `if [not] run some_ref([args]) { ... }` with the same `else if` / `else` chaining. Use **`not`** instead of `!` before `ensure`/`run`. Express “shell conditions” with `run` to a **script** that performs the test. Short-circuit brace groups remain valid **inside `script`** bodies: `cmd || { ... }`.

Rules:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default` (the runtime checks for it and exits with an error if missing).
- Inside a workflow, `run` targets a workflow or script (local or `alias.name`), not a raw shell command. Call scripts with `run`, never `fn args` or `$(fn ...)`.
- Inside a rule, use `ensure` for **rules** and `run` for **scripts only** — not `prompt`, `send`, `wait`, or `ensure … recover`.
- Treat rules as non-mutating checks; perform filesystem or agent mutations in **workflows**. Script steps from rules use the same managed subprocess path as workflows. Details: [Sandboxing](sandboxing.md).
- **Parallelism:** `run async ref([args...])` for managed async with implicit join. For concurrent **bash**, use `&` and the shell builtin `wait` inside a **`script`** and call it with `run` (this is not the Jaiph `wait` step). Do not call Jaiph internals from background subprocesses unless you understand `run.inbox_parallel` locking.
- **No shell redirection around managed calls:** `run foo() > file`, `run foo() | cmd`, `run foo() &` are all `E_PARSE` errors — shell operators (`>`, `>>`, `|`, `&`) are not supported adjacent to `run` or `ensure` steps. Move shell pipelines and redirections into a **`script`** block and call it with `run`.
- **Shared bash:** Optional `.jaiph/lib/*.sh` — from a **`script`**, `source "$JAIPH_LIB/yourlib.sh"`. Emitted scripts default `JAIPH_LIB` to `${JAIPH_WORKSPACE:-.}/.jaiph/lib` unless set; the runtime also sets `JAIPH_LIB` for script steps. Keep Jaiph orchestration out of library files.
- **Unified namespace:** Channels, rules, workflows, scripts, and module-scoped `local`/`const` share a single namespace per module (`E_PARSE` on collision).
- **Calling conventions (compiler-enforced):** `ensure` must target a rule — using it on a workflow or script is `E_VALIDATE`. `run` in a **workflow** must target a workflow or script; `run` in a **rule** must target a **script** only. Jaiph symbols must not appear inside `$(...)` in bash contexts the compiler still scans (principally **`script`** bodies). Script bodies cannot contain `run`, `ensure`, `config`, nested definitions, routes, or Jaiph `fail` / `const` / `log` / `logerr` / `return "…"`.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows and scripts via `run`.
- **Always run `jaiph format` on `.jh` files you create or modify before committing.** This ensures canonical whitespace, indentation, and definition order. In CI, use `jaiph format --check` to gate on formatting.
- Use only syntax described in [jaiph.org](https://jaiph.org) and [Grammar](grammar.md). For advanced constructs (e.g. `config` block, `export`, prompt capture), see the grammar. For testing workflows, see [Testing](testing.md) (`expectContain`, `expectNotContain`, `expectEqual`, mocks).

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` — Created by `jaiph init`; contains a single prompt that points the agent at this guide.
- `.jaiph/readiness.jh` — Preflight: rules and `workflow default` that runs readiness checks.
- `.jaiph/ba_review.jh` (or any name you choose) — (Optional) Pre-implementation review: reads tasks from a queue file, sends one to an agent for review, and marks it dev-ready or exits with questions. This repository uses `.jaiph/architect_review.jh` with `QUEUE.md`.
- `.jaiph/verification.jh` — Verification: rules and `workflow default` for lint/test/build.
- `.jaiph/main.jh` — Imports readiness, optional review, and verification; defines implementation workflow and `workflow default` that orchestrates preflight → (optional) review → implementation → verification.

Optional: `.jaiph/implementation.jh` if you prefer the implementation workflow in a separate module; otherwise keep it in `main.jh`.

## Final Output Requirement

After scaffolding workflows, print the exact commands the developer should run. The primary command runs the default entrypoint (typically preflight, then implementation, then verification — plus any optional review step you added). Point users to the canonical skill URL for agents: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>.

Include a compile check and, when the repository has native tests (`*.test.jh`), `jaiph test` (see [Testing](testing.md)); skip `jaiph test` if there are no test files, since discovery mode exits with an error when nothing matches.

```bash
jaiph format .jaiph/*.jh
jaiph test
jaiph run .jaiph/main.jh "implement feature X"
# Or run verification only:
jaiph run .jaiph/verification.jh
```

Arguments after the file path are passed to `workflow default` as named parameters (when declared) and positional parameters (`${arg1}`, `${arg2}`, ... in orchestration strings; `$1`, `$2` in script bodies).

## Minimal Sample (Agent Reference)

Use this as a shape to adapt. Paths and prompts should match the target repository. All three files live under `.jaiph/`. Imports in `main.jh` are relative to that file (e.g. `"readiness.jh"` resolves to `.jaiph/readiness.jh`). When you run `jaiph run .jaiph/main.jh "implement feature X"`, the default workflow receives `"implement feature X"` as `${task}` (named parameter) and `${arg1}` (positional). Note that `run` does not forward args implicitly, so the default workflow passes `task` as a bare identifier to `run implement(task)` so the implement workflow's prompt can use `${task}`.

**File: .jaiph/readiness.jh**

```jaiph
script git_is_clean = "test -z \"$(git status --porcelain)\""

rule git_clean() {
  if not run git_is_clean() {
    fail "git working tree is not clean"
  }
}

script require_git_node_npm = ```
command -v git
command -v node
command -v npm
```

rule required_tools() {
  run require_git_node_npm()
}

workflow default() {
  ensure required_tools()
  ensure git_clean()
}
```

**File: .jaiph/verification.jh**

```jaiph
script npm_test_ci = "npm test"

rule unit_tests_pass() {
  run npm_test_ci()
}

script run_build = "npm run build"

rule build_passes() {
  run run_build()
}

workflow default() {
  ensure unit_tests_pass()
  ensure build_passes()
}
```

**File: .jaiph/main.jh**

```jaiph
import "readiness.jh" as readiness
import "verification.jh" as verification

workflow implement(task) {
  prompt ```
Implement the requested feature or fix with minimal, reviewable changes.
Keep edits consistent with existing architecture and style.
Add or update tests for behavior changes.

User asks for: ${task}
```
}

workflow default(task) {
  run readiness.default()
  run implement(task)
  run verification.default()
}
```
