# Parser & Compiler Simplification — design doc

*Five refactors to compress `src/parse/` and `src/transpile/` by roughly a third, make the AST a clean sum type, and turn "add a new step or keyword" into a one-place change.*

**Status:** design — ready for implementation
**Date (UTC):** 2026-05-15

---

## Problem

The parser and compiler work, and the golden-test corpus (`src/transpile/compiler-golden.test.ts`, `src/transpile/compiler-edge.acceptance.test.ts`) pins their behavior tightly. But the code has accumulated:

- Parallel cascades of `startsWith` + regex dispatch (`src/parse/workflow-brace.ts`, 615 lines).
- Seven independent copies of the same quote-aware scanner (`splitCatchStatements`, `splitStatementsOnSemicolons`, `matchSendOperator`, `hasUnquotedSendArrow`, `indexOfClosingDoubleQuote`, `stripQuotedArgContent`, the scanner inside `parseSendRhs`).
- Three near-identical 100+ line catch/recover parsers (`parseEnsureStep`, `parseRunCatchStep`, `parseRunRecoverStep` in `src/parse/steps.ts`) plus a mini parser (`parseCatchStatement`) that re-implements `parseBlockStatement`.
- An AST in which "managed call that yields a value" has **three different encodings** (`run_capture` const RHS; statement form; `managed:` sidecar on `return`/`log`/`logerr` with a placeholder `value: "__match__"` string).
- A 1,441-line `validate.ts` with two near-identical step walkers (`validateRuleStep`, `validateStep`) that each manually repeat the 5-check sequence (`validateNoShellRedirection` → `validateNestedManagedCallArgs` → `validateRef` → `validateArity` → `validateBareIdentifierArgs`) at ~6 sites per side.
- Three different traversal strategies for "the set of modules in this build": the validator recursively re-reads + re-parses imports via `ValidateContext` callbacks; `emitScriptsForModule` wraps the same callbacks with a `prep` cache; `buildScripts` walks the file system directly.

