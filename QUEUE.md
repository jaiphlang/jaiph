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

## Fenced-block parser utility <!-- dev-ready -->

**Goal**  
Extract a reusable `parseFencedBlock()` function for parsing multiline fenced bodies (`` ``` ... ``` ``), shared by both prompt and script parsers.

**Fence rules**

- **Opening fence line**: only `` ``` `` or `` ```lang `` — no other characters after the backticks on that line.
- **Closing fence line**: only `` ``` `` (optional surrounding whitespace) — no other tokens on that line.
- `lang` is the optional token immediately after the opening backticks (e.g. `python3`, `node`, `bash`). Any single token is accepted — no hardcoded allowlist.
- Body is all lines between opening and closing fences, joined with `\n`.

**Error cases**

- Unterminated fence: no closing `` ``` `` before EOF.
- Text after the opening `` ``` `` that isn't a single lang token.
- Content on the same line as closing `` ``` ``.

**API**

```ts
parseFencedBlock(filePath: string, lines: string[], fenceLineIdx: number): {
  body: string;
  lang?: string;
  nextIdx: number;
}
```

`fenceLineIdx` points to the line containing the opening `` ``` ``. Returns `nextIdx` as the first line index after the closing fence.

**Scope**

1. **New file**: `src/parse/fence.ts` with `parseFencedBlock`.
2. **Unit tests**: `src/parse/parse-fence.test.ts` — basic body extraction, lang extraction, all error cases above.
3. **Compiler tests**: fence-specific error cases in `compiler-tests/parse-errors.txt`.

**Acceptance criteria**

- `npm test` passes with fence parser tests.
- No downstream consumers yet — prompt and script tasks wire it in.

---

## Prompt: single-line vs fenced multiline <!-- dev-ready -->

**Goal**  
Two ways to supply prompt text: compact single-line forms, and fenced bodies for multiline / markdown-style editing. Drop multiline double-quoted prompt strings (the current parser scans subsequent lines until a closing `"` — remove that path entirely).

**1. Single-line (string literal or identifier)**

```text
const text = "aaa"
prompt text

prompt "aaa"

prompt "aaa ${some_var}"
```

- **`prompt <identifier>`** — prompt text is the string value of the referenced binding (which may itself be a string or multiline template). The parser greedily takes the first token after `prompt` as the body — no keyword reservation needed. `returns` is only recognized as a keyword when it appears **after** a complete body form.
- **`prompt "..."`** — single-line only; `${...}` interpolation inside the quotes as today.
- **`returns "..."` / schema** — still allowed after either single-line form: `prompt "text" returns "schema"` or `prompt myVar returns "schema"`.

**2. Multiline template (fenced block)**

Uses `parseFencedBlock` from the fence parser task. Body supports `${...}` interpolation.

```text
prompt
```
You are a helpful assistant.
Analyze the following: ${input}
```
```

Or with `prompt` on the same line as the opening fence:

```text
prompt ```
You are a helpful assistant.
```
```

Formatter picks one canonical form. Parser accepts both.

**Const capture**

All three body forms must work in const-capture position: `const x = prompt "..."`, `const x = prompt myVar`, and `const x = prompt ``` ... ``` `. Update `ConstRhs` `kind: "prompt_capture"` accordingly.

**Context**

- Prompt parsing: `src/parse/prompt.ts` (`parsePromptStep`), call sites in `workflows.ts`, `workflow-brace.ts`, `const-rhs.ts`, `steps.ts`.
- Tests: `src/parse/parse-prompt.test.ts`, `compiler-tests/`, E2E under `e2e/`.

**Scope**

1. **Parser**: single-line identifier + single-line quoted string + fenced multiline (via `parseFencedBlock`). Remove the multiline `"..."` scan path (lines 96–110 of current `prompt.ts`). When a prompt starts with `"` and has no closing quote on the same line, emit an error like `"multiline prompt strings are no longer supported; use a fenced block instead"`.
2. **AST types**: update `WorkflowStepDef` for `type: "prompt"` to distinguish body source (string literal, identifier ref, fenced body). Update `ConstRhs` `kind: "prompt_capture"` to support all three body forms.
3. **Formatter**: keep single-line on one line; emit multiline as a fence block.
4. **Compiler tests + E2E**: migrate fixtures; cover identifier vs string vs fence; error cases (unterminated fence, unterminated single-line string, multiline `"..."` rejection).

**Acceptance criteria**

- `npm run test:compiler && npm test && npm run test:e2e` pass.
- Documented behavior matches the two cases above.

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
- Fenced (uses `parseFencedBlock` from the fence parser task):

```text
script demo =
```python3
import sys
print(sys.argv)
```
```

**After — `run` named script**

- `run name(args)` — unchanged.

**After — anonymous inline scripts** (no `=`; reads like a step, not a definition)

- `run script() "script code"` — single-line body, default runtime. Empty `()` required to make the no-args call explicit.
- Fenced with optional lang and args:

```text
run script(a, b)
```node
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
