# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   - breaking changes are allowed,
   - backward compatibility is **not** a design goal unless a task explicitly says otherwise.

---

## Language — replace `if` with generalized `recover`, remove implicit retry loop <!-- dev-ready -->

**Goal**  
Simplify the error-handling model from three overlapping mechanisms (`if ensure/run`, `ensure … recover` with implicit retry loop, `match`) to two orthogonal ones (`recover` as a catch-like handler, `match` for value-based branching). Concretely:

1. **Remove `if` statements entirely.** The `if ensure …` / `if run …` construct conflates control flow with execution. Every use case maps to `recover` (failure handling) or `match` (value branching).
2. **Change `recover` semantics: no implicit retry loop.** Currently `recover` retries up to `JAIPH_ENSURE_MAX_RETRIES` (default 3) automatically. Instead, `recover` runs its body **once** on failure — like a `catch` clause. Retries require explicit recursion (the workflow/rule calls itself).
3. **Extend `recover` to all call types.** Currently `ensure … recover` is workflow-only. Support `recover` on `ensure` and `run` calls in workflows, rules, and scripts.

**Migration patterns**

```jaiph
# OLD: if ensure check { run deploy } else { run rollback }
# NEW:
ensure check recover (err) {
  run rollback
  return
}
run deploy

# OLD: if not ensure check { run fix }
# NEW:
ensure check recover (err) { run fix }

# OLD: implicit 3-retry loop
# NEW: explicit recursion
workflow deploy {
  ensure tests_pass recover (err) {
    run fix_tests(err)
    run deploy
  }
}
```

**Context**

- `if` parser: `src/parse/workflow-brace.ts` — `parseIfBraceHead` / `parseElseIfBraceHead`.
- `if` runtime: `src/runtime/kernel/node-workflow-runtime.ts` — `executeSteps`, `if` branch (~line 954).
- `recover` parser: `src/parse/steps.ts` — `parseEnsureStep`, `parseRecoverStatement`.
- `recover` runtime: `src/runtime/kernel/node-workflow-runtime.ts` — `executeEnsureRef` (~line 1167), retry loop with `JAIPH_ENSURE_MAX_RETRIES`.
- `recover` validation restriction (rules): `src/transpile/validate.ts` (~line 478) — `E_VALIDATE` when `recover` appears in a rule body.
- AST types: `src/types.ts` — `IfConditionDef`, `WorkflowStepDef`.
- Grammar docs: `docs/grammar.md` — `if_brace_stmt`, `ensure_stmt`.
- E2E tests: `e2e/tests/78_lang_redesign_constructs.sh`, `e2e/tests/60_ensure_conditionals.sh`, `e2e/tests/114_if_else_chains.sh`, `e2e/tests/61_ensure_recover.sh`, `e2e/tests/100_ensure_recover_invalid.sh`.

**Implementation notes**

- **`run … recover` is new syntax.** Removing `if` requires `run X recover (err) { … }` to handle workflow/script failures inline.
- **Recursion safety.** Implement tail-call optimization (detect self-call in tail position, reuse frame) or enforce a recursion depth limit with a clear error.
- **Migrate all `.jh` files** in `examples/`, `.jaiph/`, and `e2e/` that use `if` to `recover` + `match`.

**Acceptance criteria**

- `if` keyword no longer parses (produces `E_PARSE`).
- `recover` runs its body once on failure, no implicit retry loop.
- `ensure … recover` and `run … recover` work in workflows, rules, and scripts.
- `run … recover` syntax parses, validates, and executes correctly.
- Recursion depth is bounded (TCO or hard limit with clear error).
- All existing E2E tests pass (migrated away from `if`).
- `docs/grammar.md` and `CHANGELOG.md` updated.

---

## Docs — write `language.md` covering all core language primitives <!-- dev-ready -->

**Goal**  
Create `docs/language.md` — a single, self-contained reference for Jaiph's language fundamentals. Structured for humans: each primitive gets **concept → brief description → example → details/edge cases**. This replaces `grammar.md` as the go-to language doc (grammar.md stays as the formal EBNF reference).

**Structure per section**

```
## <Concept>
One-paragraph high-level description.

    <minimal working example>

**Details:** edge cases, constraints, gotchas.
```

**Primitives to cover (in this order)**