None of this is broken. All of it makes the code expensive to change and easy to break in subtle ways (e.g. a fix to triple-quote-aware splitting has to be applied in 2–4 places, and divergence between them isn't always caught by the existing tests).

The five refactors below address the structural issues, in the order I recommend implementing them.

---

## Refactor 1 — Real tokenizer instead of line-walking + regex cascades

**Touches:** `src/parser.ts`, `src/parse/workflow-brace.ts` (615 lines), `src/parse/steps.ts` (757 lines), `src/parse/statement-split.ts` (304 lines), `src/parse/core.ts` (scanner helpers).

### Current shape

The parser walks `lines: string[]` and every routine returns `{ step, nextIdx }`. Statement dispatch is a long cascade of `startsWith` + regex in `parseBlockStatement` (`src/parse/workflow-brace.ts:102-615`). Order matters — `"run async "` must be tested before `"run "`, `"prompt "` before bare assignment, etc. Adding a new keyword means finding the right slot in the cascade.

Quote-aware string scanning is re-implemented from scratch in at least seven places (grep `inDoubleQuote`, `inTripleQuote`, `braceDepth` across `src/parse/`). Each copy has slightly different rules for escaping, triple-quotes, and brace nesting.

```ts
// Today (src/parse/workflow-brace.ts):
if (inner.startsWith("run async ")) { /* 40 lines */ }
if (inner.startsWith("run ")) {       /* 50 lines */ }
if (inner.startsWith("ensure ")) { ... }
if (inner.startsWith("log "))    { ... }
// ... 14 more branches
```

### Proposed shape

A tokenizer that owns string/triple-quote/backtick/fence/comment/brace state, plus a recursive-descent parser that consumes a token stream and dispatches via table lookup.

```ts
// Proposed:
const tokens = tokenize(source);        // single source of truth for scanning
const ast    = parseModule(tokens);     // recursive descent

const STATEMENT: Record<Keyword, StatementParser> = {
  run:    parseRunStatement,
  ensure: parseEnsureStatement,
  log:    parseLogStatement,
  // ...
};
```

### Net effect

- One canonical scanner instead of seven.
- A new statement form becomes a one-file change (add a row to `STATEMENT`).
- Expected reduction: **~1,500 lines** in `src/parse/`.

### Constraints

- Must pass the full existing golden test corpus byte-for-byte.
- Staged behind a flag (run both parsers, diff ASTs in CI) during transition is acceptable.

---

## Refactor 2 — Unify `catch` / `recover` / inline-block parsing

**Touches:** `src/parse/steps.ts` — `parseEnsureStep` (130 lines), `parseRunCatchStep` (110 lines), `parseRunRecoverStep` (110 lines), `parseCatchStatement` (280 lines).

### Current shape

Three near-identical 100+ line functions parse the same syntactic shape:

```
<host-step> <keyword> (binding) { body } | single-stmt
```

They differ in only two things: which host step they decorate (`ensure` vs `run`) and the literal keyword (`catch` vs `recover`).

The body parser inside them, `parseCatchStatement` (`src/parse/steps.ts:89-389`), is itself a stripped-down copy of `parseBlockStatement`. The two diverge in subtle ways — e.g. `parseCatchStatement` handles return/fail/run/ensure/prompt/log via slightly different regexes than the main path.

### Proposed shape

```ts
function parseAttachedBlock(
  keyword: "catch" | "recover",
  host: WorkflowStepDef,
): { bindings: { failure: string }; body: WorkflowStepDef[] };

// Body parsed by the SAME parseStatement used at the top level.
```

### Net effect

- One body parser instead of two.
- "Is this statement allowed inside a catch?" becomes a validator concern (Refactor 4), not something the parser enforces by what each mini-routine happens to recognize.
- Expected reduction: **~400 lines**.

---

## Refactor 3 — One `Call` / `Expr` shape, not three "managed" encodings

**Touches:** `src/types.ts` — `WorkflowStepDef` (14 variants), `ConstRhs` (6 kinds), `SendRhsDef` (5 kinds).

### Current shape

The same concept — "a managed call that yields a value" — is encoded three different ways depending on where it appears:

```ts
// As a statement:
{ type: "run", workflow, args, ... }

// As a const RHS:
{ kind: "run_capture", ref, args, ... }

// As a return / log / logerr value:
{
  type: "return",
  value: "__match__",          // placeholder string for the formatter
  managed: { kind: "match", match },
}
```

The `return + managed` form is the worst offender. It stores placeholder strings (`"__match__"`, `"run inline_script"`, `"run foo(...)"`) so the formatter has something to print, while the real semantic payload lives in `managed`. Validator and emitter both have to know about the dual representation. Inline scripts add a fourth variant — `run_inline_script_capture` — that is yet another form of the same idea.

### Proposed shape

```ts
type Expr =
  | { kind: "literal";       raw: string; tripleQuoted?: boolean }
  | { kind: "var";           name: string; field?: string }
  | { kind: "call";          callee: Ref;   args: Arg[];   bareIdentifierArgs?: string[] }
  | { kind: "ensure_call";   callee: Ref;   args: Arg[];   bareIdentifierArgs?: string[] }
  | { kind: "inline_script"; lang?: string; body: string;  args?: string }
  | { kind: "prompt";        body: Expr;    returns?: Schema }
  | { kind: "match";         subject: Expr; arms: MatchArm[] };

// Everywhere a value can appear, it is now an Expr:
type ConstRhs    = Expr;
type SendRhs     = Expr | ChannelArrow;
type ReturnStep  = { type: "return"; value: Expr; loc: SourceLoc };
type LogStep     = { type: "log";    message: Expr; loc: SourceLoc };
```

### Net effect

- `WorkflowStepDef` drops from ~14 → ~7 variants.
- Validator's per-step duplication of "is there a managed call here?" disappears — one `validateExpr` recursion handles it.
- The placeholder-string + sidecar pattern goes away entirely.

### Migration note

This is a breaking AST change, but the on-disk surface syntax does not move. The hard-rewrite policy (per `QUEUE.md`) allows this. Golden tests must pass byte-for-byte against the emitted bash output; the AST shape they pin (if any) is internal and is allowed to change.

---

## Refactor 4 — Validator as a visitor table, not a 1,441-line switch

**Touches:** `src/transpile/validate.ts` (1,441 lines, one function).

### Current shape

`validateReferences` contains two near-identical inner functions — `validateRuleStep` (~250 lines) and `validateStep` (~350 lines) — each a big switch over step types. They differ in three things:

1. Which step types are allowed (`prompt` / `send` are rejected in rules).
2. Which ref-expectation spec is used (`RULE_REF_EXPECT` vs `RUN_TARGET_REF_EXPECT`).
3. Whether the scope is workflow-wide or rule-wide.

Each step type's validation is written twice with subtle differences. The 5-check sequence (`validateNoShellRedirection` → `validateNestedManagedCallArgs` → `validateRef` → `validateArity` → `validateBareIdentifierArgs`) is repeated by hand at 6+ sites per side, which means at least 12 places to keep in sync.

### Proposed shape

```ts
const VALIDATORS: Record<StepType, Validator> = {
  ensure: validateCallStep("ensure"),
  run:    validateCallStep("run"),
  prompt: validatePrompt,
  log:    validateMessageStep("log"),
  send:   validateSend,
  // ...
};

const SCOPE = {
  workflow: { allow: ALL,                        refSpec: workflowRefs },
  rule:     { allow: ALL.minus(["prompt","send"]), refSpec: ruleRefs },
};

walk(ast, (step, ctx) => {
  if (!ctx.scope.allow.has(step.type)) reject(step);
  VALIDATORS[step.type](step, ctx);
});
```

### Net effect

- Each check (redirection, nested-managed, ref, arity, bare-args) is written once.
- "Is this step allowed here?" is a one-line set lookup, not three throw sites.
- Expected reduction: **~500–700 lines**.

---

## Refactor 5 — Promote `CompilePrep` to a first-class `ModuleGraph`

**Touches:** `src/transpile/compile-prep.ts`, `src/transpiler.ts`, `src/transpile/build.ts`, `src/transpile/validate.ts`.

### Current shape

The parser is intended to be pure (`source → AST`), but in practice the validator takes a `ValidateContext`:

```ts
interface ValidateContext {
  resolveImportPath: (fromFile, importPath, ws?) => string;
  existsSync:        (path) => boolean;
  readFile:          (path) => string;
  parse:             (content, filePath) => jaiphModule;
  workspaceRoot?:    string;
}
```

…so it can recursively read + re-parse imported modules. `emitScriptsForModule` then re-wraps those same callbacks with an optional `prep` cache. `buildScripts` walks the file system on its own. There are three different traversal strategies for "the set of modules in this build."

`compile-prep` already proved the right model — pre-parse all reachable modules once, hand them to validator and emitter. It just isn't the only path.

### Proposed shape

```ts
// Pipeline:
const graph = loadModuleGraph(entry, workspaceRoot);  // discover + parse-all
validate(graph);                                       // pure, in-memory
emit(graph, outDir);                                   // pure, in-memory

// parsejaiph(source, file): jaiphModule  — now I/O-pure.
// validate, emit never touch disk.
```

### Net effect

- Parser becomes I/O-pure (easier to fuzz, easier to test).
- Validator drops its `ValidateContext` shape.
- Build, validate, and emit all read from one place.
- Same path serves single-file LSP edits (graph rooted at one file) and full compile (graph rooted at workspace root).
- Expected reduction: **~300 lines**.

---

## Ordering rationale

1. **Refactor 5 (ModuleGraph) first.** Mechanical, low-risk, unblocks the rest by making the parser pure. Existing acceptance tests pin behavior.
2. **Refactor 3 (Expr collapse) next.** Doing this before tokenizing means the new parser only has to target one expression shape.
3. **Refactor 4 (visitor-table validator).** With a simpler AST, this is straight refactoring against the golden corpus.
4. **Refactor 2 (unify catch/recover).** Cheap win, drops ~400 lines.
5. **Refactor 1 (tokenizer + RD parser) last.** Biggest change. Should sit on top of a cleaned-up AST and a pure pipeline so it can be staged behind a flag and run side-by-side with the old parser against the golden corpus.

## Out of scope

- **Parser generator.** The grammar is small and the line-oriented sensibility of the language (triple-quoted blocks, fence blocks, comments-on-their-own-line) maps cleanly to a hand-written tokenizer.
- **Surface syntax changes.** None of these refactors are user-visible. The golden test corpus pins behavior.
- **Runtime.** The bash emitter and `runtime/` stay put.

---

## Appendix — Secondary improvements (A–E)

The five refactors above are the load-bearing changes. The five below are smaller in scope but each addresses a real structural issue that the top 5 do not fully solve on their own. Where a secondary item is coupled to a top-5 refactor, the ordering rationale below makes the dependency explicit.

### A — Split source-fidelity data from the semantic AST (CST / trivia layer)

**Touches:** `src/types.ts`, plus every parser/formatter/validator/emitter consumer.

`WorkflowStepDef` and `jaiphModule` today carry roughly ten fields that exist *only* so the formatter can round-trip: `leadingComments`, `configLeadingComments`, `trailingTopLevelComments`, `configBodySequence`, `topLevelOrder`, `bareSource`, the `tripleQuoted` flags on `literal`/`return`/`log`/`fail`/`send`/`const`, `bodyKind`, `bodyIdentifier`. Every consumer that does *not* care about formatting (validator, emitter) has to either ignore them or thread them through unchanged.

**Proposed:** introduce a parallel `Trivia` map (keyed by node id) or a separate CST layer that owns the source-fidelity data. The semantic AST stops carrying it; formatter reads from `Trivia` alongside the AST.

**Why it is appendix-only:** it changes most of the AST consumers, but the change is mechanical once the boundary is drawn. Biggest payoff if scheduled **before** Refactor 3, so the `Expr` shape is decided after the source-fidelity fields have been pulled out and the semantic core is visible.

### B — Diagnostics collector instead of fail-fast error reporting

**Touches:** `src/parse/core.ts` (`fail`), `src/errors.ts` (`jaiphError`), every call site in `src/parse/` and `src/transpile/`.

Today `fail()` and `jaiphError()` both throw on the first error. A user fixes one error, recompiles, fixes the next, recompiles, etc. This is also the reason for some defensive ordering inside the validator — it tries to surface the "most useful" error first because it knows it will only get to surface one.

**Proposed:** introduce a `Diagnostics` collector. Parser and validator append errors instead of throwing; the compile run reports the full set at the end (sorted by file/line). A "fatal" tier still exists for cases where continuing would produce garbage.

**Why it is appendix-only:** almost zero marginal cost if done as part of Refactor 4 (visitor-table validator), since the new visitor already needs a unified entry/exit per step. Doing it standalone is also fine but touches more files.

### C — Single-pass workflow walk

**Touches:** `src/transpile/validate.ts`.

The validator walks each workflow's step tree at least three times before its main check loop runs: `collectKnownVars`, `collectPromptSchemas`, `validateImmutableBindings`. Each walks the same nested step structure (if/for_lines/catch/recover) with subtly different recursion rules. Bug-fixes to "what counts as a binding here" land in 2–3 walkers.

**Proposed:** one visitor that accumulates `{knownVars, promptSchemas, bindings}` as it descends, and the main per-step validator runs after (or during) that single descent.

**Why it is appendix-only:** falls out naturally inside Refactor 4. Doing it separately is a fine ~50-line refactor.

### D — Collapse `bareIdentifierArgs` into a typed `Arg[]`

**Touches:** `src/types.ts`, `src/parse/core.ts` (`parseCallRef`), validator and emitter.

Today every call-bearing node carries both `args: string` (raw text) and `bareIdentifierArgs: string[]` (a re-parse of which arguments happened to be bare identifiers). The validator must remember to check `bareIdentifierArgs` exists at each call site. The emitter has to do its own re-parse of `args` because it doesn't trust either field alone.

**Proposed:**

```ts
type Arg =
  | { kind: "literal"; raw: string }
  | { kind: "var";     name: string };

// Calls carry args: Arg[]. No second field. No re-parsing downstream.
```

**Why it is appendix-only:** can be done inside Refactor 3 (it is part of the same "single AST shape per concept" story) or as a standalone task. Standalone is cleaner if Refactor 3 is otherwise too large.

### E — Decouple the validator from the runtime

**Touches:** `src/transpile/validate.ts` (the `import { tripleQuotedRawForRuntime } from "../runtime/orchestration-text"` at the top), `src/runtime/orchestration-text.ts`.

The validator imports a runtime helper (`tripleQuotedRawForRuntime`) so it can compute "what the runtime will see" when reporting errors. That is a one-way dependency from compile-time on runtime semantics. The right direction is the opposite: the parser/validator decides the canonical string, and the runtime consumes that decision.

**Proposed:** move the canonicalization into a parser-side helper (e.g. `src/parse/triple-quote.ts:canonicalizeTripleQuotedString`). The runtime imports *that* instead of the validator importing a runtime function.

**Why it is appendix-only:** small surface (one helper, ~30 lines), but it removes a layering inversion that will keep biting if the runtime grows more such helpers.

### Ordering with the top 5

```
1. Refactor 5  (ModuleGraph)
2. A           (CST/trivia split)            ← before Refactor 3 to settle AST shape
3. D           (typed Arg[])                 ← can fold into Refactor 3 if scoped slightly wider
4. Refactor 3  (Expr collapse)
5. C           (single-pass workflow walk)   ← prep for validator
6. B           (Diagnostics collector)       ← prep for validator
7. Refactor 4  (visitor-table validator)
8. E           (decouple validator/runtime)
9. Refactor 2  (unify catch/recover)
10. Refactor 1 (tokenizer + RD parser)
```
