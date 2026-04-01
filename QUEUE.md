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

## npm publish on tag via trusted publishing + post-publish global install smoke <!-- dev-ready -->

**Goal**  
Add a CI job that publishes the package to npm when a version tag is pushed, using **trusted publishers** (OIDC to npm — no long-lived `NPM_TOKEN` or other repo secrets for publish auth). Immediately after a successful publish, run a smoke step that installs the package globally and confirms the CLI matches the normal install path (same binary name and basic `jaiph --help` / `jaiph` entry behavior as documented for `npm install jaiph` / installer flows).

**Context**

- npm supports **Trusted Publishing** (OpenID Connect) so GitHub Actions can publish without storing npm credentials in GitHub secrets.
- The package already defines the `jaiph` CLI in `package.json` `bin`; global install must expose that same command name and behavior.
- Today, release may be manual; this task automates tag-driven release and catches broken publishes before users do.

**Scope**

1. **npm account / package setup** (manual, documented in task notes or `docs/contributing.md` briefly): enable Trusted Publishing for the `jaiph` package on npmjs.com, linked to this GitHub repo and the workflow file that will call `npm publish`.
2. **GitHub Actions workflow** (new job or extend `.github/workflows/ci.yml` / dedicated `release.yml`):
   - Trigger on `push` of tags matching `v*` (or the project’s tag convention — align with existing `package.json` version / git tag checks already in CI).
   - Permissions: `id-token: write` (required for OIDC).
   - Steps: checkout, `npm ci`, `npm run build` (if needed for a clean publish), then `npm publish --provenance` (or current best practice for trusted publishing).
   - Do **not** add `NODE_AUTH_TOKEN` from a classic npm token for publish; use the trusted-publisher flow npm documents for GitHub Actions.
3. **Post-publish verification step** (same workflow, must run only after publish succeeds):
   - Install globally, e.g. `npm install -g jaiph@<exact-published-version>` (use the version from the tag or from `package.json` after publish).
   - Assert the CLI on `PATH` is the published one: e.g. `jaiph --version` matches expected version, and `command -v jaiph` resolves.
   - Smoke: `jaiph --help` (or minimal subcommand) exits 0 and output matches expectations for **global** install — same UX as a local/project install (no duplicate or differently named binary).
   - Optionally compare `jaiph` shim behavior to `npx jaiph` in the same job for parity (lightweight check).
4. **Documentation**: one short paragraph in contributor or release docs: tags trigger CI publish; no npm token in repo secrets for this path.

**Acceptance criteria**

- Pushing a release tag runs publish via trusted publishing (no classic NPM publish secret committed or required for that job).
- The job fails if publish fails or if the post-step global install does not expose `jaiph` with the same CLI contract as documented for normal installs.
- `npm i -g` verification runs automatically in CI after publish, not only manually.

---

## Assert error locations in txtar compiler tests <!-- dev-ready -->

**Goal**  
Extend the txtar `# @expect error` directive and test runner to verify the line and column reported by compiler errors — not just the error code and message substring.

**Context**

- `jaiphError()` in `src/errors.ts` already formats errors as `filePath:line:col E_CODE message`. Line and column are present in every compiler error.
- The test runner (`src/compiler-test-runner.ts`) currently only checks `msg.includes(code)` and `msg.includes(substring)`. It ignores the `filePath:line:col` prefix entirely — a test passes even if the error points at the wrong line.
- Since virtual files are written to a tmpdir, the filePath portion varies per run and cannot be asserted directly. But the `line:col` portion is deterministic.

**Directive extension**

Add an optional `@line:col` suffix to the `# @expect error` directive:

```
# @expect error E_PARSE "unterminated workflow block"           ← existing (no location check)
# @expect error E_PARSE "unterminated workflow block" @2:1      ← new (asserts line 2, col 1)
# @expect error E_PARSE "unterminated workflow block" @2        ← new (asserts line 2, any col)
```

When `@line` or `@line:col` is present, the runner extracts `:<line>:<col>` from the error message and verifies it matches.

**Scope**

1. **Directive parser** (`parseExpectDirective` in `src/compiler-test-runner.ts`): extend the regex to capture an optional trailing `@<line>` or `@<line>:<col>`. Add `line?: number; col?: number` to the error expectation type.
2. **Assertion** (`runTestCase`): when `expect.line` is set, extract the `:line:col` from the error message (regex on the `filePath:L:C` prefix) and assert they match. If `expect.col` is also set, assert col too.
3. **README update** (`compiler-tests/README.md`): document the `@line` / `@line:col` suffix in the expect directives table.
4. **Backfill existing error tests**: update all existing `# @expect error` lines in `compiler-tests/parse-errors.txt` (and `validate-errors.txt` if it exists) to include `@line:col`. This verifies the compiler currently reports correct locations.
5. **Meta-test**: add a meta-test case in the runner that verifies a wrong `@line` is detected as a failure.

**Acceptance criteria**

- All existing error test cases include `@line:col` and pass — confirming current error locations are correct.
- A deliberately wrong `@line` causes the test to fail (meta-test).
- `npm run test:compiler` passes.
- README documents the new directive syntax.

---

## Custom agent command: display name + raw output support <!-- dev-ready -->