1. **Strings** — double-quoted literals, escape sequences, `${…}` interpolation, `"""…"""` heredocs, rejected shell-isms (`$(…)`, `${var:-…}`)
2. **Variables (`const`)** — module-level `const`, step-level `const`, bare identifier args as implicit `"${name}"`, scope rules
3. **Scripts** — named scripts (backtick, fenced, shebang), inline scripts (`` run `cmd` ``), interpreter tags (`` ```python ``), `${…}` passthrough in fenced vs blocked in backtick
4. **Workflows** — definition, parameters, calling via `run`, `run async`, return values (`return "…"`, `return run …`, `return ensure …`, `return match …`), workflow-scoped `config`
5. **Rules** — definition, parameters, calling via `ensure`, success = exit 0, restricted step set (no `prompt`, no `run async`, no `recover`, scripts only via `run`)
6. **Prompts** — `prompt "…"`, `prompt """…"""`, backends (`cursor`, `claude`), `agent.default_model` / `agent.backend` config, capturing results (`const x = prompt …` / `x = prompt …`)
7. **Structured prompt output (`returns`)** — `prompt "…" returns "schema"`, JSON schema strings, field access via `${result.field}`, validation rules
8. **Pattern matching (`match`)** — `match var { … }`, patterns (`"literal"`, `/regex/`, `_`), arm bodies, expression form (`const x = match …`, `return match …`), exactly-one-wildcard rule
9. **Error handling (`recover`)** — `ensure … recover (failure) { … }`, `recover (failure, attempt) { … }`, single-run semantics (post-redesign), recursion for retries, `run … recover` (post-redesign)
10. **`fail` and `return`** — aborting vs returning, `fail "message"`, bare `return`, value returns, interaction with recover
11. **Logging (`log`, `logerr`)** — string/heredoc/bare-identifier forms, stdout vs stderr
12. **Channels and inbox (`channel`, `send`)** — `channel name`, `channel name -> wf1, wf2`, `send channel <- "…"`, send RHS forms (literal, variable, `run`, forward), dispatch semantics
13. **Imports** — `import "path" as alias`, `.jh` auto-append, qualified references (`alias.name`), `export` on workflows/rules
14. **Config** — module-level `config { … }`, workflow-level `config { … }`, allowed keys, value types, `runtime.*` (module-only) vs `agent.*`/`run.*`
15. **Conditionals (`if`)** — *(if still present post-redesign, otherwise: note removal and migration to `recover` + `match`)*
16. **Testing** — `test "…" { … }`, `mock prompt`, `mock workflow/rule/script`, `expect_contain`/`expect_not_contain`/`expect_equal`, `allow_failure`, `.test.jh` convention
17. **File structure** — shebang `#!`, comments `#`, blank lines, top-level statement order, `jaiph format` canonicalization
18. **Reserved words** — full keyword list, where they matter (param names, bare args)

**Context**

- Formal grammar (EBNF): `docs/grammar.md`
- AST types: `src/types.ts`
- Parser modules: `src/parse/*.ts`
- Existing topical docs: `docs/configuration.md`, `docs/testing.md`, `docs/inbox.md`
- Examples: `examples/*.jh`

**Acceptance criteria**

- `docs/language.md` exists and covers all 18 sections above.
- Every section has at least one runnable example.
- Edge cases and constraints are documented (not just the happy path).
- Cross-references to `grammar.md` for formal EBNF, `testing.md` for test harness details, `configuration.md` for full config key list.
- No redundant duplication of full EBNF — link to `grammar.md` instead.

---

## Runtime — harden Docker execution environment

**Goal**  
Docker mode is the isolation boundary for workflow runs. Harden it: least-privilege mounts, explicit and documented env forwarding (what crosses the container boundary), network defaults, image supply chain, and failure modes when Docker is misconfigured or unavailable — so "Docker on" is a deliberate security posture, not accidental leakage.

**Context**

- Docker runtime: `src/runtime/kernel/` — look for `docker.ts` or Docker-related logic in the run path.
- E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`.
- Config: `runtime.docker_enabled`, `runtime.docker_timeout`, `runtime.workspace` keys in `src/config.ts` and metadata parsing.

**Acceptance criteria**

- Threat-model notes (short section in `docs/sandboxing.md` or equivalent): what Docker is / isn't protecting against.
- Concrete hardening changes in `docker.ts` / run path (e.g. mount validation, env allowlist or documented denylist, safer defaults) with unit tests.
- No silent widen of host access without opt-in.

---

## Runtime — default Docker when not CI or unsafe <!-- dev-ready -->

**Goal**  
When the user has not opted into "unsafe" local execution, workflows should run in Docker by default. **Default `runtime.docker_enabled` to on** only when **neither** `CI=true` **nor** `JAIPH_UNSAFE=true` is set in the environment. If either is set, default Docker to **off** unless explicitly overridden via `runtime.docker_enabled` / `JAIPH_DOCKER_ENABLED`.

Introduce **`JAIPH_UNSAFE=true`** as the explicit "run on host / skip Docker default" escape hatch for local development when Docker is unwanted; document it next to `CI`.

**Context**

- Config resolution: `src/config.ts` — `resolveDockerConfig()` or equivalent; where `runtime.docker_enabled` default is determined.
- Env precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then CI / unsafe default rule.
- E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh` — may need env setup adjustments.

**Acceptance criteria**

- `resolveDockerConfig()` (and any CLI preflight messaging) implements the precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then apply CI / unsafe default rule.
- Unit tests for env combinations: plain local → Docker default on; `CI=true` → default off; `JAIPH_UNSAFE=true` → default off; both unset with explicit `JAIPH_DOCKER_ENABLED=false` → off.
- `CHANGELOG` + sandboxing / configuration docs updated.

---

## `jaiph serve` — expose workflows as an MCP server <!-- dev-ready -->

**Goal**  
Add a `jaiph serve <file.jh>` command that starts a stdio MCP server. Each top-level workflow in the file becomes a callable MCP tool. This lets any MCP client (Cursor, Claude Desktop, custom agents) invoke Jaiph workflows directly.

**Context**

- MCP (Model Context Protocol) uses JSON-RPC 2.0 over stdio. A server must handle `initialize`, `tools/list`, and `tools/call`.
- Jaiph already has a runtime (`src/runtime/kernel/node-workflow-runtime.ts`) that can execute workflows and capture output.
- The `@modelcontextprotocol/sdk` npm package provides a Node.js server implementation, but the protocol is simple enough to implement directly (~200 lines for stdio JSON-RPC + the three methods).

**Phase 1 — single text input (this task)**

Each workflow becomes a tool with a single `input` string parameter:

```json
{
  "name": "analyze_gaps",
  "description": "workflow analyze_gaps from qa.jh",
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "description": "Text input passed to the workflow" }
    }
  }
}
```

The `input` value is injected into the workflow environment as `JAIPH_MCP_INPUT` (accessible via `${input}` interpolation or `$JAIPH_MCP_INPUT` in scripts). The tool response is the workflow's captured output (log messages + prompt results).

**Phase 2 — typed parameters (future task)**

Extend the language with workflow parameters: `workflow analyze(file: string, depth: number) { ... }`. These map directly to the tool's `inputSchema`. Not in scope for this task.

**Scope**

1. **CLI command** (`src/cli/commands/serve.ts`): add `jaiph serve <file.jh>` that parses the file, starts a stdio JSON-RPC server, and handles `initialize`, `tools/list`, `tools/call`.
2. **Tool listing**: read the parsed module's `workflows` array. Each workflow becomes a tool entry with `name` = workflow name, `description` = `"workflow <name> from <filename>"`, `inputSchema` = single `input` string.
3. **Tool execution**: on `tools/call`, run the named workflow using the existing runtime. Capture all output (logs, prompt results). Return as `content: [{ type: "text", text: output }]`.
4. **Error handling**: if the workflow fails, return `isError: true` with the error message.
5. **Config inheritance**: the `.jh` file's `config { ... }` block applies normally (backend, model, etc.).
6. **E2E test**: a test that starts `jaiph serve` with a simple workflow, sends JSON-RPC messages via stdin, and verifies the tool list and a tool call response.
7. **Docs**: add a section to `docs/index.html` and `docs/jaiph-skill.md` about MCP server mode.

**Acceptance criteria**

- `jaiph serve examples/greeting.jh` starts a stdio MCP server.
- `tools/list` returns one tool per workflow.
- `tools/call` executes the workflow and returns its output.
- Errors produce `isError: true` responses (no server crash).
- E2E test passes.

---
