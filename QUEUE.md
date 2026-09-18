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

## Simplify say_hello valid_name to one fail arm #dev-ready

Drop the empty-string special case from the canonical `examples/say_hello.jh` sample. Empty and otherwise-invalid names share one fail message. Update every published copy and every test that pins the old message.

### Current

```jh
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ => name_arg
    "" => fail "You didn't provide your name :("
    _ => fail "You provided an invalid name :("
  }
}
```

### Target

```jh
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ => name_arg
    _ => fail "You provided an invalid name :("
  }
}
```

Keep the existing `# check the name before calling the agent` comment above the def. Do not change `export def main` or the prompt body.

### Behavior

- `valid_name("Adam")` / `hello.main("Alice")` still succeed (happy path unchanged).
- Missing or empty `name_arg` (e.g. `jaiph run examples/say_hello.jh` or `hello.main()`) now fails with `You provided an invalid name :(` — the `_` arm. There is no separate empty-string message.
- A non-matching name (`adam`, `ADAM`) still fails with the same `_` message.

### Files that must change

1. `examples/say_hello.jh` — source of truth. Remove the `"" => fail "You didn't provide your name :("` arm.
2. `examples/say_hello.test.jh` — keep the first test as an intentional miss so the landing page can show failing-test output. Point the expected string at the new message **without** the trailing `:(`, i.e. `expect_equal response "You provided an invalid name"`. Update the comment that explains the miss. The second (mocked happy-path) test stays as-is.
3. `docs/index.html` — landing `say_hello.jh` / `say_hello.test.jh` tabs. `[data-sample-source]` must stay byte-for-byte with `examples/` (`docs/contributing.md` source-parity rule). Update the failure-run output (`You provided an invalid name :(`) and the intentional-miss diff:
   - `- You provided an invalid name`
   - `+ You provided an invalid name :(`
4. `docs/first-agent-run.md` — the inlined `greet.jh` sample must drop the `""` arm. Rewrite the `match` explanation so `_` is the only reject arm (empty name and `adam` / `ADAM` all hit `_`). Section 3 still demonstrates a reject (empty string is fine) but must show `You provided an invalid name :(` and must not mention a distinct `""` arm.
5. `e2e/tests/95_say_hello_failure_output.sh` — expected `expect_equal` diff uses the new strings.
6. `e2e/tests/110_examples.sh` — same pinned failing-test output.

### Files that must not change

Do not retouch grammar/parser fixtures that only happen to use a similar fail string:

- `src/transpile/validate-match.test.ts`
- `src/parse/parse-match.test.ts`
- `e2e/match.jh`
- `e2e/tests/120_match_arm_execution.sh`

Do not change other landing-page samples (`recover_loop.jh`, `agent_inbox.jh`, `async.jh`).

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- `examples/say_hello.jh` has no `"" =>` arm and no `You didn't provide your name` string. `valid_name` has exactly two arms: the `/[A-Z][a-z]+/` success arm and `_ => fail "You provided an invalid name :("`.
- `examples/say_hello.test.jh` first test still fails on purpose: expected `You provided an invalid name`, actual `You provided an invalid name :(` (the `:(` mismatch remains the demo). Second test still passes with the mocked prompt.
- `jaiph test examples/say_hello.test.jh` exits non-zero and prints the new minus/plus pair. `e2e/tests/95_say_hello_failure_output.sh` and the say_hello.test.jh section of `e2e/tests/110_examples.sh` pass.
- `docs/index.html` `[data-sample-source]` for `say_hello.jh` and `say_hello.test.jh` matches `examples/` byte-for-byte. Landing failure output and failing-test diff use the new message. Playwright landing source-parity / output checks that cover these tabs pass.
- `docs/first-agent-run.md` sample and section 3 match the new contract. The page does not mention `You didn't provide your name` or a dedicated empty-string `match` arm.

## Highlight bare def and script calls in all three highlighters #dev-ready

`run` is not a keyword. A call is a name followed by `(`: `setup_env()`, `valid_name(name_arg)`, `const x = check_deps(path)`, `async helpers.scan()`, `stdin status -> shout(task)`. Highlight every such callee as a function in all three highlighters. Do not look up whether the name is defined — an unknown call is a compiler error, not a highlighter job.

