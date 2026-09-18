# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Treat every call result as an output handle; slurp only at force sites #dev-ready

Top-level idea (one page an agent can load):

**A call always runs now. Its result is an output handle, not a string. The bytes stay on disk (or in a pipe) until a force site slurps them into a JavaScript string. `stdin` and an unused result do not slurp.**

This is not lazy `const` (do not skip the script/def/prompt). This is lazy **slurp**.

Applies to every callee: named script, inline script, def, prompt. `recover` / `catch` bindings are the same type. When an `async` handle resolves, the result is this same output handle, then the same force rules. Do not invent a second handle kind.

No `read()`. No language-level byte cap that fails `const x = fetch()` at 256 KiB. Huge slurp may OOM; that is the author asking for the bytes. An optional `jaiph serve` / MCP host memory knob is allowed; it is not a second value type.

Hard rewrite. Today's `spawnAndCapture` always does `output += chunk` / `error += chunk` even for a discarded statement. Today's `recover` binding is a run-dir **path string** (leaks `.jaiph/runs/…/NNNNNN-*.out`). Both go away.

This task owns the **type**, **force/keep rules**, **docs**, **slurp tests**, and the **one-hop** connect `stdin <handle-or-call> -> script()` so those tests can run. It does not add multi-stage `-> a() -> b() -> c()`, a landing `stream` sample, OS-pipe overlap, or a 64 MiB pipeline volume pin.

### Force vs keep

**Force (slurp → `string`, can OOM):**

- `const x = <call>()`
- `return <call>()` — the callee yields a handle; the caller slurps only at a force site. Printing an entry def’s return should stream the file to the user, not slurp into V8 just to print.
- `if` / `match` subject
- `${x}` interpolation, argv, `log` / `logerr` / `logwarn`, `expect_*`
- `prompt """ … ${x} … """` (interpolation is a slurp)

**Keep as output handle (no JS body):**

- Statement call: `` `echo hi`() `` / `fetch_log()`
- `stdin <handle> -> script()` and `stdin <call>() -> script()` — stream bytes into the child
- `prompt <handle>` (identifier form) and `prompt analyze(<handle>)` when the arg is a handle — feed the file to the agent, do not build a JS string of the log
- Unused result
- `recover (failure)` / `catch (err)` binding — handle, not a path, not a string

```jh
fetch_log()                       # handle, discarded
stdin fetch_log() -> analyze()    # handle → pipe; producer may be def or script
const x = fetch_log()             # slurp; x is a string
stdin x -> analyze()              # too late: x is already a string
```

One-hop `stdin wrap() -> sink()` is required here (`wrap` is a def that `return`s a script). Multi-stage chains are out of scope.

### Value types (`docs/language.md` owns this)

Today the page says every value is `string` or `script` (the declaration). Add **output handle** as the result of a call:

| Type | What it is | Operations |
|---|---|---|
| `string` | Text. Literals, params, slurped handles. | `${…}`, argv, `if`, `log`, `const` of a string. |
| `script` | The declaration (unchanged). | Bare call `name(args)`. |
| output handle | Result of a script / def / prompt call, and of `recover` / `catch` bindings. | `stdin h -> script()`, `prompt h`. Force sites slurp to `string`. |

Crossings: interpolating / `if` / argv on a handle **is** the slurp (runtime). After slurp, it is a `string`. Do not interpolate a handle as a filesystem path. `script` still cannot be interpolated (`E_VALIDATE`).

`docs/language.md` **Value types** is the owner. Opening blurb that says “values are strings” must change. `docs/grammar.md` does not restate the table. `docs/jaiph-skill.md` gets **one sentence** plus a link (ADR 0003). `docs/why-jaiph.md` may get one sentence + link.

### Recover / catch

Binding is an output handle (failed step stdout at least; if `.err` is required, document and test that). Author never sees `…/NNNNNN-*.out`.

```jh
check_report_exists() recover (failure) {
  logerr "report.txt is missing"
  stdin failure -> tail_log()
  prompt failure
}
```

`logerr "${failure}"` slurps **contents**, not a path. One rule for all handles (same as `${x}` after `const x = \`echo hi\`()`). A test fails if the bound value matches `\.jaiph/runs/.+\.out`.

### Hard constraints

1. Statement-form script/def/prompt does not concatenate stdio into a JS string.
2. `const x = \`echo hi\`()` is the string `hi`. No `read()`. `expect_equal x "hi"` works.
3. `stdin <handle-or-call> -> script()` does not slurp the producer into a JS string first.
4. `def wrap() { return big() }` then `stdin wrap() -> sink()` streams; `const y = wrap()` slurps (RSS may grow / OOM — allowed).
5. No lazy execution. The call runs at the call site.
6. No `read()` keyword.
7. Producer of one-hop `stdin <call>() -> script()` may be a **def or a script**. Consumer is a script. `async` + `stdin` stays `E_PARSE`.

### Tests (each must fail if the contract is violated)