**Goal**  
When `agent.command` points to a custom script (not `cursor-agent` or `claude`), display the command name in the run tree output (e.g., `prompt my-agent.sh "You are ..."`). Support raw stdout capture (no JSON stream parsing) for custom commands, since they won't speak the `stream-json` protocol.

**Context**

- `agent.command` is already parsed and propagated via `JAIPH_AGENT_COMMAND` env var — see `src/parse/metadata.ts`, `src/cli/run/env.ts`, `src/runtime/kernel/node-workflow-runtime.ts`.
- `buildBackendArgs()` in `src/runtime/kernel/prompt.ts` (line ~102) currently appends `--print --output-format stream-json --stream-partial-output` to **all** non-claude, non-codex backends — including custom commands that don't understand those flags.
- `runBackend()` feeds stdout through `parseStream()` which expects JSON stream events. A custom script that just prints text will produce garbled output or silent failure.
- The display layer (`src/cli/run/display.ts`) already shows `prompt <name>` when the step `name` differs from `kind`. The runtime emits the backend name (`cursor`, `claude`, `codex`) as the step name — it should emit the custom command basename instead (e.g., `my-agent.sh`).

**Scope**

1. **`buildBackendArgs()`**: when `config.agentCommand` is NOT `cursor-agent`, don't append `--output-format stream-json` / `--stream-partial-output`. Just pass `[command, ...extraArgs, promptText]` or pipe prompt to stdin — choose whichever is simpler.
2. **`runBackend()`**: for custom commands, skip `parseStream()`. Collect raw stdout as the final response text. Stream lines to the writer as they arrive (writer.writeDelta for each chunk).
3. **Display**: emit the command basename (e.g., `wc.sh`) as the step name so the run tree shows `prompt wc.sh "..."`.
4. **E2E test**: write a custom agent script (e.g., `e2e/agents/echo-wc.sh`) that reads stdin, prints `<thinking>`, sleeps 1s, then outputs `wc -w` of the input. Wire it via `agent.command = "./agents/echo-wc.sh"` in a test workflow. Verify:
   - The run tree output shows `prompt echo-wc.sh "..."`.
   - The captured prompt response equals the expected word count.
   - No JSON parse errors in stderr.
5. **Landing page**: add a brief mention in `docs/index.html` features section that Jaiph supports custom agent backends via `agent.command`.

**Acceptance criteria**

- Custom commands receive prompt text and return raw output without JSON stream framing.
- Run tree shows the command name (not `cursor`).
- E2E test passes (`npm run test:e2e`).
- Landing page updated.

---

## Support `prompt { <multiline> }` brace syntax <!-- dev-ready -->

**Goal**  
Allow prompt text to be written in a brace block, similar to how `script` blocks work:

```
workflow default {
  result = prompt {
    You are a helpful assistant.
    Analyze the following code and provide feedback.
  }
}
```

This is equivalent to `result = prompt "You are a helpful assistant.\nAnalyze..."` but avoids quote escaping and makes long prompts more readable in source.

**Context**

- Script blocks already use brace syntax: `script name { body }` — parsed in `src/parse/scripts.ts`.
- Prompt parsing lives in `src/parse/prompt.ts` (`parsePromptStep`). Currently it requires a `"..."` string literal after the `prompt` keyword.
- The brace form should support:
  - `prompt { ... }` (uncaptured)
  - `name = prompt { ... }` (captured)
  - `prompt { ... } returns "{ schema }"` (with schema)
  - Leading/trailing blank lines inside braces are trimmed (like heredoc).
  - Interpolation `${var}` works inside the brace body (same as in quoted strings).
  - The closing `}` must be on its own line (indentation-independent), matching the pattern used by script blocks.

**Scope**

1. **Parser** (`src/parse/prompt.ts`): extend `parsePromptStep` — if the argument starts with `{` instead of `"`, switch to brace-body parsing. Collect lines until a matching `}` on its own line. Produce the same `WorkflowStepDef` with `type: "prompt"` and `raw` set to the brace body wrapped in quotes (so downstream emit/transpile doesn't change).
2. **Brace-style parser sites**: `src/parse/workflows.ts`, `src/parse/workflow-brace.ts`, `src/parse/const-rhs.ts`, `src/parse/steps.ts` — these all call `parsePromptStep`. No changes needed if `parsePromptStep` handles the `{` case internally.
3. **Formatter** (`src/format/emit.ts`): emit prompt steps with brace syntax when the raw text contains newlines (heuristic: if `raw` has `\n`, emit as `prompt { ... }` instead of `prompt "..."`).
4. **Txtar tests**: add valid cases (`prompt { ... }`, captured, with returns) and error cases (unterminated brace, empty brace body) to `compiler-tests/valid.txt` and `compiler-tests/parse-errors.txt`.
5. **E2E test**: add a workflow that uses `prompt { ... }` with a mock, verify the prompt text is passed correctly to the backend.

**Acceptance criteria**

- `prompt { ... }` parses and compiles identically to the equivalent quoted form.
- Formatter round-trips: `jaiph format` on a brace prompt preserves the brace syntax.
- Txtar compiler tests cover valid and error cases.
- E2E test verifies runtime behavior.
- `npm run test:compiler && npm test && npm run test:e2e` all pass.

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