The rule is mechanical: an identifier or qualified identifier immediately followed by `(` is a call. Declaration names that happen to sit before `(` (`def check_deps(path)`, `export prompt analyze(log)`) may use the same function scope. Keywords before `(` (`catch (err)`, `recover (err)`) stay keywords.

### Current

- VS Code TextMate (`plugins/vscode/syntaxes/jaiph.tmLanguage.json` `#calls`) already scopes a bare `name(` as `entity.name.function.jaiph` and the stdin-connect target the same way. Keep that rule. Add missing pins for a **def** call (`check_deps(` / `helper(`) and a **qualified** call (`helpers.scan(`). `run` must stay a non-keyword.
- Zed Tree-sitter (`plugins/zed/languages/jaiph/highlights.scm`) treats every identifier as `@variable`. `plugins/zed/test/highlights.test.mjs` currently **requires** `setup_env` to be `@variable`. Flip that: a callee before `(` is `@function`. A qualified callee (`helpers.scan(`) is `@function` (or `@function` on the qualified token), not `@property`. A non-call identifier (`status`, `item`, a stale `run` standing alone) stays `@variable`. Named `prompt analyze(` may keep its existing `@function` capture.
- Docs highlighter (`docs/assets/js/main.js`, used by `docs/index.html` and the Jekyll layout) only special-cases statement-start `name(`, `async name(`, and `stdin … -> name(`, and paints them as `ralph-identifier`. Expression-position calls (`const name = valid_name(name_arg)`) depend on a known-symbol set. Apply the same paren rule **anywhere on the line** and paint the callee with the existing function/identifier span (`ralph-identifier` is fine; do not invent a new CSS class unless a test needs it).

### Files that must change

1. `plugins/zed/languages/jaiph/highlights.scm` — query: identifier or `qualified_identifier` immediately followed by `"("`.
2. `plugins/zed/test/highlights.test.mjs` — and fixtures under `plugins/zed/test/fixtures/` if a needed call site is missing.
3. `plugins/vscode/syntaxes/jaiph.tmLanguage.json` — only if the existing `#calls` / stdin-connect patterns miss def or qualified callees.
4. `plugins/vscode/test/grammar.test.ts` — and `plugins/vscode/test/fixtures/` if needed.
5. `docs/assets/js/main.js` — paren rule for every `ident(` / `alias.name(`, not only statement start.
6. A **new** test that drives the docs highlighter (there is none today). A small Node test that feeds `.jh` snippets through the highlighter and asserts the callee is wrapped in `ralph-identifier` (or the class you keep) is enough. Extract a testable function if the IIFE blocks import. Do not rely on a visual check of `index.html`.

### Files that must not change

- The TypeScript compiler / parser / validator (`src/parse/**`, `src/transpile/**`). Highlighting is not a language change.
- `grammars/tree-sitter-jaiph/grammar.js` unless a query cannot see `ident` + `(` on the existing flat token stream. Prefer a query-only Zed fix. If the grammar must change, keep it lexer-style and update `grammars/tree-sitter-jaiph/test/corpus/` plus `plugins/zed` pins.
- `examples/**`, landing sample copy, and the `valid_name` fail-message wording. Those are a different task.
- Other editor features (formatting, diagnostics, language-configuration).

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- In all three highlighters, `setup_env()`, `const status = setup_env()`, `check_deps("package.json")`, and `async helpers.scan()` paint the callee as a function. Zed: `@function`. VS Code: `entity.name.function.jaiph` (qualified may be that scope on the last segment or on the whole `helpers.scan` token). Docs: the callee HTML uses the function/identifier class, including the expression-position form.
- `run` is not a keyword in any of the three. A lone `run` or `run.recover_limit` does not pick up call/function scope. `run save()` may highlight `save` as a call (it is `save()`); `run` itself stays an identifier/variable.
- Zed `plugins/zed/test/highlights.test.mjs` no longer asserts that `setup_env` is `@variable`. It asserts `@function` for that callee and for at least one def call and one qualified call from the fixture.
- VS Code `plugins/vscode/test/grammar.test.ts` pins a def-call callee and a qualified-call callee, not only `setup_env`.
- The new docs-highlighter test fails if `const name = valid_name(name_arg)` leaves `valid_name` unclassed, and fails if `catch (err)` paints `catch` as a call.
- `run` is not a keyword: existing Zed/VS Code assertions for that stay green.