- **Statement no-slurp:** a script writes ≥ 64 MiB as a statement. Peak extra RSS of jaiph does not track 64 MiB (bound e.g. extra RSS < 16 MiB). Fails on today’s `output += chunk`.
- **Const slurp:** `const x = \`echo hi\`()` then `expect_equal x "hi"` and `log "${x}"`. Fails if this is `E_VALIDATE` or requires `read()`.
- **Const slurp is real:** `const x = big()` of 64 MiB — RSS may grow or OOM. A probe that `x` is a JS string of length N. Allowed to be expensive.
- **Stdin no-slurp:** `stdin big() -> sink()` — sink sees N bytes; peak extra RSS does not track N. Fails if `resolveStdin` builds a JS string of the body.
- **Def is a handle:** `def wrap() { return big() }` + `stdin wrap() -> sink()` — same no-slurp RSS pin. `const y = wrap()` slurps (opposite pin).
- **Recover is a handle:** `stdin failure -> sink()` copies failed-step stdout (or the documented stream) without the binding matching a run-dir `.out` path. `logerr "${failure}"` slurps contents, not a path.
- **Force sites slurp:** `if` / `${}` on a small script capture behave as today.
- **Docs:** `docs/language.md` Value types lists output handle and the force/keep table. `docs/jaiph-skill.md` has the one-sentence + link. A grep/docs test fails if the skill page restates the full table.

### Files that must not change

- Do not add `read()` or a stringify cap.
- Do not add multi-stage `foo() -> bar() -> baz()` or `examples/stream.jh`.
- Do not add highlighter work.
- Do not make `const` skip the call.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated. If an agent reading only `docs/language.md` **Value types** plus `docs/jaiph-skill.md` cannot state “call result is a handle; `const` / `if` / `${}` slurp; `stdin` does not,” the docs are not done.

## Add stdin call pipelines and a stream landing sample #dev-ready

Extend `stdin` so a producer can be a **call** (def or script) and so several **script** stages can be chained with `->`. Add a landing-page sample named `stream`.

Value model this task assumes (restate, do not depend on another task): a call result is an **output handle**. Uncaptured stages do not slurp into a JS string. `const` / `return` of a pipeline names the last stage and **slurps** that stage (so the last stage should reduce). Recover/catch bindings are handles, not run-dir paths. If that model is not in the runtime yet, this task still ships the **syntax**, AST, validator, format, small-data byte flow, sample, and docs for the pipeline form. It may buffer small fixtures. It does not own 64 MiB RSS, sleep/overlap, or OS-pipe backpressure.

### Surface

```jh
stdin content -> save(path)              # existing: string/value -> script
stdin foo() -> bar()                     # one hop: def or script -> script
stdin wrap() -> analyze()                # def producer (handle) -> script
stdin foo() -> bar() -> baz()            # three or more script consumers
stdin foo(x) -> bar(y) -> baz()
stdin content -> bar() -> baz()          # value, then two or more scripts
stdin `gen`() -> `tr a-z A-Z`()
const n = stdin foo() -> count()         # slurps last stage; last stage should reduce
```

A **pipeline** is any stdin form whose producer is a call, or that has two or more `->` stages. `stdin content -> save(path)` (one value, one script) is the existing connect, not a pipeline.

Rules:

- `stdin` requires at least one `->` and a call target (`E_PARSE` otherwise). `stdin foo()` with no `->` is `E_PARSE`.
- The producer (left of the first `->`) is a value (today’s `stdin_value`) **or** a call to a **def or script**. A prompt call as producer is `E_VALIDATE` unless you also implement `prompt` as a handle producer and test it.
- Every stage **after** the first `->` is a **script** call (named or inline). A def in a consumer slot is `E_VALIDATE`.
- `async` anywhere on a stdin pipeline is `E_PARSE` (`async is not supported with stdin`).
- **No `recover` on a pipeline.** `stdin foo() -> bar() recover (…) { … }` and `stdin foo() -> bar() -> baz() recover (…) { … }` are a compiler error. Compiler tests must reject both. Existing `stdin content -> save(path) recover (e) { … }` stays legal. `catch` on a pipeline is allowed (one-shot).
- First non-zero stage stops the pipeline. Later stages do not start.
- Progress tree: each script/def stage is its own step.

Format/emit must round-trip. Existing `stdin <value> -> script()` tests stay green.

### Sample

Add `examples/stream.jh`. Agent-free. Generate a few lines, transform, **reduce** (e.g. line count). `export def main` returns that last stage. No `prompt`. No `recover`.

`docs/index.html` Samples tab:

- button `stream.jh`
- `data-sample="stream"`
- `data-sample-file="stream.jh"`
- `[data-sample-source]` byte-for-byte with `examples/stream.jh`
- `[data-sample-output]` for `➜  ./stream.jh` matching a real `jaiph run`

Not in Playwright `SKIP_OUTPUT`. Pin the run in `e2e/tests/110_examples.sh` (or equivalent).

### Docs

`docs/language.md` owns pipeline meaning under **Arguments and stdin** (and links **Value types** for handle/slurp — do not copy the type table). `docs/grammar.md` owns EBNF. ADR 0003.

### Files that must not change

