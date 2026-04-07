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

## Language — redesign `ensure` / `recover` implicit parameter <!-- dev-ready -->

**Goal**  
In `ensure ... recover { ... }`, the failure payload is injected as `arg1` — the only implicit parameter in the language. Replace that with an **explicit binding** after `recover`, before `{`.

**Context**

- Parser: `src/parse/workflows.ts` — recover block parsing; currently expects `recover {` or `recover "arg" {`.
- Types: `src/types.ts` — `EnsureRecoverDef` or the recover step AST; needs new fields for bound identifiers.
- Validator: `src/transpile/validate.ts` and `src/transpile/validate-string.ts` — `recoverPayloadArg1` logic; references to magic `arg1` in recover scope.
- Runtime: `src/runtime/kernel/node-workflow-runtime.ts` — where `arg1` (merged stdout+stderr) and `_jaiph_retry` are injected into the recover scope.
- E2E: `e2e/tests/101_ensure_recover_output_contract.sh`, `e2e/tests/93_ensure_recover_payload.sh`, `e2e/tests/98_ensure_recover_value.sh`.
- Compiler tests: `compiler-tests/parse-errors.txt` — existing `ensure recover` error cases to update.

**Syntax (target)**

- Single binding (failure text = merged stdout + stderr, same value as today's `arg1`):

  ```text
  ensure ci_passes() recover (failure) {
    run save_string_to_file(failure, ".jaiph/tmp/ci_failure.log")
  }
  ```

- Optional second binding for the retry index (same semantics as today's `_jaiph_retry`); remove `_jaiph_retry` once this exists:

  ```text
  ensure ci_passes() recover (failure, attempt) {
    log "retry ${attempt}"
  }
  ```

- Bare `recover {` without parentheses is invalid; error should suggest `recover (<name>)` / `recover (<name>, <attempt>)`.

**Acceptance criteria**

- Parser and AST represent the bound identifier(s); runtime injects values under those names in the recover scope (no implicit `arg1` for the payload).
- Validator / bare-identifier rules use the explicit bindings instead of `recoverPayloadArg1` + magic `arg1`.
- Compiler golden + AST tests for the new forms; remove or update tests that assume implicit `arg1`.
- Examples (`examples/ensure_ci_passes.jh`, `examples/ensure_ci_passes.test.jh`), formatter round-trip, and docs updated (`docs/grammar.md`, `docs/jaiph-skill.md`, `docs/index.html` — has inline `ensure … recover` samples); `CHANGELOG` notes the breaking change.

---

## Language / tooling — rework `*.test.jh` syntax <!-- dev-ready -->

**Goal**  
The test file grammar (`test "…" { … }`, mocks, `expect*`, `# Given` / `# When` / `# Then` conventions) has grown ad hoc. Rework it so test modules read like the rest of Jaiph: consistent keywords, predictable block structure, and a clear contract for imports, mocks, and assertions — without special-case magic that diverges from workflow modules.

**Proposed changes**

| Current | Proposed | Rationale |
|---------|----------|-----------|
| `response = hello.default "arg"` | `const response = run hello.default("arg")` | Reuse `const`, `run`, and parenthesized args from workflow syntax |
| `hello.default "arg"` (no capture) | `run hello.default("arg")` | Explicit `run` prefix, same as workflows |
| `response = hello.default allow_failure` | `const response = run hello.default() allow_failure` | `allow_failure` modifier after the full call |
| `expectContain out "text"` | `expect_contain out "text"` | snake_case to match Jaiph keyword convention |
| `expectNotContain out "text"` | `expect_not_contain out "text"` | snake_case |
| `expectEqual out "text"` | `expect_equal out "text"` | snake_case |
| Unrecognized lines → silent `test_shell` pass-through | Unrecognized lines → `E_PARSE` | No hidden fallback; tests are Jaiph, not bash |
| `mock workflow app.build {` | `mock workflow app.build() {` | Parentheses on mocks mirror definitions |
| `mock rule app.check {` | `mock rule app.check() {` | Same parity for rules |
| `mock script app.helper {` | `mock script app.helper() {` | Same parity for scripts |
| Opaque shell body with `$1`/`$2` | Named params + Jaiph steps in body | No positional args; mock bodies are Jaiph, not shell |

Mock declarations gain full definition parity: named parameters in `()`, and bodies contain **Jaiph steps** (not opaque shell). Mock rule/workflow bodies use the same steps their real counterparts support (`return`, `fail`, `log`, `match`, `run` for scripts, etc.). Mock script bodies remain shell (scripts are shell by definition) but access args via named env vars, not positional `$1`/`$2`.

**Mock body examples (new)**

Simple mock — no args, fixed response:
```text
mock rule app.policy_check() {
  return "ok"
}
```

Named param with match dispatch:
```text
mock rule app.policy_check(env) {
  match env {
    "prod" => return "prod policy enforced"
    _ => fail "rejected"
  }
}
```

Mock workflow with named params:
```text
mock workflow app.deploy(target, version) {
  log "mock deploy ${target} v${version}"
  return "deployed"
}
```

Mock script — body stays shell, but named params are injected as env vars:
```text
mock script app.changed_files(dir) {
  echo "a.ts"
  echo "b.ts"
}
```

**Before → After: `say_hello.test.jh`**

Before:
```text
import "say_hello.jh" as hello

test "without name, workflow fails with validation message" {
  # When
  response = hello.default allow_failure

  # Then
  expectEqual response "You didn't provide your name"
}

test "with name, returns greeting and logs response" {
  # Given
  mock prompt "Hello Alice! Fun fact: ..."

  # When
  hello.default "Alice"
}
```

After:
```text
import "say_hello.jh" as hello

test "without name, workflow fails with validation message" {
  # When
  const response = run hello.default() allow_failure

  # Then
  expect_equal response "You didn't provide your name"
}

test "with name, returns greeting and logs response" {
  # Given
  mock prompt "Hello Alice! Fun fact: ..."

  # When
  run hello.default("Alice")
}
```

**Before → After: `ensure_ci_passes.test.jh`**

Before:
```text
import "ensure_ci_passes.jh" as ci

test "ci passes on first attempt skips recover" {
  mock script ci.npm_run_test_ci {
    echo "all tests passed"
  }
  ci.default
}
```

After:
```text
import "ensure_ci_passes.jh" as ci

test "ci passes on first attempt skips recover" {
  mock script ci.npm_run_test_ci() {
    echo "all tests passed"
  }
  run ci.default()
}
```

**Before → After: e2e fixture with assertions**

Before:
```text
test "full orchestration with all mock types" {
  mock prompt "deployment summary"
  mock rule lib.validate {
    echo "mock-valid"
    exit 0
  }
  mock workflow lib.deploy {
    echo "mock-deployed"
  }
  out = lib.default "prod"
  expectContain out "deployment summary"
  expectContain out "mock-deployed"
}
```

After:
```text
test "full orchestration with all mock types" {
  mock prompt "deployment summary"
  mock rule lib.validate(input) {
    return "mock-valid"
  }
  mock workflow lib.deploy() {
    log "mock-deployed"
    return "mock-deployed"
  }
  const out = run lib.default("prod")
  expect_contain out "deployment summary"
  expect_contain out "mock-deployed"
}
```

**Files to touch**

- Parser: `src/parse/tests.ts` — rewrite `parseTestBlock()` to require `run` prefix, `const` for captures, snake_case assertions, and reject unknown lines as `E_PARSE`.
- Types: `src/types.ts` — rename `test_expect_contain` → update step type strings if desired (internal detail).
- Formatter: `src/format/emit.ts` — emit new syntax forms.
- Test runner: `src/runtime/kernel/node-test-runner.ts` — adjust step handling if type names change.
- Compiler tests: `compiler-tests/parse-errors.txt` — add rejection cases for old syntax (`expectContain`, bare workflow call, `response =` without `const`).
- All `*.test.jh` files: migrate to new syntax (9 files across `e2e/`, `examples/`, `test/fixtures/`).
- Examples: `examples/say_hello.test.jh`, `examples/ensure_ci_passes.test.jh` — migrate to new syntax; these are user-facing samples.
- E2E tests: `e2e/tests/105_test_jh_verification.sh`, `e2e/tests/45_mock_workflow_rule_script.sh`, and any test that embeds `.test.jh` fixtures inline.
- Docs: `docs/testing.md`, `docs/grammar.md`, `docs/jaiph-skill.md`, `docs/index.html` — update all test syntax examples and feature descriptions.

**Acceptance criteria**

- Written proposal or inline rationale in PR: what changes, what breaks, migration for existing `*.test.jh`.
- Parser / AST / formatter / validator / test runner updated; docs (`docs/testing.md`, `docs/cli.md`, `docs/grammar.md` as needed) and examples/e2e fixtures migrated.
- Regression coverage for `jaiph test` behavior (discovery, mocks, assertions, failure reports).

---

## CLI — async thread numbers in progress tree <!-- dev-ready -->

**Goal**  
When a workflow uses `run async`, the progress tree should show a **circled number** prefix on every output line belonging to that async branch. This makes interleaved async output scannable at a glance — you can tell which branch produced which line without tracing indentation.

**Numbering**  
Circled numbers use Unicode starting at U+2460: ① ② ③ ④ ⑤ … Numbering is **global order of `run async` dispatch** within the parent workflow (first async call = ①, second = ②, etc.). The number appears at the **same indentation level as the async call site** — if a nested workflow fires its own `run async`, those get their own numbering at the nested indent level.

**Color**  
Circled numbers are rendered in **dim/grey** (ANSI `\u001b[2m`) — same style as the `·` continuation markers. When `NO_COLOR` is set or output is non-TTY, the circled number is emitted without ANSI codes.

**Before → After**

Before:
```text
workflow default
  ▸ workflow cursor_say_hello
  ▸ workflow claude_say_hello
  ·   ▸ prompt cursor "Say: Greetings! I am [mo..."
  ·   ▸ prompt claude "Say: Greetings! I am [mo..."
  ·   ✓ prompt cursor (3s)
  ·   ℹ Greetings! I am **Composer**, a language model trained by Cursor.
  ✓ workflow cursor_say_hello (3s)
  ·   ✓ prompt claude (4s)
  ·   ℹ Greetings! I am Claude Opus 4.6.
  ✓ workflow claude_say_hello (4s)

✓ PASS workflow default (4.6s)
```

After:
```text
workflow default
① ▸ workflow cursor_say_hello
② ▸ workflow claude_say_hello
① ·   ▸ prompt cursor "Say: Greetings! I am [mo..."
② ·   ▸ prompt claude "Say: Greetings! I am [mo..."
① ·   ✓ prompt cursor (3s)
① ·   ℹ Greetings! I am **Composer**, a language model trained by Cursor.
① ✓ workflow cursor_say_hello (3s)
② ·   ✓ prompt claude (4s)
② ·   ℹ Greetings! I am Claude Opus 4.6.
② ✓ workflow claude_say_hello (4s)

✓ PASS workflow default (4.6s)
```

Non-async steps (the root workflow line, `✓ PASS`) have **no** circled number — only lines within an async branch get one.

**Nested async example**

If a nested workflow also uses `run async`, those branches get their own numbering at the nested indentation:
```text
workflow default
① ▸ workflow parallel_suite
② ▸ workflow lint_check
① · ① ▸ workflow test_unit
① · ② ▸ workflow test_integration
① · ① ✓ workflow test_unit (2s)
① · ② ✓ workflow test_integration (5s)
① ✓ workflow parallel_suite (5s)
② ✓ workflow lint_check (1s)

✓ PASS workflow default (5s)
```

**Context**

- Progress tree builder: `src/cli/run/progress.ts` — `buildRunTreeRows()` / `collectWorkflowChildren()`. The `asyncPrefix` is already tracked (`step.async ? "async " : ""`); extend with a numeric index.
- Display renderer: `src/cli/run/display.ts` — `formatStartLine()`, `formatCompletedLine()`, `formatHeartbeatLine()`. These take `indent` and render `·` prefixes. The circled number needs to be prepended at the indent level of the async call site.
- Runtime event pipeline: `src/runtime/kernel/node-workflow-runtime.ts` — `executeSteps()` dispatches async branches via `asyncFrameStack.run()`. The async branch index needs to propagate through `STEP_START`/`STEP_END`/`LOG` events so the display layer can map lines to branches.
- Stderr handler: `src/cli/run/stderr-handler.ts` — parses `run_summary.jsonl` events and renders lines; needs to read the async branch index from events.
- E2E tests: `e2e/tests/104_run_async.sh` — existing async tests; add a case with nested workflows calling `run async` to verify nested circled numbers.
- Docs: `docs/index.html` — update the async workflow output sample to show circled numbers.

**Acceptance criteria**

- `run async` branches display circled numbers (①②③…) at the async call site's indentation level in both TTY and non-TTY output.
- Numbers are dim/grey in TTY mode; plain text in non-TTY / `NO_COLOR`.
- Nested `run async` inside a child workflow gets its own numbering scope at the child's indent level.
- Non-async lines have no circled number prefix.
- E2E test with nested async workflows verifies correct numbering and indentation.
- `docs/index.html` async sample updated.

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
