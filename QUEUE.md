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

## Scripts and `run`: braces out; strings or fences in <!-- dev-ready -->

**Goal**  
Replace `{ ... }` script bodies with the **same split as prompts**: single-line double-quoted string or identifier binding, or multiline fenced block. Drop all `script:lang` prefix forms and the body-inside-parens inline syntax.

**Before (remove entirely)**  

- `script name { ... }`, `script:lang name { ... }` (and any `script:lang` form)
- `run script { ... }`, `run script(arg) { ... }`
- `run script("body", "arg1")` (body-inside-parens form)

**After — named scripts** (use **`=`** so the RHS reads like a binding: string, identifier, or fence)

- `script name = "..."` — single-line source, default runtime (shell).
- `script name = identifier` — RHS is a binding whose string value is the script body. E.g. `const body = "echo hi"; script foo = body`.
- Fenced — the opening `` ``` `` **must** be on the same line as `script name =` (uses `parseFencedBlock` from the fence parser task):

```text
script demo = ```python3
import sys
print(sys.argv)
```
```

**After — `run` named script**

- `run name(args)` — unchanged.

**After — anonymous inline scripts** (no `=`; reads like a step, not a definition)

- `run script() "script code"` — single-line body, default runtime. Empty `()` required to make the no-args call explicit.
- Fenced — the opening `` ``` `` **must** be on the same line as `run script(...)`:

```text
run script(a, b) ```node
console.log(process.argv)
```
```

**Language / shebang resolution**

The fence `lang` tag maps directly to a shebang: `` ```<tag> `` → `#!/usr/bin/env <tag>`. Any tag is valid — no hardcoded allowlist. This replaces the current `INTERPRETER_TAGS` map.

If the tag is empty (plain `` ``` ``), no automatic shebang is set. The user may provide a manual `#!` line as the first line of the body. If both a fence tag and a `#!` first line are present, that's an error.

Quoted-string and identifier RHS always use the default runtime (shell). For other languages, use a fenced block — even for a single line of Python, wrap it in a fenced block with `` ```python3 ``.

**Const capture**

`const x = run script() "..."` and `` const x = run script() ``` ... ``` `` must work. Update `ConstRhs` `kind: "run_inline_script_capture"` to accept the new body forms (body follows parens, not inside them).

**Context**

- Script parsing: `src/parse/scripts.ts` and `run` handling in `src/parse/steps.ts`, `const-rhs.ts`, `workflows.ts`, `workflow-brace.ts`.
- Formatter, compiler tests, E2E: full-repo search for `script` / `run script` / `script:`.

**Scope**

1. **Parser**: drop brace bodies, `script:lang`, and body-inside-parens inline scripts. Named scripts require `script name =` + RHS (string, identifier, or fence). Anonymous: `run script(...)` + body after parens (string or fence).
2. **Language**: fence `lang` → `#!/usr/bin/env <lang>`. Remove `INTERPRETER_TAGS` map. Error if both fence tag and manual `#!` present.
3. **AST types**: update `ScriptDef` — replace `commands: string[]` with single `body: string` + optional `lang?: string`. Update `ConstRhs` inline script capture variant for new body position.
4. **Formatter**: emit `script name =` for definitions; emit `run script(...) "..."` / fenced form for anonymous (no `=`).
5. **Tests**: migrate every fixture; parse errors for unterminated fences, text after opening `` ``` ``, remaining `script:lang`, body-inside-parens.

**Acceptance criteria**

- No script `{ ... }`, no `script:lang`, no `run script("body")` in grammar, formatter, docs, or tests.
- `npm run test:compiler && npm test && npm run test:e2e` pass.

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