- Do not change argv/`ARG_MAX` for ordinary `script(arg)`.
- Do not require OS-pipe overlap or a 64 MiB RSS bound.
- Do not edit `examples/say_hello.jh` except if a shared landing fixture forces it; do not change other sample tabs except adding `stream`.
- Do not change highlighter grammars unless parse/format cannot land without it.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- `stdin foo() -> bar()`, `stdin wrap() -> bar()` (def producer), and `stdin foo() -> bar() -> baz()` parse. A compiler/unit test pins the AST.
- `stdin foo()` (no `->`) is `E_PARSE`. A **def in a consumer slot** is `E_VALIDATE`. `async` + stdin is `E_PARSE`.
- `stdin foo() -> bar() recover (e) { log e }` and the three-stage recover form are compiler errors. `stdin content -> save(path) recover (e) { … }` still parses.
- Run: `foo` writes `a\nb\n`, `bar` uppercases stdin, `baz` counts lines. User-visible result of `stdin foo() -> bar() -> baz()` (or `return` of it) is `2`. Swapping or dropping a stage fails the assertion.
- Run: `def wrap() { return foo() }` + `stdin wrap() -> bar()` produces the same transform as `stdin foo() -> bar()` on that small fixture.
- Existing `stdin content -> save(path)` parse/format tests still pass.
- `examples/stream.jh` has no `prompt` / `recover`, ends in a reduce, matches landing source-parity and `[data-sample-output]` after Playwright `normalize()`. `SKIP_OUTPUT` does not include `stream`.

## Stream stdin pipelines with bounded buffers and overlap #dev-ready

A stdin pipeline must move bytes between stages through a bounded buffer (OS pipe or equivalent), not by collecting one stage’s full stdout into a JavaScript string and then `stdin.end(whole)`. Producer and consumer overlap.

Value model (restate): a call result is an **output handle**. Uncaptured pipeline stages do **not** slurp. `const n = stdin foo() -> count()` **does** slurp the last stage (a reduce — small). Statement / uncaptured `stdin foo() -> bar() -> baz()` must not build those bodies as JS strings.

Surface this task requires (same form; no `|`, no hidden temp-file UX). If the grammar does not have it yet, **add it** — do not wait, do not invent a different syntax:

```jh
stdin foo() -> bar()
stdin wrap() -> analyze()          # def producer
stdin foo() -> bar() -> baz()
stdin content -> bar() -> baz()
```

Rules (restate): producer is a value or a **def/script** call; every stage after the first `->` is a **script**; `async` + stdin is `E_PARSE`; **no `recover` on a pipeline** (compiler error). `catch` may attach.

Do not add a stringify size cap. Size must not change whether a pipeline **succeeds**. `const` of a huge last stage may OOM — that is slurp, not this task’s volume pin.

The product case is a 50 MB log through `stdin fetch() -> analyze()`. The volume test is a correctness proof.

This task does not add `examples/stream.jh` or a new landing tab. If that sample already exists, do not rewrite it unless the progress tree forces a match update.

### Overlap (sleeps)

E2e that fails if stages are sequential materialize-then-spawn:

- Producer is **line-buffered / unbuffered** (`stdbuf -oL`, `python3 -u`, or equivalent). Document which (test Jaiph, not libc).
- Producer prints `start`, sleeps ~2s, prints `end`.
- Consumer prints `saw <line>` as each line arrives.
- `saw start` is observed **before** the sleep finishes / before the producer exits.

Do not use a tiny payload that fits in the OS pipe buffer and a consumer that only reads after EOF.

### Volume

≥ 64 MiB (1 GiB optional if CI allows). Producer writes N bytes; consumer counts or writes a file (reduce / sink). Assert:

- consumer sees exactly N bytes
- jaiph peak extra RSS does not track N (bound e.g. extra RSS < 16 MiB)

Do not spool the whole payload into one runtime-owned temp file and reread it. Per-stage `.out` only if streamed to disk with backpressure and **not** also held as a string. If `.out` would force a full in-memory copy, skip full-body capture for uncaptured piped stages and say so in `docs/language.md` (one owner, one sentence + link to Value types / stdin).

### Files that must not change

- Landing `stream` sample copy unless the tree output is forced to change.
- Argv/`ARG_MAX` for non-pipeline `script(arg)`.
- Prompt backends.
- Do not make `const` lazy (skip the call).
- Do not add `read()`.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- Sleep/overlap e2e fails if the runtime slurps `foo()` to a string, then spawns `bar()` with `stdin.end(thatString)`.
- Volume e2e fails if the runtime concatenates the payload (`output += chunk` across producer stdout) or peak extra RSS tracks N.
- Uncaptured piped stages have no full-body JS string.
- Small regression: `stdin foo() -> bar() -> baz()` with a reduce last stage still shows the same user-visible result as a correct sequential pipe.
- `const n = stdin foo() -> count()` on a tiny fixture still yields the count string (slurp of the last stage is required, not forbidden).
- `docs/language.md` states uncaptured pipeline stages stream; `.out` is disk-only when captured for audit.
