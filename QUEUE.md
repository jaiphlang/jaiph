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

## Stream a prompt identifier handle; do not slurp #dev-ready

`prompt x` and `prompt ${x}` (identifier / bare-ref body) must keep an output handle as a handle. Stream the handle's on-disk bytes into the agent transport. Do not `readFileSync` the whole file into a JavaScript string. The agent is sent the **contents**, never a `.jaiph/runs/…/*.out` path.

This is the same keep-as-handle rule as `stdin x -> script()`. It is **not** a new syntax.

Value model (restate): a call result is an output handle. Force sites slurp to a string: `const`, `if` / `match` subject, `${x}` interpolation **inside** a constructed string, a call argument, `log` / `logerr` / `logwarn`. Keep as a handle: unused statement, `stdin <handle> ->`, recover/catch binding until forced, and **`prompt x` / `prompt ${x}`**.

### Current wrong behaviour

`docs/language.md` lists a prompt body that names a handle as a force site. The runtime interpolates the body to a JS string (`interpolateWithCaptures` then `executePrompt(promptText: string)`). `prompt x` therefore slurps. A multi-megabyte handle OOMs the jaiph process before the backend runs. Fix that path.

### What still slurps (do not change)

- `prompt "… ${x} …"` and `prompt """… ${x} …"""` — interpolation builds a string; that **is** a slurp. A huge handle embedded that way may OOM — the author asked for the bytes.
- `prompt analyze(x)` — a named-prompt **argument** is a call argument (force).
- `const`, `if`, argv, `log`, `stdin` connect, recover/catch, pipelines.

### Transport

Claude / custom backends already take the prompt on stdin. Pipe the handle **file** (or an equivalent read stream). Do not `printf %s` a slurped string, and do not `readFileSync` then pipe.

A backend that must buffer (HTTP JSON) may read the file at the send site only. Do not slurp earlier in interpolate / `runPromptStep`.

The `Prompt:` transcript / artifact must not accumulate the body as a JS string in order to write it. Stream from the file, or omit a full-body dump for a handle-sourced prompt. Do not write a run-dir path into the transcript as a stand-in for the body.

`executePrompt` may grow a file/stream source. No new `.jh` keyword. No `read()`. No stringify size cap.

### Tests

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- `prompt x` with `x` a ≥ 64 MiB handle: the mock/backend receives the contents (not a path); jaiph peak extra RSS does not track N (same class of bound as the stdin no-slurp pins).
- The same fixture via `prompt ${x}` (bare-ref, not inside a quoted string) behaves the same — no slurp, contents delivered.
- `prompt """wrap ${x}"""` on a small handle still interpolates (force). The delivered body is the wrapped string, not the handle file alone.
- Delivered body never matches `/\.jaiph\/runs\/.+\.out/`.
- `docs/language.md` Value types: identifier / bare-ref prompt is keep-as-handle; interpolated prompt body is force. `docs/jaiph-skill.md` one-liner matches if it currently says every prompt slurps.

### Files that must not change

- stdin / pipeline streaming.
- recover/catch binding semantics.
- Argv / `ARG_MAX` for `script(arg)`.
- Do not make `const` lazy. Do not add `read()`.

## Merge stdout and stderr into a recover handle #dev-ready

A `recover` / `catch` binding is an **output handle** for the failed step. Today that handle is the failed step's **stdout** only (`valueFile` / `.out`). Stderr stays in the sibling `.err` and is not on the handle. A typical Unix failure writes the useful text to stderr and leaves stdout empty (or a heartbeat), so `${failure}` and `stdin failure -> sink()` are often empty unless every producer does `2>&1`.

Change the recover/catch handle so its bytes are the failed step's **stdout then stderr** (one handle, one stream). The recovery body still never sees a `.jaiph/runs/…/*.out` path. Force sites slurp those merged contents; `stdin failure -> script()` streams them.

This is **only** the recover/catch binding. A successful call's handle stays stdout. `const x = foo()` and `stdin foo() -> bar()` do not grow stderr.

Do not add a second binding (`recover (out, err)`). Do not invent a new `.jh` keyword. Do not add `read()`. Do not add a stringify size cap. Do not require producers to `2>&1` — that remains legal (and better when the author wants chronological interleave) but is no longer required for recover to see stderr.

### Current contract to replace

`docs/language.md` and e2e `101` / `102` pin the binding as failed **stdout** contents. `102` writes a line to stderr and asserts it is **absent** from the streamed handle. Those tests must flip: the stderr line is **in** the handle, after the stdout bytes. Update the docs sentence that says the binding is the failed step's stdout.

Implementation sketch (not prescriptive): on failure, the handle's `valueFile` is a merge of the step's `.out` then `.err`, or an equivalent single capture the runtime writes. `${failure}` / a call argument / `if failure` slurps that file; `stdin failure ->` streams it. Empty stdout + non-empty stderr still yields a non-empty handle.

### Tests

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- Script prints `out-line` to stdout, `err-line` to stderr, exits 1. `catch (failure) { stdin failure -> save(path) }` writes a file that contains `out-line` then `err-line`. The file is not a run-dir path and does not match `/\.jaiph\/runs\/.+\.out/`.
- The same fixture via `logerr "${failure}"` / a call argument slurps the merged contents, not a path.
- Stderr-only failure (stdout empty, stderr `boom`, exit 1): the handle is `boom` (trimmed the same way a stdout handle is trimmed). Recover is usable without `2>&1` on the producer.
- Success regression: `const x = foo()` where `foo` writes `ok` to stdout and `noise` to stderr stays `ok`. `stdin foo() -> sink()` on a successful `foo` still delivers stdout only.
- `docs/language.md` catch/recover section states the binding is merged failed stdout+stderr as one handle. e2e `101` / `102` match the new contract (they currently assert stdout-only).

### Files that must not change

- stdin / pipeline streaming of a **successful** call (stdout only).
- `prompt` body slurp vs stream (separate task).
- Argv / `ARG_MAX` for `script(arg)`.
- Do not make `const` lazy. Do not add `read()`.
- Do not change `run.recover_limit` / retry loop shape.