## Add stdin call pipelines and a stream landing sample #dev-ready

Extend the `stdin` connect form so the left-hand side can be a call, and so several script calls can be chained with `->`. Add a landing-page sample named `stream`.

This task is about the language surface and correct byte flow on small data. Overlap, OS-pipe backpressure, and large-payload RSS bounds are out of scope.

### Surface

Legal forms:

```jh
stdin content -> save(path)              # existing: value -> script
stdin foo() -> bar()                     # call -> script
stdin foo() -> bar() -> baz()            # three or more script stages
stdin foo(x) -> bar(y) -> baz()          # each stage is a normal call
stdin content -> bar() -> baz()          # value, then two or more scripts
stdin `gen`() -> `tr a-z A-Z`()          # inline scripts allowed
const n = stdin foo() -> count()         # last stage should reduce
```

A **pipeline** is any stdin form whose producer is a call, or that has two or more `->` stages. `stdin content -> save(path)` (one value, one script) is the existing connect, not a pipeline.

Rules:

- `stdin` still requires at least one `->` and a call target (`E_PARSE` otherwise). `stdin foo()` with no `->` is `E_PARSE`.
- Every stage after the first `->` is a script call (named or inline). A def or other non-script in the chain is `E_VALIDATE`.
- The operand left of the first `->` is either a value (today's `stdin_value`) or a script call. A def as the producer is `E_VALIDATE`.
- `async` anywhere on a stdin pipeline is `E_PARSE` (`async is not supported with stdin`).
- **No `recover` on a pipeline.** `stdin foo() -> bar() recover (…) { … }` and `stdin foo() -> bar() -> baz() recover (…) { … }` are a compiler error (`E_PARSE` or `E_VALIDATE`). A compiler/unit test must reject both. Do not retry the producer. The existing single-script connect may still take `recover`: `stdin content -> save(path) recover (e) { … }` stays legal (`src/parse/parse-run-stdin.test.ts` already pins it). `catch` on a pipeline is allowed (one-shot, no retry).
- `const` / `return` of a pipeline names the **last** stage. That stage should **reduce** (count, checksum, `head`, write-to-path and print the path) so the user-visible result is short. The landing sample and the run pin check that visible result (CLI print / last-stage `.out`), not an in-memory copy of a pass-through stream.
- First non-zero stage stops the pipeline. Later stages do not start.
- The progress tree shows each script stage as its own step.

Existing `stdin <value> -> script()` must keep working. Format/emit must round-trip the new forms.

### Sample

Add `examples/stream.jh`. Agent-free. Teach the pipeline with small, deterministic scripts: generate a few lines, transform, **reduce** (e.g. line count). `export def main` returns that last stage. No `prompt`. No `recover` on the pipeline.

Add a Samples tab on `docs/index.html`:

- button label `stream.jh`
- `data-sample="stream"`
- `data-sample-file="stream.jh"`
- `[data-sample-source]` byte-for-byte with `examples/stream.jh` (landing source-parity in `docs/contributing.md`)
- one `[data-sample-output]` run block whose command is `➜  ./stream.jh` and whose tree matches a real `jaiph run` of that file

Do not put this tab in Playwright `SKIP_OUTPUT`. Wire `e2e/tests/110_examples.sh` (or an equivalent e2e) so `examples/stream.jh` is executed and its normalized tree is pinned.

### Docs

`docs/language.md` owns the meaning (`Arguments and stdin`), including: pipeline vs single-script connect, and no `recover` on a pipeline. `docs/grammar.md` owns the EBNF. Other pages get one sentence plus a link (ADR 0003).

### Files that must not change

- Do not change argv/`ARG_MAX` policy for ordinary `script(arg)` calls.
- Do not require OS-pipe overlap or a bound on resident memory. A later task owns that.
- Do not edit `examples/say_hello.jh` or other landing samples except to add the new tab.
- Do not change highlighter grammars unless a parse/format test cannot land without it.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- `stdin foo() -> bar()` and `stdin foo() -> bar() -> baz()` parse. A compiler/unit test pins the AST (producer call + N script stages).
- `stdin foo()` (no `->`) is `E_PARSE`. A def anywhere in the chain is `E_VALIDATE`. `async` + stdin is `E_PARSE`.
- `stdin foo() -> bar() recover (e) { log e }` is a compiler error. `stdin foo() -> bar() -> baz() recover (e) { log e }` is a compiler error. A compiler test fails if either is accepted. `stdin content -> save(path) recover (e) { … }` still parses.
- A run test: `foo` writes `a\nb\n`, `bar` uppercases stdin, `baz` counts lines (or equivalent reduce). `jaiph run` of `stdin foo() -> bar() -> baz()` (or `return` of that) shows `2` as the user-visible result. Swapping or dropping a stage fails the assertion.
- Existing `stdin content -> save(path)` still passes its current tests (`src/parse/parse-run-stdin.test.ts` and format round-trip).
- `examples/stream.jh` exists, has no `prompt` and no `recover`, ends in a reduce, and `jaiph run examples/stream.jh` matches the landing `[data-sample-output]` after the existing Playwright `normalize()`. Source-parity against `data-sample-file` passes. `SKIP_OUTPUT` does not include `stream`.

## Stream stdin pipelines with bounded buffers and overlap #dev-ready

A stdin pipeline must move bytes between script stages through a bounded buffer (OS pipe or equivalent), not by collecting one stage's full stdout into a JavaScript string and then `stdin.end(whole)`. Producer and consumer overlap.

Today's single-script spawn (`spawnAndCapture`) both appends `.out` on disk **and** concatenates `output += chunk` in RAM. A pipeline must not do that dual hold. `.out` is append-only on disk (streamed, backpressured). There is no JS string of a piped stage's body — including the last stage.

Surface (this task does not invent a different syntax):

```jh
stdin foo() -> bar()
stdin foo() -> bar() -> baz()
stdin content -> bar() -> baz()
```

If that form is not in the grammar yet, do not ship a substitute (`|`, implicit pipes, hidden temp files as the user-facing model). Implement or wait for the pipeline form; then change only **how** stages are executed.

**No `recover` on a pipeline** — compiler error. This task does not add recover-retry for pipes.

`const out = stdin foo() -> bar()` names the last stage (a reduce). It must not load that stage's `.out` into a JS string to "finish" the pipe. A pipeline used as a statement with no capture must not keep stdout as one in-memory string just to run the pipe.

A 50 MB log through `stdin fetch() -> analyze()` is the product case. A large-payload test is a correctness proof, not the reason the form exists.

Do not add a stringify size cap. Size must not change whether a pipeline succeeds.

### Overlap (sleeps)

Add an e2e (bash) that fails if stages are sequential materialize-then-spawn:

- Producer is **line-buffered / unbuffered** (`stdbuf -oL`, `python3 -u`, or equivalent). Document which, so libc pipe buffering is not the thing under test.
- Producer prints `start`, sleeps ~2s, prints `end`.
- Consumer reads lines and prints `saw <line>` as each line arrives.
- The test asserts `saw start` is observed **before** the sleep finishes — i.e. before the producer process exits. If `bar` only starts after `foo` closes stdout, the test fails.

A wall-clock assertion with a generous margin is fine (`saw start` within ~0.5s of pipeline start; producer still alive or sleep not elapsed). Do not use a tiny payload that fits in an OS pipe buffer and a consumer that only reads after EOF — that cannot distinguish streaming from buffering.

### Volume

A second test pushes a large payload (at least 64 MiB; 1 GiB is optional if CI time allows). Producer writes N bytes; consumer counts or writes to a file (reduce / sink). Assert:

- consumer sees exactly N bytes
- the jaiph process does not hold those N bytes as a JS string. Fail if peak extra RSS tracks payload size (document the bound, e.g. peak extra RSS < 16 MiB for a 64 MiB payload).

Do not satisfy this by spooling the whole payload into one runtime-owned temp file and then reading it. Per-stage `.out` may exist only if it is streamed to disk with backpressure and is **not** also held as a string. If a stage's `.out` would force a full in-memory copy, skip full-body capture for intermediate piped stages and say so in `docs/language.md` (one owner).

### Files that must not change

- Landing `examples/stream.jh` copy and `docs/index.html` sample text, unless a progress-tree change forces a match update. Do not add a new sample.
- Argv/`ARG_MAX` for non-pipeline `script(arg)` calls.
- Prompt / agent backends.
- Do not make `const` lazy.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- The sleep/overlap e2e fails if the runtime resolves `foo()` to a string, then spawns `bar()` with `stdin.end(thatString)`.
- The volume e2e fails if the runtime concatenates the payload into one string (`output += chunk` across the whole producer stdout) or if peak extra RSS tracks payload size.
- A piped stage has no full-body JS string. A test that would pass under today's `output += chunk` plus `appendFileSync` dual-hold must fail.
- `stdin foo() -> bar() -> baz()` on a small deterministic payload still shows the same user-visible result as a correct sequential pipe (regression). Last stage in that pin is a reduce.
- `docs/language.md` states that pipeline stages stream; `.out` is disk-only.

## Never hold script stdio as a JavaScript string #dev-ready

Hard rule: a script's stdout/stderr is not held as a JavaScript string **unless the author captured it**.

```jh
`echo hi`()              # statement: stream to .out / .err, no JS body
const x = `echo hi`()    # capture: materialize trimmed stdout into x (a string)
return `echo hi`()       # capture: materialize (this is the def's string value)
```

No `read()`. No file-backed type. No compile-time ban on `${x}` after a capture. `x` is a string, like today.

If they capture a huge stream, the process can OOM. That is the author asking for the bytes. Do **not** add a language-level size cap that fails `const x = fetch()` at 256 KiB — that is a Heisenbug. An optional **serve/runtime** memory or max-capture-bytes knob (DDoS on `jaiph serve` / MCP) is allowed as a host limit, documented next to the existing `JAIPH_SERVE_*` caps, not as a second string type.

This is a spawn-path change. Today's `spawnAndCapture` always does `output += chunk` / `error += chunk` and `returnValue: output.trim()`, even for a discarded statement. Kill that for the non-capture path. Capture still builds the string (and still writes `.out` / `.err` on disk).

Prompt / agent buffering is out of scope. Do not make `const` lazy.

### What materializes (capture)

These all produce a string in JS (and can OOM):

- `const x = script()` / `const x = \`echo hi\`()`
- `return script()` and `def wrap() { return fetch() }` then `const y = wrap()`
- `foo(bar())` when `bar` is a script (nested call arg)
- `${script()}` inline capture
- match-arm `=> script()`
- `const x = stdin foo() -> count()` (last stage captured)
- async handle resolve when the handle was captured (`const h = async script()` then a resolving read)

### What must not materialize

- Statement `script()` / `` `echo hi`() `` — disk + exit code only. No `StepResult.output` equal to the body.
- Pipeline stages that are not captured — OS pipe / disk, no JS body. `stdin foo() -> bar()` with no `const` does not build foo's or bar's stdout as a string.
- `recover` / `catch` binding — stays a **path** to `.out`, not the log bytes (already the language).

A def that only *calls* a script as a statement does not inherit that script's stdout as a string. `return fetch()` is a capture and does.

### Hard constraints

1. Statement-form script spawn has no `output += chunk` / `error += chunk` (or join/concat of the whole stream) into a JS string.
2. Capture-form may build a string of stdout (trimmed, like today). Stderr of a captured script still must not be concatenated into a leftover JS string if it is only on disk (`.err`).
3. No `read()` keyword or stdlib.
4. No file-backed capture type. No `E_VALIDATE` on `log "${x}"` when `x` came from `const x = script()`.
5. No language-level stringify cap. OOM on huge `const` is acceptable. Optional host DDoS limit is not a language rule.

### Tests (each must fail if the contract is violated)

- **Statement RSS:** `` `dd … 64MiB`() `` (or equivalent) as a statement. Peak extra RSS does not track 64 MiB. Fails on today's always-`output += chunk`. Sibling case for large stderr, statement form.
- **Capture is a string:** `const x = \`echo hi\`()` then `expect_equal x "hi"` and `log "${x}"` work with no `read()`. A compiler/unit test fails if this is `E_VALIDATE`.
- **Capture can be large:** `const x = big()` of 64 MiB either holds the string (RSS may grow — that is allowed) or the process OOMs / hits an optional host max. The task is not failed by RSS growth on this path. The statement-form test must still pass in the same binary.
- **Def statement vs return:** `def a() { big() }` then `a()` — no 64 MiB string. `def b() { return big() }` then `const y = b()` — `y` is the bytes (or OOM).
- **Static / unit:** statement spawn path does not return `{ output: <full stdout> }`. Capture path does provide the trimmed stdout string.

### Docs

`docs/language.md` owns: statement vs capture; capture is a string; huge capture may OOM; recover binding remains a path. No `read`. ADR 0003: one owner.

### Files that must not change

- Do not add lazy `const`.
- Do not change prompt backends.
- Do not invent a second pipeline syntax. If `stdin foo() -> bar()` exists, uncaptured stages obey the statement rule; a `const` of the pipeline is a capture of the last stage.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated. If a statement-form script still builds a full-body JS string, the task is not done. If `const x = \`echo hi\`()` is not a string, the task is not done.

## Treat every call result as an output handle; slurp only at force sites #dev-ready

Top-level idea (write this in docs so an agent can load one page and get it):

**A call always runs now. Its result is an output handle, not a string. The bytes stay on disk (or in a pipe) until a force site slurps them into a JavaScript string. `stdin` and an unused result do not slurp.**

This is not lazy `const` (do not skip the script/def/prompt). This is lazy **slurp**.

Applies to every callee: named script, inline script, def, prompt. `recover` / `catch` bindings are the same type. When an `async` handle resolves, the result is this same output handle, then the same force rules. Do not invent a second handle kind.

No `read()`. No language-level byte cap that fails `const x = fetch()` at 256 KiB (Heisenbug). Huge slurp may OOM; that is the author asking for the bytes. An optional `jaiph serve` / MCP host memory knob is allowed; it is not a second value type.

Hard rewrite. Today's `spawnAndCapture` always does `output += chunk` / `error += chunk` even for a discarded statement. Today's `recover` binding is a run-dir **path string** (leaks `.jaiph/runs/…/NNNNNN-*.out`). Both go away.

### Force vs keep

**Force (slurp → `string`, can OOM):**

- `const x = <call>()`
- `return <call>()` (the caller’s `const` / `if` / `${…}` then force that returned handle, or slurp if the entry def’s return is printed as text — prefer streaming the file to the user; do not slurp into V8 just to print)
- `if` / `match` subject
- `${x}` interpolation, argv, `log` / `logerr` / `logwarn`, `expect_*`
- `prompt """ … ${x} … """` (interpolation is a slurp)

**Keep as output handle (no JS body):**

- Statement call: `` `echo hi`() `` / `fetch_log()`
- `stdin <handle> -> script()` — stream the handle’s bytes into the child
- `prompt <handle>` (identifier form) and `prompt analyze(<handle>)` when the arg is a handle — feed the file to the agent (backend stdin or equivalent), do not build a JS string of the log
- Unused result
- `recover (failure)` / `catch (err)` binding — `failure` is a handle, not a path, not a string

```jh
fetch_log()                       # handle, discarded
stdin fetch_log() -> analyze()    # handle → pipe (def/script/prompt all legal producers)
const x = fetch_log()             # slurp; x is a string
stdin x -> analyze()              # too late: x is already a string
```

`stdin foo() -> bar()` (call as producer) is the same handle rule. If that surface is not in the grammar yet, this task still ships `stdin <handle-or-ident> -> script()` for a bound handle and for today’s `stdin <value> -> script()`. Do not invent `|` or a second connect syntax.

### Value types (`docs/language.md` owns this)

Today the page says every value is `string` or `script` (the declaration). Add **output handle** as the result of a call:

| Type | What it is | Operations |
|---|---|---|
| `string` | Text. Literals, params, slurped handles. | `${…}`, argv, `if`, `log`, `const` of a string. |
| `script` | The declaration (unchanged). | Bare call `name(args)`. |
| output handle | Result of a script / def / prompt call, and of `recover` / `catch` bindings. | `stdin h -> script()`, `prompt h`. Force sites slurp to `string`. |

Crossings: interpolating / `if` / argv on a handle **is** the slurp (runtime), not `E_VALIDATE`, except you must not interpolate a handle as if it were a filesystem path. After slurp, it is a `string`. `script` still cannot be interpolated (`E_VALIDATE`).

`docs/language.md` is the owner (existing **Value types** section). Opening blurb that says “values are strings” must change. `docs/grammar.md` does not restate the table. `docs/jaiph-skill.md` gets **one sentence** plus a link to that section (ADR 0003): agents must treat a call result as a handle until `const` / `if` / `${…}`. `docs/why-jaiph.md` may get one sentence + link, not a second essay.

### Recover / catch

Binding is an output handle (stdio of the failed step: stdout at least; if `.err` is the useful stream, the handle must include it or the docs must say stdout-only — pick one and test it). Author never sees `…/NNNNNN-*.out`.

```jh
check_report_exists() recover (failure) {
  logerr "report.txt is missing"
  stdin failure -> tail_log()
  prompt failure
}
```

`logerr "${failure}"` slurps (or, if you ban `${handle}` and only allow `prompt failure` / `stdin failure ->`, that is stricter — **do not ban** `${failure}` if `const x = \`echo hi\`()` still slurps via `${x}`; one rule for all handles). Path leak is a failed task: a test fails if the bound value matches `\.jaiph/runs/.+\.out`.

### Hard constraints

1. Statement-form script/def/prompt does not concatenate stdio into a JS string.
2. `const x = \`echo hi\`()` is the string `hi`. No `read()`. `expect_equal x "hi"` works.
3. `stdin <handle> -> script()` does not slurp the handle into a JS string first.
4. `def wrap() { return big() }` then `stdin wrap() -> sink()` streams; `const y = wrap()` slurps (RSS may grow / OOM — allowed).
5. No lazy execution. The call runs at the call site.
6. No `read()` keyword.

### Tests (each must fail if the contract is violated)

- **Statement no-slurp:** a script writes ≥ 64 MiB as a statement. Peak extra RSS of jaiph does not track 64 MiB (document the bound, e.g. extra RSS < 16 MiB). Fails on today’s `output += chunk`.
- **Const slurp:** `const x = \`echo hi\`()` then `expect_equal x "hi"` and `log "${x}"`. Fails if this is `E_VALIDATE` or requires `read()`.
- **Const slurp is real:** `const x = big()` of 64 MiB — RSS may grow or process OOMs. A probe that `x` is a JS string (length N) or that interpolation succeeded with N bytes. This path is allowed to be expensive.
- **Stdin no-slurp:** `stdin big() -> sink()` (or `const h` only if `h` is still a handle — it is not, after `const`; so the producer must be a call or a recover binding). Sink sees N bytes. Peak extra RSS does not track N. Fails if `resolveStdin` builds a JS string of the body.
- **Def is a handle:** `def wrap() { return big() }` + `stdin wrap() -> sink()` — same no-slurp RSS pin. `const y = wrap()` slurps (opposite pin).
- **Recover is a handle:** recover body `stdin failure -> sink()` copies failed-step stdout (or the documented stream) without the binding matching a run-dir `.out` path. `logerr "${failure}"` slurps contents, not a path.
- **Force sites slurp:** `if` / `${}` on a small script capture behave as today (string compare / interpolate).
- **Docs:** `docs/language.md` Value types lists output handle and the force/keep table. `docs/jaiph-skill.md` has the one-sentence + link. A docs/structure or grep test fails if the skill page restates the full table.

### Files that must not change

- Do not add `read()` or a stringify cap in the language.
- Do not change highlighter grammars unless a new keyword appears (none should).
- Do not add a landing `stream` sample here (separate task if the pipeline tab is in the queue).
- Do not make `const` skip the call.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated. If an agent reading only `docs/language.md` **Value types** plus `docs/jaiph-skill.md` cannot state “call result is a handle; `const` / `if` / `${}` slurp; `stdin` does not,” the docs are not done.
