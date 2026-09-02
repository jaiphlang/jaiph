# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, **orchestration** removes that section (`queue.remove_completed_task` in `.jaiph/engineer.jh`). Agents and humans implementing a task must **not** edit `QUEUE.md` to delete or rewrite the current task — leave queue updates to the workflow.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Nested `def` self-recursion matches module-level `def` #dev-ready

Context: A module-level `def fact(n) { … run fact(…) }` validates. A nested `def fact` does not: `validateDefTree` passes `localsSoFar` without the name being defined (`src/transpile/validate.ts` around the nested-def walk). Runtime would work once the `local_decl` has registered `fact` in `scope.locals`.

Problem: nested helpers cannot recurse. Sibling forward-ref (`def a() { run b() }` declared before `def b`) should stay `E_VALIDATE` (sequential, not hoisted). Mutual recursion of two nested defs is out of scope unless it falls out of allowing self.

Remediation — implement exactly this:

1. When validating a nested `def`'s body, include that def's own name in the local map (self only).
2. Do not hoist later siblings.
3. Runtime: a nested `def fact` that calls itself must hit the existing recursion-depth cap (`256`), not a missing-local failure.
4. Docs: one line under Nested declarations — a nested def may call itself; it may not call a nested def declared later.

### Acceptance criteria
- Nested `def fact(n)` that `run fact(…)` on the recursive arm validates; a test fails on today's tree.
- `def a() { run b() }` then `def b()` later in the same def is still `E_VALIDATE` unknown local `b`.
- Runtime: nested `fact` with a base case returns the computed value; a runaway nested recursion hits the existing depth error (not "unknown local").
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Editor plugins: current-surface highlighting leftovers #dev-ready

Context: VS Code TextMate (`plugins/vscode/syntaxes/jaiph.tmLanguage.json`) and Zed/Tree-sitter (`grammars/tree-sitter-jaiph`, `plugins/zed/`) already highlight `use`, named prompt **definitions**, nested `script`/`prompt`, `send … ->`, and stale-keyword regressions. Gaps left after the 0.14.0 review:

1. `#if-statement` in the TextMate grammar only matches a bare `IDENT` subject. Language allows `IDENT.IDENT` (`if answer.risk == "high"`). `answer` / `risk` get no typed-prompt field scopes.
2. Named prompt **invocation** `prompt analyze(log)` is not scoped as `entity.name.function.prompt` on the callee (only the `prompt` keyword).
3. Tree-sitter `grammar.js` still tokenizes `<-` as an `@operator`. The language send form is `->` only; `<-` is `E_PARSE`.
4. Fixtures (`plugins/vscode/test/fixtures/current.jh`, `plugins/zed/test/fixtures/current.jh`) now include a nested `def helper` but have no `export prompt` line and no named-prompt call site.

Remediation — implement exactly this (do not invent a plugin framework):

1. Extend the TM `if` subject to `IDENT` or `IDENT.IDENT` with the same field scopes used for `${var.field}`.
2. Add a TM (and Zed highlight query, if the grammar exposes the node) pattern so `prompt name(` at a call site scopes `name` as a prompt function.
3. Drop `<-` from the tree-sitter operator choice. Regenerated `src/` parser must be committed. Zed query tests must still pass.
4. Add `export prompt` and `const x = prompt analyze(log)` (or `describe`) to both `current.jh` fixtures; assert scopes in `plugins/vscode/test/grammar.test.ts` and the Zed highlight suite.
5. Negative: a fixture line using `<-` must **not** get `keyword.operator.send.jaiph` (VS Code) or a send-operator capture (Zed).

### Acceptance criteria
- `if answer.risk == "ok"` in a VS Code grammar fixture asserts field-access scopes on `answer` / `risk`.
- `const x = prompt analyze(log)` asserts `analyze` has `entity.name.function.prompt.jaiph` (or the Zed equivalent).
- `<-` is not a tree-sitter operator token; `npm test` in `plugins/zed` regenerates and query-checks.
- Stale-keyword regression tests keep passing (`wait` / `local` / `rule` / `workflow` / `ensure` / `inbox`).
- `plugins/vscode`: `npm test`. `plugins/zed`: `npm test`.

