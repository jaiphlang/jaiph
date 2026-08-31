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

## Sterile script env, `use` on scripts, `--env` as the only grant #dev-ready

Context: Script/`run` subprocesses inherit the runner’s full `process.env` (`resolveRuntimeEnv` copies the host env; `executeRunRef` passes `scope.env` into `executeScript`). Prompt agents are already fail-closed (`scrubPromptEnv`). `trusted_envs` plus `--env` grant extra keys on top of that inherit. A script that execs agent-edited tree content (for example `npm run build`) therefore sees host credentials such as `CLAUDE_CODE_OAUTH_TOKEN` unless the script author strips them by hand.

Problem: Ambient inherit is the default. `--env KEY` is not a gate. `trusted_envs` is entry-only injection into the declaring def’s script spawns and is named as if the keys were “trusted.” There is no fail-closed allowlist for scripts.

Remediation — implement exactly this (hard rewrite; remove `trusted_envs`):

1. **Sterile script spawn.** Every named script, `import script`, and inline script subprocess receives only:
   - the prompt base env names/prefixes already listed in `PROMPT_BASE_ENV_NAMES` / `PROMPT_BASE_ENV_PREFIXES` (`src/runtime/kernel/env-allowlist.ts`) — process mechanics, not secrets;
   - runtime contract keys the script is documented to read: `JAIPH_WORKSPACE`, `JAIPH_SCRIPTS`, `JAIPH_RUN_DIR`, `JAIPH_ARTIFACTS_DIR` (and empty `JAIPH_AGENT_MODEL` if scripts under `set -u` rely on it today);
   - host keys requested by that **script’s** `use` clause, intersected with the `--env` grant (below).
   Do not forward the rest of the host env. Do not forward agent credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`) unless the script `use`s that name (do not special-case-forbid them). Keep scrubbing `JAIPH_CHAIN_KEY` and `JAIPH_RUN_SUMMARY_FILE` from script env. Keep `JAIPH_SERVE_*` out.

2. **`use` on the written script body only** (definition site, not the `run` call):
   ```
   script aaa use GITHUB_TOKEN NPM_TOKEN = `gh …`
   export script aaa use GITHUB_TOKEN = `…`
   import script "./gh.sh" as gh use GITHUB_TOKEN
   ```
   Grammar: `use` is reserved. Clause is `use` IDENT { IDENT } after the script name (and after `as` alias for `import script`), before `=`. Identifiers only — no quotes, no `${…}`. Multiple `use` lines are not needed; one clause, space-separated keys. Same reserved-key set as today’s `--env` (`E_ENV_RESERVED` / `isReservedEnvKey`). Invalid names: `E_ENV_INVALID` (or `E_PARSE` with that contract).
   **Not in this task:** `use` on defs, on `run` call sites, or on prompts. A def that `run`s a script does not grant or deny keys; the script declaration does. `run bbb()` where `bbb` is a def never injects host keys into `bbb`.

3. **`--env` is the only grant.** A `use` key reaches the script iff it was passed as `jaiph run|serve|mcp --env KEY` or `--env KEY=VALUE`. Presence on the host environment without the flag is not enough. Bare `--env KEY` still resolves the host value and still `E_ENV_MISSING` if unset (existing `resolveEnvPairs`). `--env KEY=VALUE` still overrides.

4. **Preflight before spawn** (`jaiph run`, `jaiph serve`, `jaiph mcp` — same stage as today’s credential / `trusted_envs` preflight). Collect every `use` key in the **import graph**. Each must appear in the `--env` spec list. Missing → `E_ENV_MISSING` naming the key (and that it was `use`d but not passed as `--env`). Unused extra `--env FOO` is allowed. A graph with no `use` does not require `--env`. **`jaiph test` does not fail** for missing `--env`; if `--env` is passed, inject those keys into matching `use` spawns; otherwise the key is absent in the spawn.

5. **Delete `trusted_envs`.** Parse, metadata, `planTrustedEnvs`, runtime `trustedEnv` / `scrubTrustedKeys` trusted-key injection, docs, and tests go away. `--env` remains the operator grant; `use` is the request.

6. **Docs:** `docs/grammar.md`, `docs/language.md`, `docs/jaiph-skill.md`, `docs/configuration.md` (remove trusted_envs), `docs/cli.md`, `docs/env-vars.md`. State: scripts are sterile by default; `use` + `--env`; prompts stay on `scrubPromptEnv` (no host `--env` secrets) until a later named-prompt task.

### Acceptance criteria
- A script with no `use` spawned under a host env that sets `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` does not receive those keys in the child `env` (spawn-spy or equivalent unit test; fails on today’s inherit).
- A script `use GITHUB_TOKEN` run with `jaiph run --env GITHUB_TOKEN` receives the host/flag value; the same script run without `--env GITHUB_TOKEN` does not start (`E_ENV_MISSING`) even if `GITHUB_TOKEN` is set on the host (CLI/integration test).
- `import script "…" as gh use GITHUB_TOKEN` has the same spawn/preflight contract as a named `script gh use GITHUB_TOKEN`.
- `run callee()` where `callee` is a def whose body runs a script that does **not** `use GITHUB_TOKEN` does not put `GITHUB_TOKEN` in that script’s env, even when `--env GITHUB_TOKEN` was passed (no def-level leak, no call-tree propagate).
- `jaiph test` on a file whose import graph `use`s `GITHUB_TOKEN` exits 0 without `--env` when the script is mocked or does not require the value to succeed; it must not hard-fail preflight the way `jaiph run` does.
- `trusted_envs` is `E_PARSE` (unknown config key). Existing `trusted_envs` unit tests are replaced by `use` tests, not left passing against the old contract.
- `npm run build`, `npm test`, and `npm run test:e2e` pass; grammar/skill/config docs describe `use` and sterile script env.

## Named prompts with parameters and `use` #dev-ready

Context: Prompts exist only as def-body steps (`prompt_stmt`). `prompt IDENT` today means the prompt **text** is the in-scope identifier `IDENT` (`prompt_body` includes IDENT). Scripts can declare `use KEY` on the definition (sterile spawn + `--env` grant). Prompts have no definition site, so a prompt cannot request extra host keys without a call-site `use` (which this language is not adding) or a named prompt form.

Problem: A prompt agent that must see `GITHUB_TOKEN` (or any non-backend host key) has no definition-site `use`. Anonymous `prompt """…"""` must stay sterile extra-keys (existing `scrubPromptEnv`). Backend credentials (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / …) stay the prompt default and are **not** written as `use`.

Remediation — implement exactly this:

1. **Module-level named prompt**, same namespace as `script` / `def` / `const` / channels:
   ```
   prompt analyze_ci(log) use GITHUB_TOKEN = """
     Look at this CI log:
     ${log}
   """

   prompt analyze_ci(log) use GITHUB_TOKEN = """
     …
   """
   returns "{ summary: string }"
   ```
   - Signature: `prompt` IDENT `(` [param_list] `)` [ `use` IDENT { IDENT } ] `=` prompt_rhs.
   - RHS: the same bodies as today’s prompt step — double-quoted single line or `"""…"""` (opening `"""` ends the line; closing `"""` on its own line). No triple-backtick fence. Interpolation in the RHS is `${name}` (Jaiph orchestration), including parameters.
   - Optional `returns` schema on the definition (same schema rules as today’s step-level `returns`). A `returns` named prompt used without `const` capture is `E_PARSE`, same as today.
   - `export prompt` allowed, same export rules as `export script` / `export def`.
   - `use` clause: same grammar and reserved-key rules as `use` on scripts. If script `use` is not in the tree yet, implement the shared clause parser here and wire preflight for these keys (same `--env`-only grant as scripts: flag required, host presence insufficient). If script `use` already exists, reuse it.

2. **Invoke with parentheses:** `prompt analyze_ci(log)` or `const out = prompt analyze_ci(log)`. Zero args: `prompt analyze_ci()`. Bare `prompt analyze_ci` (no `()`) remains the **existing** identifier-as-body form (prompt text = value of `analyze_ci`). Do not remove that form. Arity must match the named prompt’s param list (`E_VALIDATE`), including `()`.

3. **`run analyze_ci()` is invalid** when `analyze_ci` is a named prompt (`E_VALIDATE`: prompts are invoked with `prompt`, not `run`). Scripts/defs stay `run`.

4. **Env at the agent subprocess.** Named prompt `use KEY` injects KEY into that invocation’s agent env (on top of `scrubPromptEnv` for that backend). Anonymous `prompt "…"` / `prompt """…"""` still do not receive `--env` secrets. Do not add `use` to the anonymous step form.

5. **Preflight.** Named-prompt `use` keys join the import-graph `use` set. `jaiph run` / `serve` / `mcp` require each on `--env`. `jaiph test` does not hard-fail that preflight (same as scripts).

6. **Docs:** `docs/grammar.md`, `docs/language.md`, `docs/jaiph-skill.md`. State the `prompt name()` vs `prompt name` distinction. Parentheses-everywhere applies to named prompt calls.

### Acceptance criteria
- Parse + format round-trip for `prompt foo(a) use GITHUB_TOKEN = "…"` and the `"""` form with `returns`.
- `const x = prompt foo("hi")` interpolates `${a}` / param `a` in the named body and invokes the agent; a test with a mocked prompt asserts the expanded text contains `hi`.
- `prompt foo` with no `()` still uses identifier-as-body when `foo` is a string binding; `prompt foo()` invokes the named prompt when `foo` is a `prompt` definition (`E_VALIDATE` if the name is the wrong kind).
- `run foo()` when `foo` is a named prompt is `E_VALIDATE`.
- Spawn/env test: named prompt `use GITHUB_TOKEN` plus `--env GITHUB_TOKEN` puts the value in the agent child env; an anonymous `prompt "x"` in the same def does not get `GITHUB_TOKEN`.
- `jaiph run` without `--env GITHUB_TOKEN` on a file that `use`s it on a named prompt fails preflight with `E_ENV_MISSING`.
- Wrong arity `prompt foo()` vs `prompt foo(a, b)` is `E_VALIDATE`.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Nested script, named prompt, const, and def inside defs #dev-ready

Context: Top-level modules already hold `const`, `script`, `def`, and (after named prompts exist) `prompt` in one namespace. A def body already allows `const` as a **step** (`const_decl_step`). It does not allow nested `script`, named `prompt`, or `def`. Scripts and named prompts therefore cannot be scoped to the def that uses them; everything lives at module scope.

Problem: Modern languages allow local functions. Jaiph forces every helper script/def/prompt to pollute the module namespace. Nested definitions are sequential local bindings: simple, and they let a def close over its parameters in nested **interpreted** forms (`def`, named `prompt` bodies) without adding call-site `use`.

Remediation — implement exactly this:

1. **A def body may declare** nested `const` (already), `script`, named `prompt`, and `def`. Same surface as module-level for each (including `use` on nested `script` / named `prompt`, params on nested `def` / named `prompt`). **No `export` on nested declarations** (`E_PARSE`). **No nested `config` / `import` / `channel`.**

2. **Sequential local scope, not hoist.** A nested name is visible only in the enclosing def, and only **after** its declaration (same as today’s `const` steps). Using it above the declaration is `E_VALIDATE` (unknown / not in scope). Nested names share one local namespace with the def’s parameters and `const` bindings: duplicates are `E_PARSE` (same unified-namespace rule, but per def). A nested name **may shadow** a module-level `script` / `def` / `prompt` / `const` of the same name; the local binding wins for the rest of the body. Nested declarations do not shadow the enclosing def’s parameters (`E_PARSE` / existing immutable-binding rule — same as `const` vs param).

3. **Call rules (unchanged verbs):**
   - nested script → `run name(args)`
   - nested def → `run name(args)` (and `run async` allowed, same as top-level defs)
   - nested named prompt → `prompt name(args)` with parentheses
   Outer module code and other defs **cannot** `run` / `prompt` another def’s nested names (`E_VALIDATE`).

4. **Closure vs subprocess:**
   - Nested **def**: interpreted in-process. Its body interpolates the enclosing def’s params and consts (lexical scope) plus its own params. It does **not** inherit a parent `use` (defs still have no `use`). Child def’s nested scripts/prompts use their own `use` only.
   - Nested **named prompt**: body interpolated at **invocation** from the enclosing scope (params/consts visible), plus its own parameters. `use` on that nested prompt is the only extra host-key injection for that agent spawn.
   - Nested **script**: still a subprocess. Enclosing bindings are **not** auto-exported into its env. Pass argv (`run inner(param)` → `$1`). Sterile env + its own `use` + `--env` grant (same as module-level scripts).

5. **Emit.** Nested scripts are emitted as script files with stable unique names (hash or enclosing-def-qualified), same interpreter/shebang path as top-level scripts. Do not require the OS exec bit.

6. **If named prompts are not in the tree yet**, nested `prompt name(params) = …` is still required by this task — implement the named-prompt definition/call forms at least for the nested case (module-level named prompts may land in the same change if cheaper than two parsers). If they already exist, reuse the same productions inside `def_step`.

7. **Docs:** `docs/grammar.md` (`def_step` includes the nested decls), `docs/language.md`, `docs/jaiph-skill.md`. State: not hoisted; no export; scripts do not close over; defs/prompts interpolate enclosing scope at runtime.

### Acceptance criteria
- Parse a def that contains a nested `script`, nested `def`, nested named `prompt`, and `const`, then `run` / `prompt` them later in the same body; `jaiph format` round-trips.
- `export script` / `export def` / `export prompt` inside a def is `E_PARSE`.
- Nested name used before its declaration is `E_VALIDATE`. Nested name colliding with a parameter is rejected. Nested `script foo` shadows module-level `script foo` for `run foo()` after the nested declaration; a unit/e2e test shows the nested body ran, not the module one.
- A nested def interpolates an enclosing parameter in a `log` / `return` without that param being passed as an argument to the nested def.
- A nested script whose body prints `"$1"` does **not** see the enclosing param unless it was passed as `run nested(param)`; a test fails if the child env or stdout contains the enclosing param with no argv pass.
- Another def in the same file cannot `run nested_helper()` when `nested_helper` is declared only inside `outer` (`E_VALIDATE`).
- Nested script `use GITHUB_TOKEN` participates in `--env` preflight the same way as a module-level `use` (fail `jaiph run` without the flag).
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

