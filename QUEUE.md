# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Split compact match arms only on top-level commas #dev-ready

The one-line `match` form rejects a call arm whose arguments contain a comma.

### Current behavior

- Given `def f(a, b) { … }`, this line fails:

  `const r = match x { "a" => f(x, x), _ => "n" }`

  It reports `E_PARSE invalid match arm body: f(x; expected a string, """ block, identifier, ${…}, ref(...), or fail "..."`.
- Compact arms in `src/parse/match-arms.ts` split the `{ … }` body on every `,` outside strings and regexes, including commas inside a call's parentheses.
- The multiline and `;`-separated forms accept the same arm.
- `mock prompt { … }` in `*.test.jh` uses the same compact splitter.

### Required

- The compact form splits arms only on commas at parenthesis depth 0 that are outside strings, regexes, `"""` blocks, and inline scripts.
- An arm body `f(x, y)` or `'echo $1'(a, b)` becomes one arm whose body is the call with both arguments, the same AST the multiline form produces.
- Every compact match that parses today keeps its AST.
- An unbalanced `(` in a compact arm is an `E_PARSE` at the arm body's column, not a silent split.
- CHANGELOG `Unreleased` gets a Fix entry.

### Acceptance

- A unit test parses `match x { "a" => f(x, y), _ => "n" }` and compares its AST, `loc` excepted, with the same match written in multiline form.
- A unit test covers a nested call `f(g(a, b), c)` and an inline-script arm with two arguments.
- A unit test covers `mock prompt { "a" => "x, y", _ => "z" }`, keeping it at two arms.
- A unit test shows an unbalanced `(` fails with `E_PARSE` at the arm body's column.
- `docs/grammar.md` or `docs/language.md`, wherever the compact form is described, says that commas inside calls do not separate arms.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Reject trailing text after fail and return values #dev-ready

`fail "x" y` silently drops `y`, and `return "x" y` stores `"x" y` as the value. `log "x" y` is already rejected.

### Current behavior

- In a def body, `fail "x" y` parses to `{ type: "say", level: "fail", message: { raw: '"x"' } }`, and `y` disappears.
- `return "x" y` parses to `{ type: "return", value: { kind: "literal", raw: '"x" y' } }`. At runtime it does not return the string `x`.
- `log "x" y`, `logerr` and `logwarn` fail with `E_PARSE unexpected content after log string: 'y'` at the statement column. The code is in `src/parse/stmt-say.ts`.
- The return parsing is in `src/parse/stmt-return.ts`.

### Required

- After a `fail` or `return` value that is a `"…"` string, any token other than end of line or a trailing comment is `E_PARSE`. The messages mirror the log message: `unexpected content after fail string: '<text>'` and `unexpected content after return string: '<text>'`, at the same column rule `log` uses.
- `return` values that are not strings (`return name`, `return a.b`, `return f(x)`, `return match …`, `return prompt …`, `return """…"""`) keep their current behaviour and errors.
- Before changing anything, grep every repo source (tracked `.jh`, compiler-txtar inputs, e2e heredocs, docs blocks) for `fail "…" <text>` and `return "…" <text>`. Fix or delete any matches; record what was found in the task notes.
- CHANGELOG `Unreleased` gets a Breaking entry. Programs that relied on the dropped or stored text now fail to parse.

### Acceptance

- `test-fixtures/compiler-txtar/parse-errors.txt` gets fixtures for `fail "x" y` and `return "x" y` with exact message, line and column. The parse-errors snapshot is regenerated, and the diff contains only those additions.
- A unit test shows `fail "x"  # note` and `return "x"  # note` still parse.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Look up def-body keywords without Object.prototype #dev-ready

A def-body line that starts with `toString(`, `constructor(` or another `Object.prototype` method name fails with a misleading "unterminated block".

### Current behavior

- `STATEMENT` in `src/parse/workflow-brace.ts` is a plain object literal, and `dispatch` reads it as `STATEMENT[keyword]`.
- For `toString()` the lookup returns `Object.prototype.toString`, which runs as a handler. The body then fails at the def line with `E_PARSE unterminated block, expected "}"`.
- `constructor()`, `hasOwnProperty()`, `valueOf()` and the other `Object.prototype` names fail the same way.
- A comment in `src/parse/body-cursor.ts`, around line 131, mentions this lookup.
- Top-level dispatch in `src/parse/parse-module.ts` may have the same pattern; check it.

### Required

- Keyword tables used for dispatch (`STATEMENT`, and any top-level equivalent) cannot return inherited properties. Use a `Map`, a null-prototype object, or an own-property check.
- A def-body line `toString()` is handled like any other bare call to an unknown name. It either parses as a call step to `toString` (a later validation reports an unknown ref) or fails with the same error as `fooBar()`. Whichever it is, it must match an ordinary unknown name exactly.
- The comment in `body-cursor.ts` is updated or removed.
- CHANGELOG `Unreleased` gets a Fix entry.

### Acceptance

- A unit test shows `toString()`, `constructor()` and `hasOwnProperty()` in a def body get the same parse result or error as `fooBar()`.
- A unit test checks the same names as top-level lines, if top-level dispatch had the issue.
- Golden ASTs and the parse-errors snapshot pass unchanged.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Reject malformed config values, const assignments, empty import paths, and mock prompt trailing text #dev-ready

