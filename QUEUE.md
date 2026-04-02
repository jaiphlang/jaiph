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

## Optional parentheses at call sites when no arguments <!-- dev-ready -->

**Goal**  
`run`, `ensure`, and `if` call sites allow omitting parentheses when passing zero arguments. `run setup` is equivalent to `run setup()`. Declarations still require `()` — this change is call-site only.

**Current state**

All call sites require parentheses, even with no args:
```jaiph
run setup()
ensure check_deps()
if not run file_exists() { ... }
const x = run helper()
return run helper()
return ensure check()
```

**After**

Parentheses are optional when no args are passed:
```jaiph
run setup
ensure check_deps
if not run file_exists { ... }
const x = run helper
return run helper
return ensure check
```

With args, parentheses remain required:
```jaiph
run deploy(env, version)
ensure gate(path)
```

Declarations always require `()`:
```jaiph
workflow setup() { ... }     # correct
rule check_deps() { ... }   # correct
# workflow setup { ... }     — E_PARSE: definitions require ()
```

**What needs fixing**

1. **Parser** (`src/parse/core.ts`): Update `parseCallRef` to accept a bare identifier without `(`. Currently the regex (`/^(REF)\(/`) requires `(`. Add a fallback: if no `(` follows the identifier, return `{ ref, rest }` with no args. Must not match when the identifier is followed by `{` (that's a definition, not a call).
2. **Parser** (`src/parse/steps.ts`): Ensure `run <ident>` (no parens) routes to the call path, not the shell fallback or some other handler. Same for `ensure <ident>`, `if run <ident> {`, `if ensure <ident> {`.
3. **Parser** (`src/parse/const-rhs.ts`): `const x = run helper` and `const x = ensure check` must parse correctly without parens.
4. **Parser**: `return run helper` and `return ensure check` must parse without parens.
5. **Parser**: `channel <- run helper` (send RHS) must parse without parens.
6. **Validator**: Arity checking still applies — if the callee declares params, calling without args is an arity mismatch error (existing behavior, just ensure it works with the no-parens form).
7. **Formatter** (`src/format/emit.ts`): Decide on canonical form. Recommendation: `jaiph format` emits `ref()` (with parens) for zero-arg calls to keep output unambiguous. If you disagree, emit bare form.
8. **Docs** (`docs/grammar.md`): Update EBNF `call_ref` to make parens optional. Update examples.
9. **Tests**: Add parser tests for bare-identifier call sites in all positions. Ensure no regressions with existing `ref()` form.

**Acceptance criteria**

- `run setup` parses identically to `run setup()`.
- `ensure check` parses identically to `ensure check()`.
- `if not run exists { ... }` parses correctly.
- `const x = run helper` works.
- `return run helper` and `return ensure check` work.
- `run deploy(env)` still works (parens required when args present).
- Definitions without `()` remain a parse error.
- Arity mismatch still caught when callee has required params.
- All existing tests pass.

---

## Remove `${argN}` positional parameter access <!-- dev-ready -->

**Goal**  
Named workflow/rule parameters are the only way to access argument values. `${arg1}`, `${arg2}`, etc. are removed. If a workflow declares named params, those names are the only bindings. Undeclared params cannot be accessed at all.

**Current state**

Both named params and positional `${argN}` are available:
```jaiph
workflow analyst(message, chan, sender) {
  log "From ${arg3} on ${arg2}: ${arg1}"   # works today
  log "From ${sender} on ${chan}: ${message}"  # also works
}
```

**After**

```jaiph
workflow analyst(message, chan, sender) {
  log "From ${sender} on ${chan}: ${message}"  # only way
  # log "From ${arg3}..."  — E_VALIDATE: unknown identifier "arg3"
}
```

**What needs fixing**

1. **Validator** (`src/transpile/validate-string.ts`): Remove the `${argN}` slot logic from `validateSimpleInterpolationIdentifiers`. The `/^arg([1-9])$/` check and `maxPositionalSlots` parameter should be removed. `${arg1}` becomes an unknown identifier error like any other undeclared name.
2. **Runtime** (`src/runtime/kernel/node-workflow-runtime.ts`): Remove `arg1`…`arg9` injection into the orchestration variable scope. Only inject named parameter names.
3. **Runtime** (`src/runtime/kernel/workflow-launch.ts`): Update CLI arg injection — args from command line must map to declared parameter names, not `arg1`/`arg2`.
4. **Inbox dispatch**: Currently dispatches with `arg1=message`, `arg2=channel`, `arg3=sender`. Switch to positional binding against the target workflow's declared parameter names. If the target declares `(m, ch, s)`, bind `m=message`, `ch=channel`, `s=sender` (positional, names are free). The target **must** declare exactly 3 parameters — this is a hard compile-time check on channel route targets. Fewer or more is `E_VALIDATE`.
5. **Docs** (`docs/grammar.md`): Remove all `${argN}` references. Update string interpolation table. Update inbox dispatch docs.
6. **Tests**: Update all tests that use `${argN}`. Update e2e inbox tests.
7. **First-party `.jh` files**: Audit and update any remaining `${argN}` usage.

**Acceptance criteria**

- `${arg1}` in a workflow/rule body is `E_VALIDATE: unknown identifier`.
- Named params (`${paramName}`) work as before.
- CLI positional args map to declared param names by position.
- Inbox route targets must declare exactly 3 params — fewer or more is `E_VALIDATE`.
- Inbox dispatch binds message/channel/sender positionally to whatever names the target declares.
- All tests pass with updated fixtures.

---

## Channel declarations with inline routing <!-- dev-ready -->

**Goal**  
Route declarations (`->`) belong at the top level alongside channel declarations, not inside workflow bodies. A channel declaration and its routing target are the same concern.

**Current state**

Channels are declared at top level, routes are inside workflow bodies:
```jaiph
channel findings
channel report

workflow default() {
  findings -> analyst
  report -> reviewer
  run scanner()
}
```

**After**

```jaiph
channel findings -> analyst
channel report -> reviewer

workflow default() {
  run scanner()
}
```

**What needs fixing**

1. **AST** (`src/types.ts`): Extend `ChannelDef` with optional `routes?: WorkflowRefDef[]` to hold `-> target` declarations.
2. **Parser** (`src/parse/channels.ts`): Extend `parseChannelLine` to accept optional `-> workflow` (or `-> w1, w2`) after the channel name.
3. **Parser** (`src/parse/workflows.ts`): Remove `->` as a valid statement inside workflow bodies. Reject with error: `route declarations belong at the top level: channel name -> workflow`.
4. **Runtime** (`src/runtime/kernel/node-workflow-runtime.ts`): Read routes from `ChannelDef.routes` instead of (or in addition to) `WorkflowDef.routes`. Build the route map from channel-level declarations.
5. **Validator** (`src/transpile/validate.ts`): Validate that every channel route target points to an existing workflow. Validate that route targets are not rules or scripts.
6. **Formatter** (`src/format/emit.ts`): Emit `channel name -> target` in formatted output.
7. **Docs** (`docs/grammar.md`, `docs/inbox.md`): Update channel and routing syntax.
8. **Tests**: Update golden AST fixtures, compiler tests, e2e inbox tests.

**Acceptance criteria**

- `channel findings -> analyst` parses with route stored in `ChannelDef`.
- `channel findings -> analyst, auditor` parses with multiple route targets.
- `findings -> analyst` inside a workflow body is a hard parse error with guidance.
- Routes from channel declarations dispatch correctly at runtime.
- All inbox e2e tests pass with updated fixtures.

---

## Match — keyword always first, no dollar prefix <!-- dev-ready -->

**Goal**  
`match` always precedes the variable in both statement and expression positions. No `$` prefix on the matched variable — consistent with how params and `const` names are referenced without `$`.

**Current state**

Statement form: `match $var { ... }` or `match ${var} { ... }`.  
Expression form: `$var match { ... }` or `${var} match { ... }` (postfix).

**After**

```jaiph
# statement
match var { "lit" => ..., /re/ => ..., _ => ... }

# expression
const x = match var { "lit" => ..., _ => ... }
```

**What needs fixing**

1. **Parser** (`src/parse/match.ts`): Update `parseMatchExpr` to accept bare identifier as subject (no `$` or `${}`). The subject is just an `IDENT`.
2. **Parser** (`src/parse/match.ts`): Remove `extractPostfixMatchSubject` — delete the `<subject> match { }` postfix form entirely.
3. **Parser** (`src/parse/const-rhs.ts`, `src/parse/steps.ts`): Update expression-position match parsing to use prefix `match var { }` instead of postfix `$var match { }`. `const x = match var { ... }` and `return match var { ... }`.
4. **Parser**: Reject `$var` and `${var}` as match subjects with error: `match subject should be a bare identifier: match varName { ... }`.
5. **AST** (`src/types.ts`): `MatchExprDef.subject` changes from a bash-style string (`$var`, `${var}`) to a plain identifier string.
6. **Runtime**: Update match evaluation to resolve bare identifier subjects against the variable scope.
7. **Docs** (`docs/grammar.md`): Update match syntax, EBNF, and examples.
8. **Tests**: Update golden AST fixtures (`golden-ast/fixtures/match.jh`), compiler tests, e2e tests.

**Acceptance criteria**

- `match status { "ok" => ... _ => ... }` parses with `subject: "status"`.
- `const x = match status { ... }` parses as expression form.
- `$status match { ... }` is a hard parse error.
- `match $status { ... }` is a hard parse error with guidance.
- `return match var { ... }` works.
- All tests pass with updated fixtures.

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