## Sweep leftover `workflow` / sandbox wording on live surfaces #dev-ready

Context: The language and runtime no longer have `workflow` / `rule` / `ensure` or a first-party Docker sandbox. User-visible strings and a few tests still teach the old nouns. Historical CHANGELOG entries stay as history.

Live leftovers found in review (re-grep; do not treat this list as exhaustive):

- `src/runtime/kernel/node-workflow-runtime.ts` send-outside-context error: `"workflow execution context"`.
- `src/parse/channels.ts` route error still says `channel <name> -> <workflow>`.
- `src/runtime/kernel/shell-jaiph-guard.ts` diagnostic text still mentions `channel send (<-)`.
- `e2e/tests/30_filesystem_side_effects.sh` "readonly sandbox" branch (`unshare`/`sudo`) is not a Jaiph sandbox and always skips on macOS CI. `docs/contributing.md` still documents `e2e::readonly_sandbox_available`.
- `design/2026-07-14-mcp-server.md` still describes Docker mode / `JAIPH_UNSAFE` (design note; either a one-line "superseded" banner or delete the sandbox claims).
- Test titles in `src/parse/parse-steps.test.ts` (`ensure:` section that tests `run`) and similar.

Remediation — implement exactly this:

1. Change operator-facing error strings to `def` / `send … ->` wording. Keep internal identifiers (`WORKFLOW_RUNNER_ARG`, filenames) unless a rename is a few lines with no behavior change.
2. Remove or rewrite the e2e readonly-sandbox branch so CI does not pretend Jaiph still has a sandbox helper. Update `docs/contributing.md`.
3. Banner or trim the MCP design note so it cannot be read as current sandbox contract.
4. Rename misleading test titles/comments that say `ensure`/`workflow` when they assert `run`/`def`. Do not churn passing assertions.

### Acceptance criteria
- Grep of `src/` `*.ts` (excluding `*.test.ts` comments if you must) for user-facing `"workflow execution"` / `-> <workflow>` / `channel send (<-)` is empty.
- `e2e/tests/30_filesystem_side_effects.sh` no longer documents a Jaiph readonly sandbox; contributing docs match.
- A unit test asserts the send-outside-context (or equivalent) message says `def`, not `workflow`, if that path is reachable; otherwise the string is gone.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Runner env is constructed; `--env` values stay off the runner process #dev-ready

Context: `resolveRuntimeEnv` (`src/cli/run/env.ts`) starts from `{ ...process.env }`. `jaiph run` / `serve` / `mcp` then `Object.assign(runtimeEnv, extraEnv)` (`src/cli/commands/run.ts`, `src/cli/shared/workflow-call-exec.ts`). `jaiph test` spreads `process.env` and `extraEnv` onto the runtime env (`src/runtime/kernel/node-test-runner.ts`). `NodeWorkflowRuntime` snapshots `this.env` as `hostEnvSnapshot` and reads `--env` values from that snapshot (`buildScriptEnv`, `buildPromptUseEnv` in `src/runtime/kernel/env-allowlist.ts` / `node-workflow-runtime.ts`).

Script and prompt *children* are already fail-closed (`buildScriptEnv`, `scrubPromptEnv`). The runner process is not. A host key that was never `--env`-granted still sits on the runner. A key that *was* granted sits on the runner even when only a script `use`s it.

Problem: this program is the intended shape — a script pushes with `GITHUB_TOKEN`, an anonymous / non-`use` prompt must not see that key — but the runner process environment still carries both ungranted host keys and the `--env` values:

```
script push use GITHUB_TOKEN = `gh auth setup-git && git push`

export def main() {
  prompt "implement the change"
  run push()
}
```

