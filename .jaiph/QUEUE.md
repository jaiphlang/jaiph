# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Support top-level env <!-- dev-ready -->

Add top-level variable declarations to Jaiph using the `local` keyword (bash parity). Variables are prefixed to avoid collisions, similar to how functions are prefixed.

**Keyword**: `local` only in this iteration. Matches bash parity and the existing commented-out usage in `.jaiph/docs_parity.jh`. A future iteration could add `const` (mapping to bash `readonly`).

**Variable prefixing**: Use `__` (double underscore) as the separator — e.g., `local role` in module `entry` becomes bash variable `entry__role`. The `::` separator used for function names is invalid in bash variable identifiers (`[a-zA-Z_][a-zA-Z0-9_]*`), so `__` is the natural alternative with low collision risk.

**Multi-line string values**: Reuse the same quoting rules as `prompt` strings (double-quote delimited, spanning multiple lines). The parser infrastructure for this already exists.

**Scope / visibility**: Module-scoped only, not exportable. Importing modules cannot access another module's locals. Cross-module variable access can be considered in a future iteration.

### Acceptance criteria

1. Parser accepts `local <name>=<value>` at the top level (single-line and multi-line string values). New parse function in `src/parse/` following the pattern of `rules.ts`/`functions.ts`.
2. New `EnvDeclDef` type added to `src/types.ts`; `jaiphModule` gains `envDecls?: EnvDeclDef[]`.
3. Transpiler emits prefixed bash variable assignment (e.g., `entry__role="..."`) at the top of the generated script, before function/rule/workflow definitions.
4. A shim or `local` alias is emitted inside each function/rule/workflow body so `$role` resolves to the prefixed variable (e.g., `local role="$entry__role"`).
5. `docs_parity.jh` compiles and runs correctly with the `local role` uncommented.
6. Grammar doc (`docs/grammar.md`) updated with the new `env_decl` production.
7. At least one e2e test exercising a top-level local with multi-line string value.
8. Unified namespace check in `src/parser.ts` extended to prevent variable names from colliding with rule/function/workflow names.

---

## Bug: Docker not enabled by default for local execution <!-- dev-ready -->

**Symptom**: Running `e2e/say_hello.jh` on a local machine does not spawn a Docker container, even though the intended behavior is Docker-by-default locally.

**Root cause**: `DEFAULTS.enabled` in `src/runtime/docker.ts:82` is `false`. In `resolveDockerConfig()` (line 107), when no env var or in-file config is set, the fallback path evaluates `ciDefault ? false : DEFAULTS.enabled` — which is `false` in all cases. Docker is therefore never enabled unless explicitly configured.

**Fix**: Change `DEFAULTS.enabled` from `false` to `true` in `src/runtime/docker.ts:82`. The existing CI detection logic (`env.CI === "true"` at line 98) already disables Docker in CI environments, so no additional changes are needed for CI behavior.

### Files to modify

1. `src/runtime/docker.ts` — change `enabled: false` to `enabled: true` in `DEFAULTS` (line 82).
2. `test/docker.test.ts` — update the "defaults when no in-file and no env" test (line 99) to expect `enabled: true`. Verify the CI=true test still expects `enabled: false`.

### Acceptance criteria

1. `resolveDockerConfig(undefined, {})` returns `enabled: true` (Docker on by default locally).
2. `resolveDockerConfig(undefined, { CI: "true" })` returns `enabled: false` (Docker off in CI).
3. Explicit `JAIPH_DOCKER_ENABLED=false` env var still disables Docker locally.
4. In-file `runtime.docker_enabled = false` still disables Docker locally.
5. Existing e2e and unit tests pass (with updated assertions).

---

## Restructure .jaiph/runs directory <!-- dev-ready -->

Currently it's too bloated. I'd like to have a different directory structure. It should be:

.jaiph/runs/2026-03-18/07-03-28-<jaiph-file-name.jh>/

### Implementation notes

- **Source file name**: `run.ts` already has the input file path (`inputAbs`). Pass the basename (e.g., `say_hello.jh`) to the runtime via a new `JAIPH_SOURCE_FILE` env var.
- **Directory format**: `<date>/<HH-MM-SS>-<basename>/` where date is `YYYY-MM-DD` and time is local (not UTC), matching the user's example.
- **Collision handling**: If the directory already exists (same file run twice in the same second), append `-2`, `-3`, etc.
- **Run ID**: Still generated via `jaiph::new_run_id()` and exported as `JAIPH_RUN_ID` for internal tracking / JSONL events. Just no longer part of the directory name.
- **`JAIPH_RUNS_DIR` override**: Still respected — the date/time subdirectory structure applies under the custom root as well.

### Files to modify

1. `src/cli/commands/run.ts` — export `JAIPH_SOURCE_FILE` env var (basename of input file) before spawning the shell.
2. `src/runtime/steps.sh` — rewrite `jaiph::init_run_tracking()`: build path as `<runs_dir>/<YYYY-MM-DD>/<HH-MM-SS>-<source_file>/`, handle collision suffix.
3. `src/cli/shared/errors.ts` — `latestRunFiles()` still works (reads a flat dir); no change needed.
4. `e2e/tests/70_run_artifacts.sh` — update assertions to match new directory layout.

### Acceptance criteria

1. Running `jaiph run foo.jh` creates `.jaiph/runs/YYYY-MM-DD/HH-MM-SS-foo.jh/` with `run_summary.jsonl` and step artifacts inside.
2. Running the same file twice within one second produces two distinct directories (collision suffix).
3. `JAIPH_RUNS_DIR` override still works; date/time subdirs are created under the custom root.
4. Existing e2e tests pass (updated as needed).
5. `JAIPH_RUN_ID` is still generated and available in the runtime environment.

---

## Harden inbox <!-- dev-ready -->

Add e2e coverage for the inbox/dispatch system and a homepage sample demonstrating it.

### E2E tests

Currently only unit/golden tests exist (`test/compiler-golden.test.ts` with `test/fixtures/inbox.jh`). Add a new shell-based e2e test (`e2e/tests/91_inbox_dispatch.sh`) following the project's existing pattern (`e2e::prepare_test_env`, heredoc `.jh` files, `e2e::assert_*` helpers). Cover at minimum:

1. **Basic send + route**: A workflow sends a message on a channel; a routed workflow receives it as `$1` and echoes it. Assert the echoed output.
2. **Multi-target route**: `on channel -> wf1, wf2` dispatches to both targets sequentially. Assert both produce output.
3. **Silent drop on unregistered channel**: A send to a channel with no route does not error. Assert exit code 0.
4. **Inbox file written**: After a send, `.jaiph/runs/.../inbox/001-<channel>.txt` exists with the message content.

### Homepage sample

Add an "inbox" tab to `docs/index.html` alongside the existing three sample tabs. Use a short, self-contained example (e.g., a two-workflow pipeline: one sends findings, one receives and summarizes). Keep it under ~15 lines of Jaiph code. Follow the existing tab markup pattern (`.code-tab-button[data-target]` + `.code-panel[data-panel]`).

### Acceptance criteria

1. `e2e/tests/91_inbox_dispatch.sh` passes as part of `npm run test:e2e`.
2. All four scenarios above are covered with assertions.
3. `docs/index.html` has a fourth sample tab showing an inbox workflow.
4. Existing e2e and unit tests still pass.
