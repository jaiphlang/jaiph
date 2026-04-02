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

## E2E: exercise `examples/*.jh` (exclude `ensure_ci_passes.jh`) <!-- spec -->

**Goal**  
Add an end-to-end test (shell under `e2e/tests/`, following existing patterns) that runs every Jaiph file in `examples/` that is meant to be executed as a workflow, **except** `examples/ensure_ci_passes.jh` (CI-heavy / environment-specific). The run should succeed or be explicitly mocked/skipped per file where a real agent or external tools are required.

**Context**  
- Today `examples/` includes e.g. `say_hello.jh`, `async.jh`, `agent_inbox.jh`, plus `ensure_ci_passes.jh` and `*.test.jh` companions. Exclude **`ensure_ci_passes.jh`** from the matrix; decide whether `*.test.jh` files are covered via `jaiph test` instead of `jaiph run`.  
- Some examples need CLI arguments (e.g. a name) or mock prompts — mirror what `examples/say_hello.test.jh` or existing e2e fixtures already do.

**Done when**  
- One e2e script lists runnable example paths (or globs) and fails CI if a listed example breaks.  
- `ensure_ci_passes.jh` is not in that list; rationale is noted in a short comment in the script.  
- Document in the script (or `e2e/README` only if needed) how to add a new example to the matrix.

---

## Validation hints vs strict interpolation <!-- dev-ready -->

**Goal**  
(1) **Enforce strict checks everywhere they apply:** bare call arguments and `${…}` interpolation must only allow identifiers that are actually in scope (workflow/rule params, `const`, typed prompt captures, positional `argN` when declared, recover-payload `arg1` where applicable, etc.). Audit validation paths so there are no gaps or inconsistent rules between “bare” and “braced” forms.  
(2) **Align error copy with those rules:** bare-argument errors must not suggest “use `${name}` for explicit interpolation” when `name` is not already a known binding — that hint falsely implies a workaround that strict interpolation does not permit.

**Context**  
Example: `workflow default() { ensure name_was_provided(name) … }` with `name` undeclared surfaces a message that partially suggests `${name}`; both the hint and any missing strict checks should be fixed together.

**Done when**  
- Validation coverage is reviewed; bare args and `${ident}` reject unknown names consistently.  
- Error text and related docs/tests no longer imply that arbitrary `${ident}` works without being in scope.  
- Compiler tests cover at least one unknown-bare-arg case and one unknown-`${ident}` case with wording that matches strict semantics.

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