`jaiph run --env GITHUB_TOKEN app.jh` (value from host or `KEY=VALUE`) puts `GITHUB_TOKEN` on the workflow leader env. `GITHUB_TOKEN` present on the host without `--env` is copied there too.

Remediation — implement exactly this:

1. Build the runner process env from an allowlist, not a copy of the host environment. Reuse the existing prompt-base names/prefixes (`PROMPT_BASE_ENV_NAMES` / `PROMPT_BASE_ENV_PREFIXES`), `JAIPH_*` control keys (minus the existing `JAIPH_SERVE_*` carve-out), and the backend credential keys the runner must hold so `scrubPromptEnv` can forward them to the matching agent. Do not invent a second parallel list unless a runner-only key is missing from those sets (then add it in one place and document it).
2. `--env` values must not appear on the runner process environment (the `env` passed to `spawnJaiphWorkflowProcess` / `buildRunModuleLaunch`, `this.env` on `NodeWorkflowRuntime`, and the `jaiph test` runtime env object). Keep grant *names* on `JAIPH_ENV_GRANT` as today. Hold grant *values* in a side map the runtime already has at spawn of a `use` script or `use` named prompt. The detached workflow leader must receive that map through a channel that is not the leader's `env` and not a file under the workspace or `JAIPH_RUN_DIR` (those paths are visible to prompt backends).
3. `hostEnvSnapshot` must not be "the whole runner env". Granted `use` values resolve from the grant map. Ungranted host keys are absent from both the runner env and the grant map.
4. Do not change the `use` ∩ `--env` rule, `E_ENV_MISSING` preflight, reserved-key rejection, or `scrubPromptEnv` / `applyUseEnv` for named prompts. A named prompt with `use GITHUB_TOKEN` still receives the value; an anonymous prompt and a named prompt without `use` still do not.
5. Docs: `docs/script-env.md` and the spawn-env / journal paragraph in `docs/why-jaiph.md` must state that `--env` values are injected only into subprocesses whose declaration `use`s the key, and are not present on the runner process environment. Keep the existing limit: this is not a sandbox; a same-user agent that can run a shell is not confined to child `env`.

### Acceptance criteria

Runner construction (`src/cli/run/resolve-env.test.ts` or a dedicated runner-env test):
- Host `UNOWNED_SECRET=x` with no `--env UNOWNED_SECRET`: the object returned as the workflow-leader / runtime env does not contain `UNOWNED_SECRET`. Today's `{ ...process.env }` must fail this case.
- `--env GITHUB_TOKEN=ghs_test`: that env object does not contain `GITHUB_TOKEN`. `JAIPH_ENV_GRANT` still lists `GITHUB_TOKEN`.
- `PATH`, `HOME`, `JAIPH_WORKSPACE`, and (when set) `ANTHROPIC_API_KEY` still appear on the runner env so backends and scripts keep working.

Grant injection (runtime tests next to `node-workflow-runtime.script-env.test.ts` / `named-prompt.test.ts`):
- Script with `use GITHUB_TOKEN` + `--env` still sees the value in the script child env (existing happy path must keep passing).
- Script without `use`, anonymous `prompt`, and named prompt without `use` still do not see `GITHUB_TOKEN` in the child env.
- Named prompt with `use GITHUB_TOKEN` + `--env` still sees the value (`applyUseEnv`).
- `NodeWorkflowRuntime` constructed the way `jaiph run` / `jaiph test` will construct it after this task: `this.env.GITHUB_TOKEN` is undefined while the `use` script child still receives the granted value.

CLI spawn:
- The `env` passed into `spawnJaiphWorkflowProcess` / `buildRunModuleLaunch` for `jaiph run --env GITHUB_TOKEN=ghs_test` does not contain `GITHUB_TOKEN`. A unit test on the launch helper (or the run-command assembly) fails on today's `Object.assign(runtimeEnv, extraEnv)`.

Docs + suite:
- `docs/script-env.md` and `docs/why-jaiph.md` state the runner-env rule above.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.