The parser accepts four malformed inputs and stores nonsense instead of reporting `E_PARSE`.

### Current behavior

- **Config:** `config { agent.model = "a" "b" }`, written on separate lines, parses to `agent.model` = `a" "b`. The value is taken from the first to the last quote. The code is in `src/parse/metadata.ts`.
- **Const:** `const x == y` in a def body parses to a const step whose value is the literal `= y`. The right-hand-side parsing is in `src/parse/stmt-decl.ts` and `src/parse/const-rhs.ts`.
- **Import:** `import "" as x` parses to an import with an empty path. The code is in `src/parse/imports.ts`. `import script "" as x` probably behaves the same; check it.
- **Mock prompt:** `mock prompt "a" x` in a `*.test.jh` test block is accepted, and the trailing `x` is ignored. The code is in `src/parse/test-steps.ts` / `src/parse/tests.ts`.

### Required

- **Config:** a config string value is exactly one `"…"` string token, optionally followed by a comment. Anything else after it is `E_PARSE unexpected content after config value: '<text>'` at the column of the extra text.
- **Const:** `const <name> = <rhs>` needs exactly one `=` token after the name. `==` (or any other operator token) there is `E_PARSE` with the existing `const` shape message, at the operator's column.
- **Import:** an empty path `""` in `import` or `import script` is `E_PARSE import path must not be empty`, at the path's column.
- **Mock prompt:** any text after `mock prompt "<response>"` or `mock prompt <const_name>` is `E_PARSE` with the existing `mock prompt must be: …` message, at the column of the extra text.
- Before changing anything, grep every repo source (tracked `.jh`, compiler-txtar inputs, e2e heredocs, docs blocks) for each form. Record what was found in the task notes.
- CHANGELOG `Unreleased` gets one Breaking entry that lists all four.

### Acceptance

- `test-fixtures/compiler-txtar/parse-errors.txt` gets one fixture per form, with exact message, line and column. The parse-errors snapshot diff contains only those additions.
- Unit tests show the valid neighbours still parse:
  - `agent.model = "a"  # c`
  - `const x = "y"`
  - `import "./a.jh" as a`
  - `mock prompt "a"`
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Report channel and mock prompt columns correctly #dev-ready

Two diagnostics point at the wrong column.

### Current behavior

- `src/parse/channels.ts` finds a channel name's column with `raw.indexOf(name)`, and does the same for the route target. When the name also occurs inside the word `channel`, the column is wrong.
  - `channel c`, `channel ch` and `channel an` get column 1, where `c` is found inside `channel`; the correct column is 9.
  - `channel abc` gets 9, which is correct.
  - The wrong `loc` reaches AST consumers and diagnostics such as `duplicate name "c"`.
- `mock prompt` errors in `*.test.jh` use 0-based columns. With two-space indentation, `mock prompt 5` reports `t.test.jh:2:2` where the statement starts at column 3. The code is in `src/parse/test-steps.ts` / `src/parse/tests.ts`.

### Required

- Channel `loc.col` and the target's column come from the token positions of the name and the target.
- `mock prompt` errors report the 1-based column of the `mock` token, the same rule every other test-block statement uses.
- Check the other test-block statements for the same off-by-one, and fix any that have it.
- Golden ASTs that encode the wrong channel columns, if any, are updated. Every changed column is listed in the task notes.
- CHANGELOG `Unreleased` gets a Fix entry.

### Acceptance

- A unit test shows `channel c`, `channel ch -> target` and `channel abc` report `loc.col` 9 for the name, and the target's column is correct.
- A `parse-errors.txt` fixture shows a duplicate `channel c` error at column 9.
- A `parse-errors.txt` fixture shows an indented `mock prompt 5` error at the `mock` token's 1-based column.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Use the single string escape rule in if operands #dev-ready

`if` operands still read a backslash as escaping any character. Everywhere else in Jaiph, `\"` is the only escape.

### Current behavior

- `readIfCondition` in `src/parse/stmt-control.ts` has a fallback, `BACKSLASH_OPERAND_RE`, for operands containing two backslashes in a row. Under that fallback `\\` escapes the next backslash, so `"a\\"` ends at the last quote.
- Under the lexer's rule, a backslash escapes only `"`. So the operand `"a\\"` reads as `"a\` + `\"`, an unterminated string.
- The fallback exists only to keep old parses unchanged.
- Regex operands (`/…/`) also go through the fallback; their escape rule is a separate concern.

### Required

- String operands follow the lexer rule: `\"` is the only escape, the same as all other Jaiph strings. `docs/grammar.md` states it for `if` operands.
- `BACKSLASH_OPERAND_RE` and its branch are deleted. `if x == "a\\" {` becomes the same unterminated-string `E_PARSE` any other string gives.
- Regex operands keep their current behaviour (`\/` does not end a regex) and are covered by a test.
- Before changing anything, grep every repo source for `if` operands containing `\\`, and record the matches in the task notes.
- CHANGELOG `Unreleased` gets an entry: Breaking if any accepted program changes meaning.

### Acceptance

- Unit tests pin the rule for `if x == "a\\" {`, `if x == "a\"b" {`, and `if x =~ /a\/b/ {`.
- `docs/grammar.md` states the rule for `if` operands.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.
