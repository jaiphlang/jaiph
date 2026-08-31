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

## Close sterile-env and named-prompt `use` follow-ups #dev-ready

Context: Scripts spawn through `buildScriptEnv` (`src/runtime/kernel/env-allowlist.ts`): process-base env + `SCRIPT_CONTRACT_ENV_NAMES` + `use ∩ --env`. Named prompts inject `use` via `buildPromptUseEnv` after `scrubPromptEnv`. Several holes remain from that rewrite.

Do all of the following in one change. Do not edit `.jaiph/` (orchestration-owned).

1. **Shell-fallthrough lines inherit the full runner env.** Free-form def body lines become `exec`/`shell` and run via `executeShLine` (`src/runtime/kernel/node-workflow-runtime.ts`), which passes `scope.env` (a copy of `process.env` plus `--env`) to `sh -c`. Named/inline scripts are sterile; `echo "$GITHUB_TOKEN"` as a bare def line is not. Spawn those lines with the same sterile env as an inline script (no `use` — shell lines have no definition site). Keep interpolation + `shellQuote`. Kernel keys stay out.

2. **Codex ignores named-prompt `use`.** `runBackend` (`src/runtime/kernel/prompt-backends.ts`) merges `useEnv` for Cursor/Claude/custom, then returns early to `runCodexBackend(...)` without `useEnv`. Thread `useEnv` into Codex the same way. Anonymous prompts still pass none.

3. **Nested `import` / `config` become shell, not `E_PARSE`.** Nested defs use `parseBraceBlockBody` without `onConfigBlock` (`src/parse/workflow-brace.ts`). `import` is not a statement, so those lines become `sh -c`. Reject `import` / `import script` and `config {` inside any nested def body as `E_PARSE` (same class as nested `export`). Top-level `import` / `config` unchanged.

4. **`JAIPH_ENV_GRANT` reaches prompt agents.** `scrubPromptEnv` forwards all `JAIPH_*` except `JAIPH_SERVE_*` and `JAIPH_CHAIN_KEY`. Drop `JAIPH_ENV_GRANT` the same way as `CHAIN_KEY_ENV` (`src/env-reserved.ts`). Values stay gated by `buildPromptUseEnv`.

5. **`src/cli/run/use-envs.ts` stores raw NUL bytes** in the `planUseEnvs` dedupe key; git treats the file as binary. Replace with a printable separator (`|` or `JSON.stringify` of the fields). Do not change grant semantics.

6. **Cross-module `use` has no spawn test.** `use` lives on the definition. Callers `import "lib.jh" as lib` / `run lib.publish()` must not repeat `use`. Preflight already walks the graph (`src/cli/run/use-envs.test.ts`). Runtime uses `resolveScriptRef` → `script.use`. Same-file `import script … use` is tested; `run lib.publish()` putting the other file's key in the child env is not.

### Acceptance criteria
- Spawn-spy or equivalent: a bare def shell line run with `UE_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `JAIPH_SERVE_TOKEN` in the runner env does **not** put those keys (or `JAIPH_CHAIN_KEY` / `JAIPH_RUN_SUMMARY_FILE`) in the `sh -c` child env. Existing named-script `use` + `--env` tests stay green.
- Named prompt `use GITHUB_TOKEN` + `JAIPH_ENV_GRANT=GITHUB_TOKEN` + `agent.backend = "codex"` puts `GITHUB_TOKEN` on the Codex child/request env; an anonymous `prompt "x"` in the same run does not. Claude/Cursor `use` tests stay green.
- `def outer() { def inner() { import "x.jh" as y } }` and `def outer() { def inner() { config { agent.backend = "claude" } } }` are `E_PARSE`. A nested def with only `run` / `const` / nested `script` still compiles.
- Prompt-backend spawn-spy: agent env does not contain `JAIPH_ENV_GRANT` when the runner env has `JAIPH_ENV_GRANT=GITHUB_TOKEN`.
- `src/cli/run/use-envs.ts` contains no NUL (`\\x00`) bytes; `git diff` shows it as text; `planUseEnvs` tests still pass.
- Spawn-spy: entry `import "lib.jh" as lib` with **no** `use` of its own; `lib.jh` has `export script publish use UE_TOKEN`; granted `JAIPH_ENV_GRANT` / `--env`; `run lib.publish()` child env has `UE_TOKEN`. Fails if the key is missing.
- `npm run build` and `npm test` pass.

