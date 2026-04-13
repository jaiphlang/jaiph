---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Bootstrap Skill (for Agents)

**Why this matters to you.** Humans structure their work with task lists, goals, and habits — it makes them effective and predictable. You face the same problem: without structure, your output varies between runs, failures go undetected, and the humans who depend on you lose trust. Jaiph gives you that structure. It defines what you do (workflows), what must be true before and after (rules), and how failures are handled (recover) — all in a small, declarative language you can read and write. The result: your behavior becomes **predictable**, **verifiable**, and **auditable**. Every run produces artifacts, every step is logged, every failure has a defined recovery path. You stop being a black box and start being a reliable system.

## Overview

This page is an **agent skill**: it tells an AI assistant how to **author** Jaiph workflows (`.jh` files) and what a sensible `.jaiph/` layout looks like. It is not a full language specification — use [Grammar](grammar.md) for syntax and validation details, [Configuration](configuration.md) for `config` keys, [Inbox & Dispatch](inbox.md) for channels, and [Sandboxing](sandboxing.md) for rule design vs optional Docker isolation.

**Jaiph** is a small language for agentic workflows: **orchestration** (rules, prompts, managed calls) and **bash in `script` definitions**. The **Node workflow runtime** (`NodeWorkflowRuntime`) interprets the parsed AST directly — there is no bash transpilation of workflow bodies on the execution path. Before `jaiph run` / `jaiph test`, **`buildScripts()`** parses each reachable workspace **`*.jh`** module, runs **compile-time validation** (`validateReferences`), and writes extracted **`script`** files only (`*.test.jh` is not walked for emit). The workflow runner then **`buildRuntimeGraph()`** loads modules with **parse-only** imports (validation is not repeated there). See [Architecture](architecture).

**Contracts (CLI vs runtime):** **Live:** `__JAIPH_EVENT__` JSON lines on **stderr only** (CLI progress and **hooks** — hooks are **CLI-only**, driven by that stream). **Durable:** `.jaiph/runs/...` and **`run_summary.jsonl`**. Channels are enforced at compile time and executed in the runtime (in-memory queue + inbox files under the run dir); they are not hooks.

The **JS kernel** (`src/runtime/kernel/`) handles **prompt** execution, **managed script subprocesses**, **inbox** queues and dispatch, and **event/summary emission**. **Rule** bodies run in-process; user **`script`** bodies run as separate OS processes (bash by default, polyglot via fence lang tags like `` ```node ``, `` ```python3 `` or a leading `#!` shebang in the body).

**Test lane:** `jaiph test` runs **`*.test.jh`** in-process (`node-test-runner.ts`): **`buildScripts(workspace)`**, then **`buildRuntimeGraph(testFile)` once per file**, mocks, and assertions — same `NodeWorkflowRuntime` as `jaiph run`.

**After `jaiph init`**, a repository gets `.jaiph/bootstrap.jh` (a prompt that tells the agent to read `.jaiph/SKILL.md`) and a copy of this file. The expected outcome is a **minimal workflow set** for safe feature work: preflight checks, an implementation workflow, verification, and a `workflow default` entrypoint that wires them together (with an optional human-or-agent “review” step when you use a task queue).

**Concepts:**

