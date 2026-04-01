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

## Language: require `()` on every `workflow` / `rule` definition (even when parameterless) <!-- dev-ready -->

**Goal**  
Definitions must look like `workflow default() { … }` and `rule check() { … }`, not `workflow default { … }`. Empty parentheses make zero-parameter definitions visually consistent with parameterized ones and simplify parsing/docs.

**Acceptance criteria**  
- Parser rejects definitions without `()` before `{` with a fix hint.  
- Repo `.jh` sources, fixtures, and tests migrated; formatter emits `()` for empty parameter lists.

---

## Testing: golden AST (or stable AST dump) for successful parses <!-- dev-ready -->

**Goal**  
Compiler txtar fixtures excel at expected errors and “this builds.” They do not lock in **what** the parser produced. Add a small, maintainable way to assert that successful samples map to the intended AST (or a stable serialization of it), so refactors cannot silently change tree shape.

**Approach (pick and document one)**  
- A test-only `serializeAstForTest(mod)` (or similar) that outputs deterministic JSON/text: stable key order, normalized arrays, and **locations stripped or optional** so line churn does not rewrite goldens on every edit.  
- One golden file per focused `.jh` fixture (small, one concern each: params, `run`/`ensure` args, `log`, brace-if, prompt capture, imports).  
- Optionally combine with a few **targeted** `assert.deepEqual` tests for hot paths if goldens feel heavy.

**Acceptance criteria**  
- At least a handful of fixtures with checked-in goldens; `npm test` fails when AST shape changes without updating goldens.  
- Short note in `docs/` or contributor-facing text: txtar = errors/behavior; golden AST = parse tree shape.

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