- **Rules** — Structured checks: `ensure` (other **rules** only), `run` (**scripts** only — not workflows), `const`, `match`, `if`, `fail`, `log`/`logerr`, `return "…"` / `return run script()` / `return ensure rule()`, `ensure … recover`, `run … recover`. No raw shell lines, `prompt`, inbox send/route, or `run async`. Under `jaiph run`, rule bodies are executed **in-process** by the Node runtime; when a rule runs a **script**, that script is a normal managed subprocess (same as scripts from workflows) — see [Sandboxing](sandboxing.md).
- **Workflows** — Named sequences of **Jaiph-only** steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, inbox **send** (`channel_ref <- …`), `match`, `if`, `run async`, `ensure … recover`, `run … recover`. Route declarations (`->`) belong at the top level on `channel` declarations, **not** inside workflow bodies — a `->` inside a body is a parse error. Unrecognized lines are errors — put bash in **`script`** definitions and call with `run`.
- **Scripts** — Top-level **`script`** definitions are **bash (or shebang interpreter) source**, not Jaiph orchestration. Defined with `` script name = `body` `` (single-line backtick) or `` script name = ```[lang] ... ``` `` (fenced block). Double-quoted string bodies (`script name = "body"`) and bare identifier bodies (`script name = varName`) are **removed** — both produce parse errors with guidance to use backtick delimiters. The compiler treats all script bodies as **opaque text**: it does not parse lines as Jaiph steps, reject keywords, strip quotes, or validate cross-script calls. This means embedded `node -e` heredocs, inline Python, `const` assignments in JS, and any other valid shell construct compile without interference. Jaiph interpolation (`${...}`) is **forbidden** in **single-line backtick** script bodies — use `$1`, `$2` positional arguments to pass data from orchestration to scripts. In **fenced** (triple-backtick) blocks, `${...}` is passed through to the shell as standard parameter expansion (`${VAR}`, `${VAR:-default}`, etc.). A single-backtick body containing a newline is a hard parse error — use a fenced block for multi-line scripts. Use `return N` / `return $?` for exit status and **stdout** (`echo` / `printf`) for string data to callers. From a **workflow** or **rule**, call with **`run fn()`**. Can be exported (`export script name = ...`) for use by importing modules. Cannot be used with `ensure`, are not valid inbox route targets, and must not be invoked through `$(...)` or as a bare shell step. **Polyglot scripts:** use a fence lang tag (`` ```<tag> ``) to select an interpreter — the tag maps directly to `#!/usr/bin/env <tag>`. Any tag is valid (no hardcoded allowlist). For example: `` ```node ``, `` ```python3 ``, `` ```ruby ``, `` ```lua ``. Alternatively, if no fence tag is present, the first non-empty body line may start with `#!` (e.g. `#!/usr/bin/env lua`), which becomes the script's shebang and the body is emitted verbatim (you cannot combine a fence tag with a manual shebang — that is an error). Without either, `#!/usr/bin/env bash` is used and the emitter applies only lightweight bash-specific transforms (`return` normalization, `local`/`export`/`readonly` spacing, import alias resolution). Scripts are extracted to a `scripts/` directory under the run output tree (`jaiph run --target <dir>` sets that tree; without `--target` the CLI uses a temporary directory) and executed via **`JAIPH_SCRIPTS`**. **Inline scripts:** For trivial one-off commands, use `` run `body`(args) `` or `` run ```lang...body...```(args) `` directly in a workflow or rule step instead of declaring a named `script` definition. The body (single backtick for one-liners or triple backtick for multi-line) comes before the parentheses; optional comma-separated arguments go inside the parentheses: `` run `echo $1`("hello") ``. Fenced blocks support lang tags for polyglot inline scripts: `` run ```python3 ... ```() ``. Capture forms: `` const x = run `echo val`() `` and `` const x = run ```...```() ``. The old `run script() "body"` form is **removed** — use the backtick forms instead. Inline scripts use deterministic hash-based artifact names (`__inline_<hash>`) and run with the same isolation as named scripts. `run async` with inline scripts is not supported.
- **Channels** — Top-level `channel <name> [-> workflow, ...]` declarations with optional inline routing; **send** uses `channel_ref <- …`. Routes are declared on the channel declaration, not inside workflow bodies (see [Inbox & Dispatch](inbox.md)). Channel names share the per-module namespace with rules, workflows, scripts, and module-scoped `local` / `const` variables.

Step semantics (`ensure`, `run`, `prompt`, `recover`, `match`, `if`, `log`, `fail`, `return`, `send`, `run async`) are detailed in the **Steps** section below.

**Audience:** Agents that produce or edit `.jh` files.

---

## Safe delivery loop (any repository)

Use this loop whenever you add or change Jaiph workflows so failures surface before work is handed back:

1. **Preflight** — Run the project’s readiness checks if they exist (often `jaiph run .jaiph/readiness.jh` or a named preflight workflow). When the repo ships native tests (`*.test.jh`), run `jaiph test` before large edits when practical.
2. **Implement** — Edit `.jh` modules using only constructs described in [Grammar](grammar.md); keep managed-call rules (`ensure` for rules, `run` for workflows and scripts); keep bash inside **`script`** bodies only (no raw shell in workflow/rule bodies).
3. **Format** — Run `jaiph format <file.jh ...>` on all authored or modified `.jh` files before committing. This normalizes whitespace, indentation, and top-level ordering (imports, config, and channels hoisted to the top; everything else kept in source order). Use `jaiph format --check <file.jh ...>` to verify formatting without writing (non-zero exit on drift — useful in CI).
4. **Verify** — Run `jaiph test` (whole workspace or a focused path) and any verification workflow the repo defines (commonly `jaiph run .jaiph/verification.jh`). Fix failures you introduce.
5. **Inspect (optional)** — Use `jaiph report --workspace .` to browse `.jaiph/runs` when you need the reporting UI or raw step logs instead of only the terminal tree.

**CLI commands:**

| Command | Purpose |
|---|---|
| `jaiph run <file.jh> [args...]` | Execute `workflow default` in the given file |
| `jaiph test [path]` | Run `*.test.jh` test files (workspace, directory, or single file) |
| `jaiph format [--check] <file.jh ...>` | Reformat `.jh` files (or verify formatting without writing) |
| `jaiph init [workspace]` | Scaffold `.jaiph/` with bootstrap workflow and skill file |
| `jaiph install [url[@version]]` | Install or restore project-scoped libraries under `.jaiph/libs/` |
| `jaiph report [start\|stop\|status]` | Serve a reporting dashboard over run artifacts |
| `jaiph use <version\|nightly>` | Reinstall Jaiph at a specific version or nightly |

**File shorthand:** `jaiph ./file.jh` auto-routes — `*.test.jh` files run as tests, other `*.jh` files run as workflows.

Full flags and environment variables: [CLI Reference](cli.md).

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

When this skill conflicts with the compiler or runtime, follow the implementation. For language rules and validation codes, [Grammar](grammar.md) is the detailed reference. Published docs: [jaiph.org](https://jaiph.org).

`jaiph init` writes this skill to `.jaiph/SKILL.md` when the installed Jaiph bundle includes a skill file (or when `JAIPH_SKILL_PATH` points at a markdown file). If that step is skipped, set `JAIPH_SKILL_PATH` to this file (or `docs/jaiph-skill.md` in a checkout) and run `jaiph init` again — see [CLI Reference](cli.md).

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

- **Imports:** `import "path.jh" as alias`. Path must be double-quoted. Path is relative to the importing file first; if no file is found and the path contains `/`, the resolver falls back to project-scoped libraries under `<workspace>/.jaiph/libs/` (e.g. `import "queue-lib/queue" as queue` resolves to `.jaiph/libs/queue-lib/queue.jh`). If the path has no extension, the compiler appends `.jh`. Install libraries with `jaiph install <url[@version]>`. **Script imports:** `import script "./helper.py" as helper` imports an external script file and binds it as a local script symbol — callable with `run helper(args)` exactly like an inline `script` definition. The path resolves relative to the importing file. Shebangs in the imported file are preserved. Missing targets fail with `E_IMPORT_NOT_FOUND`.
- **Definitions:** `channel name` (inbox endpoint); `rule name() { ... }` or `rule name(params) { ... }`, `workflow name() { ... }` or `workflow name(params) { ... }`, `` script name = `body` `` or `` script name = ```[lang] ... ``` ``. **Parentheses are required on all rule and workflow definitions** — even when parameterless (e.g. `workflow default() { ... }`, `rule check() { ... }`). Omitting `()` before `{` is a parse error with a fix hint. Named parameters go inside the parentheses — e.g. `workflow implement(task, role) { ... }`, `rule gate(path) { ... }`. At runtime, named params are the only way to access arguments. The compiler validates call-site arity when the callee declares params. Named scripts require a name at the definition site; for anonymous one-off commands use inline scripts: `` run `echo ok`() `` or `` run ```...```(args) ``. Optional `export` before `rule`, `workflow`, or `script` marks it as public (see [Grammar](grammar.md)). Optional `config { ... }` at the top of a file sets agent, run, and runtime options. An optional `config { ... }` block can also appear inside a `workflow { ... }` body (before any steps) to override module-level settings for that workflow only — only `agent.*` and `run.*` keys are allowed; `runtime.*` yields `E_PARSE` (see [Configuration](configuration.md#workflow-level-config)). Config values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings (see [Grammar](grammar.md) and [Configuration](configuration.md)).
- **Module-scoped variables:** `local name = value` or `const name = value` (same value forms). Prefer **`const`** for new files. Values can be single-line `"..."` strings, triple-quoted `"""..."""` multiline strings, or bare tokens. A double-quoted string that spans multiple lines is rejected — use `"""..."""` instead. Accessible as `${name}` inside orchestration strings in the same module. Names share the unified namespace with channels, rules, workflows, and scripts — duplicates are `E_PARSE`. Not exportable; module-scoped only.
- **Steps:**
  - **ensure** — `ensure ref` or `ensure ref([args...])` runs a rule (local or `alias.rule_name`). **Parentheses are optional when passing zero arguments** — `ensure check` is equivalent to `ensure check()`. When arguments are present, parentheses are required with comma-separated expressions. **Bare identifier arguments** are supported and preferred: `ensure check(status)` is equivalent to `ensure check("${status}")` — the identifier must reference a known variable (`const`, capture, or named parameter); unknown names fail with `E_VALIDATE`. **Standalone `"${identifier}"` in call arguments is rejected** — use the bare form instead. Optionally `ensure ref([args]) recover (<name>) <body>` or `ensure ref([args]) recover (<name>, <attempt>) <body>`: the recovery body runs **once** on failure (like a catch clause). There is no retry loop — for retries, use explicit recursion. The first binding (e.g. `failure`) receives the full merged stdout+stderr from the failed rule execution, including output from nested scripts and rules. The optional second binding (e.g. `attempt`) receives the attempt number (always `"1"`). Full output still lives in step **`.out` / `.err`** artifacts. If the failure binding is empty for your rule, persist diagnostics before prompting or assert non-empty. Works in both workflows and rules.
  - **run** — `run ref` or `run ref([args...])` runs a workflow or script (local or `alias.name`). **Parentheses are optional when passing zero arguments** — `run setup` is equivalent to `run setup()`. When arguments are present, parentheses are required with comma-separated expressions. **`run` does not forward args by default** — pass named params explicitly (e.g. `run wf(task)`, `run util_fn(name)`). **Bare identifier arguments** are supported and preferred: `run greet(name)` is equivalent to `run greet("${name}")` — the identifier must reference a known variable (`const`, capture, or named parameter); unknown names fail with `E_VALIDATE`. **Standalone `"${identifier}"` in call arguments is rejected** — use the bare form instead (e.g. `run greet(name)` not `run greet("${name}")`). Quoted strings with additional text around the interpolation (e.g. `"prefix_${name}"`) are still allowed. Jaiph keywords cannot be used as bare identifiers. Optionally `run ref([args]) recover (<name>) <body>`: the recovery body runs **once** on failure (same semantics as `ensure … recover`). Works in both workflows and rules. Also supports **inline scripts**: `` run `body`(args) `` or `` run ```lang...body...```(args) `` — see Scripts section above.
  - **log** — `log "message"` writes the expanded message to **stdout** and emits a **`LOG`** event; the CLI shows it in the progress tree at the current depth. Double-quoted string; `${identifier}` interpolation works at runtime. For multiline messages, use triple quotes: `log """..."""`. **Bare identifier form:** `log foo` (no quotes) expands to `log "${foo}"` — the variable's value is logged. Works with `const`, capture, and named parameters. **Inline capture interpolation** is also supported: `${run ref([args])}` and `${ensure ref([args])}` execute a managed call and inline the result (e.g. `log "Got: ${run greet()}"`). Nested inline captures are rejected. **`LOG`** events and `run_summary.jsonl` store the **same** message string (JSON-escaped for the payload). No spinner, no timing — a static annotation. See [CLI Reference](cli.md) for tree formatting. Useful for marking workflow phases (e.g. `log "Starting analysis phase"`).
  - **logerr** — `logerr "message"` is identical to `log` except the message goes to **stderr** and the event type is **`LOGERR`**. In the progress tree, `logerr` lines use a red `!` instead of the dim `ℹ` used by `log`. Same quoting, interpolation, bare identifier, and triple-quote rules as `log` (e.g. `logerr err_msg`, `logerr """..."""`).
  - **Send** — After `<-`, use a **double-quoted literal**, **triple-quoted block** (`channel <- """..."""`), **`${var}`**, or **`run ref([args])`**. An explicit RHS is always required — bare `channel <-` (forward syntax) has been removed. Raw shell on the RHS is rejected — use `const x = run helper()` then `channel <- "${x}"`, or `channel <- run fmt_fn()`. Combining capture and send (`name = channel <- …`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
  - **Route** — Routes are declared **at the top level** on channel declarations: `channel name -> workflow_ref` or `channel name -> wf1, wf2`. A `->` inside a workflow body is a **parse error** with guidance to move it to the channel declaration. When a message arrives on the channel, the runtime calls each listed **workflow** (local or `alias.workflow`), binding the dispatch values (message, channel, sender) to the target's 3 declared parameters. Route targets must declare exactly 3 parameters. Scripts and rules are not valid route targets. The dispatch queue drains after the orchestrator completes. **`NodeWorkflowRuntime` does not cap dispatch iterations** — avoid circular sends that grow the queue without bound. See [Inbox & Dispatch](inbox.md).
  - **Bindings and capture** — `const name = …` (the `const` keyword is required for all captures). For **`ensure`** / **`run` to a workflow or rule**, capture is the callee’s explicit **`return "…"`**. For **`run` to a script**, capture follows **stdout** from the script body. **`prompt`** capture is the agent answer. **`const`** RHS cannot use `$(...)` or disallowed `${...}` forms — use a **`script`** and `const x = run helper(…)`. **`const`** must not use a **bare** `ref(args…)` call shape: use **`const x = run ref(args…)`** (or **`ensure`** for rules), not **`const x = ref(args…)`** — the compiler fails with **`E_PARSE`** and suggests the **`run`** form. Do not put Jaiph symbols inside `$(...)` — use `ensure` / `run`. See [Grammar](grammar.md#step-output-contract).
  - **return** — `return "value"` / `return "${var}"` / `return """..."""` sets the managed return value. Also supports **direct managed calls**: `return run ref()` or `return run ref(args)` and `return ensure ref()` or `return ensure ref(args)` — these execute the target and use its result as the return value, equivalent to `const x = run ref(args)` then `return "${x}"`. Parentheses are required on all call sites.
  - **fail** — `fail "reason"` or `fail """..."""` aborts with stderr message and non-zero exit (workflows; fails the rule when used inside a rule).
  - **run async** — `run async ref([args...])` starts a workflow or script concurrently. All pending async steps are implicitly joined before the workflow completes; failures are aggregated. Capture (`const name = run async ...`) is not supported. Workflows only — rejected in rules.
  - **match** — `match var { "literal" => …, /regex/ => …, _ => … }` pattern-matches on a string value. The subject is always a bare identifier (no `$` or `${}`). Arms are tested top-to-bottom; the first match wins. Patterns: double-quoted string literal (exact match), `/regex/` (regex match), or `_` (wildcard — exactly one required). Usable as a statement, as an expression (`const x = match var { … }`), or with `return` (`return match var { … }`). Using `$var` or `${var}` as the match subject is a parse error. Allowed in both workflows and rules. See [Grammar](grammar.md#match).
  - **if** — `if var == "value" { … }` or `if var =~ /pattern/ { … }`. Subject is a bare identifier. Operators: `==` (exact string equality), `!=` (inequality), `=~` (regex match), `!~` (regex non-match). Operand is a `"string"` for `==`/`!=` or `/regex/` for `=~`/`!~`. Body is a brace block of valid workflow/rule steps. No `else` branch — use `match` for exhaustive value branching. `if` is a statement (no value production; cannot use with `const` or `return`). Allowed in both workflows and rules.
- **Prompts:** Three body forms: (1) **single-line string** `prompt "..."` — double-quoted, single line only; (2) **identifier** `prompt myVar` — uses the value of an existing binding; (3) **triple-quoted block** `prompt """ ... """` — for multiline text, opening `"""` on the same line as `prompt`. Triple backticks (`` ``` ``) in prompt context are rejected with guidance — they are reserved for scripts. Multiline double-quoted strings are rejected — use a triple-quoted block instead. All forms support `${identifier}` interpolation (`${varName}`, `${paramName}`). **Inline capture interpolation** is also supported: `${run ref([args])}` and `${ensure ref([args])}` inside the prompt string or triple-quoted body (e.g. `prompt "Fix: ${ensure get_diagnostics()}"`). Nested inline captures are rejected. Bare `$varName` is not valid in orchestration strings. `$(...)` and `${var:-fallback}` are rejected. Capture: `const name = prompt "..."`, `const x = prompt myVar`, `const y = prompt """ ... """`. Optional **typed prompt:** `const name = prompt "..." returns "{ field: type, ... }"` or `const name = prompt myVar returns "..."` (flat schema; types `string`, `number`, `boolean`) validates the agent's JSON and sets `${name}` plus per-field variables accessible via **dot notation** — `${name.field}`. Dot notation is validated at compile time: the variable must be a typed prompt capture and the field must exist in the schema. **Orchestration bindings are strings:** typed fields are coerced with `String()` after JSON validation, so e.g. a numeric field is still the text `"42"` in scope. See [Grammar](grammar.md).

**Quick reference examples:**

```jaiph
# recover — failure handling with retry via recursion
ensure ci_passes() recover (failure) {
  prompt "CI failed — fix the code."
  run deploy(env)
}

# match — value branching (statement and expression forms)
const label = match status {
  "ok" => "success"
  /err/ => "something went wrong"
  _ => "unknown"
}

# if — conditional guard (no else; use match for exhaustive branching)
if env == "" {
  fail "env was not provided"
}
if mode =~ /^debug/ {
  log "Debug mode enabled"
}

# typed prompt — structured JSON with dot-notation field access
const result = prompt "Analyze this code" returns "{ type: string, risk: string }"
log "Type: ${result.type}, Risk: ${result.risk}"

# const capture — from run, ensure, prompt
const tag = run get_version()
const ok = ensure validate(tag)
const answer = prompt "Summarize the changes"

# inline scripts — one-off commands without a named script definition
run `echo $1`("hello")
const ts = run `date +%s`()
```

Conventions:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default` (the runtime checks for it and exits with an error if missing).
- Inside a workflow, `run` targets a workflow or script (local or `alias.name`), not a raw shell command. Call scripts with `run`, never `fn args` or `$(fn ...)`.
- Inside a rule, use `ensure` for **rules** and `run` for **scripts only** — not `prompt`, `send`, or `run async`.
- Treat rules as non-mutating checks; perform filesystem or agent mutations in **workflows**. Script steps from rules use the same managed subprocess path as workflows. Details: [Sandboxing](sandboxing.md).
- **Parallelism:** `run async ref([args...])` for managed async with implicit join. For concurrent **bash**, use `&` and the shell builtin `wait` inside a **`script`** and call it with `run`. Do not call Jaiph internals from background subprocesses unless you understand `run.inbox_parallel` locking.
- **Shell conditions:** Express conditionals with `run` to a **script** and handle failure with `recover`, or use `if` / `match` for value branching. Short-circuit brace groups remain valid **inside `script`** bodies: `cmd || { ... }`.
- **No shell redirection around managed calls:** `run foo() > file`, `run foo() | cmd`, `run foo() &` are all `E_PARSE` errors — shell operators (`>`, `>>`, `|`, `&`) are not supported adjacent to `run` or `ensure` steps. Move shell pipelines and redirections into a **`script`** block and call it with `run`.
- **Shared bash:** Optional `.jaiph/lib/*.sh` — from a **`script`**, `source "$JAIPH_LIB/yourlib.sh"`. Emitted scripts default `JAIPH_LIB` to `${JAIPH_WORKSPACE:-.}/.jaiph/lib` unless set; the runtime also sets `JAIPH_LIB` for script steps. Keep Jaiph orchestration out of library files.
- **Unified namespace:** Channels, rules, workflows, scripts, script import aliases, and module-scoped `local`/`const` share a single namespace per module (`E_PARSE` on collision).
- **Calling conventions (compiler-enforced):** `ensure` must target a rule — using it on a workflow or script is `E_VALIDATE`. `run` in a **workflow** must target a workflow or script; `run` in a **rule** must target a **script** only. **Type crossing:** `string` and `script` are distinct primitive types — `prompt` rejects script names, `run` rejects string consts, assigning a script to a `const` or interpolating `${scriptName}` are all `E_VALIDATE`. See [Grammar — Types](grammar.md#types). Jaiph symbols must not appear inside `$(...)` in bash contexts the compiler still scans (principally **`script`** bodies). Script bodies cannot contain `run`, `ensure`, `config`, nested definitions, routes, or Jaiph `fail` / `const` / `log` / `logerr` / `return "…"`.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows and scripts via `run`.
- **Always run `jaiph format` on `.jh` files you create or modify before committing.** This ensures canonical whitespace, indentation, and top-level ordering. In CI, use `jaiph format --check` to gate on formatting.
- Use only syntax described in [jaiph.org](https://jaiph.org) and [Grammar](grammar.md). For advanced constructs (e.g. `config` block, `export`, prompt capture), see the grammar. For testing workflows, see [Testing](testing.md) (`expect_contain`, `expect_not_contain`, `expect_equal`, mocks).

## Writing Tests

Test files use the `*.test.jh` suffix and contain `test "name" { ... }` blocks. They import the workflows under test and use mocks to replace live agent/script behavior. The test runner uses the same `NodeWorkflowRuntime` as `jaiph run`. See [Testing](testing.md) for the full reference.

**Running:** `jaiph test` (all `*.test.jh` in workspace), `jaiph test <dir>` (recursive), or `jaiph test <file.test.jh>` (single file).

**Available mocks:**

- `mock prompt "fixed response"` — queues a fixed response for the next `prompt` call (multiple queue in order).
- `mock prompt { /pattern/ => "response", _ => "default" }` — content-based dispatch.
- `mock workflow alias.name() { return "stubbed" }` — replaces a workflow body.
- `mock rule alias.name() { return "ok" }` — replaces a rule body.
- `mock script alias.name() { echo "stubbed" }` — replaces a script body.

**Assertions:**

- `expect_contain var "expected substring"`
- `expect_not_contain var "unwanted text"`
- `expect_equal var "exact expected value"`

**Minimal example:**

```jaiph
import "main.jh" as app

test "happy path produces greeting" {
  mock prompt "hello from mock"
  const out = run app.default("task")
  expect_contain out "hello from mock"
}

test "handles failure gracefully" {
  mock prompt "error"
  const out = run app.default("bad input") allow_failure
  expect_contain out "error"
}
```

`allow_failure` prevents a non-zero workflow exit from failing the test — useful for testing error paths.

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` — Created by `jaiph init`; contains a single prompt that points the agent at `.jaiph/SKILL.md` (a copy of this guide).
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

Arguments after the file path are passed to `workflow default` as named parameters (when declared) and as `$1`, `$2` in script bodies.

## Minimal Sample (Agent Reference)

Use this as a shape to adapt. Paths and prompts should match the target repository. All three files live under `.jaiph/`. Imports in `main.jh` are relative to that file (e.g. `"readiness.jh"` resolves to `.jaiph/readiness.jh`). When you run `jaiph run .jaiph/main.jh "implement feature X"`, the default workflow receives `"implement feature X"` as `${task}` (named parameter). Note that `run` does not forward args implicitly, so the default workflow passes `task` as a bare identifier to `run implement(task)` so the implement workflow's prompt can use `${task}`.

**File: .jaiph/readiness.jh**

```jaiph
script git_is_clean = `test -z "$(git status --porcelain)"`

rule git_clean() {
  run git_is_clean() recover (err) {
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
script npm_test_ci = `npm test`

rule unit_tests_pass() {
  run npm_test_ci()
}

script run_build = `npm run build`

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
  prompt """
Implement the requested feature or fix with minimal, reviewable changes.
Keep edits consistent with existing architecture and style.
Add or update tests for behavior changes.

User asks for: ${task}
"""
}

workflow default(task) {
  run readiness.default()
  run implement(task)
  run verification.default()
}
```
