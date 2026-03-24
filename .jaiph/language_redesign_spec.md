# Execution-Boundary Rework Specification

## Core Problem

Jaiph blends declarative orchestration with raw shell in workflows and rules. That blurs side-effect boundaries, blocks runtime portability (Go/Rust), and weakens sandbox control.

Target: one strict boundary. Orchestration constructs orchestrate. A dedicated bash construct executes. No exceptions.

## Design Decisions (Locked)

These are not options. Implementation starts from this table.

| # | Decision |
|---|----------|
| 1 | Orchestration constructs (`workflow`, `rule`) contain **zero raw shell**. |
| 2 | Execution construct (`function`) is **pure bash**. |
| 3 | Construct name stays **`function`** (not `bash`). |
| 4 | Variable declarations use **`const`** in orchestration, **`local`** in functions. |
| 5 | Rules get **structured keyword parsing** (same model as workflows, restricted subset). |
| 6 | Every shell operation requires a **named `function`**. No anonymous bash blocks. |
| 7 | Functions: **bash return semantics** (exit code via `return N`, values via stdout). |
| 8 | Workflows/rules: **`return "value"`** for values, **`fail "reason"`** for explicit failures. |
| 9 | **One-shot cutover.** No compatibility mode, no deprecation warnings. |
| 10 | Functions run in **full isolation** — only positional args, no inherited variables. |
| 11 | **No function-to-function calls.** Functions are atomic. Composition happens in orchestration. |
| 12 | Shared utility code lives in **shared bash libraries** (sourced explicitly), not in Jaiph function cross-calls. |
| 13 | `if` uses **brace syntax** (`if ... { } else { }`), **`not`** for negation, **`else if`** for chaining. No `then`/`fi`/`elif`. |

## Legality Matrix

### `workflow`

| Construct | Allowed | Syntax |
|-----------|---------|--------|
| config | Yes | `config { key = "value" }` |
| const | Yes | `const name = "value"` / `const name = run ref` / `const name = ensure ref` / `const name = prompt "text"` |
| run | Yes | `run ref [args]` / `run ref [args] &` (async) |
| ensure | Yes | `ensure ref [args]` / `ensure ref [args] recover { ... }` |
| prompt | Yes | `prompt "text"` / `const name = prompt "text"` / `const name = prompt "text" returns '{ ... }'` |
| log | Yes | `log "message"` |
| logerr | Yes | `logerr "message"` |
| return | Yes | `return "value"` / `return $var` |
| fail | Yes | `fail "reason"` |
| if | Yes | `if [not] ensure ref { ... } [else if ...] [else { ... }]` / `if [not] run ref { ... }` |
| route | Yes | `channel -> ref1, ref2` |
| send | Yes | `channel <- "value"` / `channel <- $var` / `channel <- run ref` |
| wait | Yes | `wait` (waits for async `run` steps) |
| Raw shell | **No** | Hard parser error with rewrite guidance |

### `rule`

| Construct | Allowed | Syntax |
|-----------|---------|--------|
| const | Yes | `const name = "value"` / `const name = run ref` / `const name = ensure ref` (no `prompt` capture) |
| ensure | Yes | `ensure ref [args]` — other rules only, **no `recover`** |
| run | Yes | `run ref [args]` — **functions only**, not workflows |
| log | Yes | `log "message"` |
| logerr | Yes | `logerr "message"` |
| return | Yes | `return "value"` / `return $var` |
| fail | Yes | `fail "reason"` |
| if | Yes | `if [not] ensure ref { ... }` / `if [not] run ref { ... }` (run targets functions only) |
| prompt | **No** | Rules don't interact with AI |
| route / send | **No** | Rules don't use channels |
| async (`&`, `wait`) | **No** | |
| recover (in `ensure`) | **No** | Not in rule-to-rule calls |
| Raw shell | **No** | Hard parser error |

### `function`

| Construct | Allowed | Syntax |
|-----------|---------|--------|
| All bash syntax | Yes | Full bash including control flow, pipes, subshells |
| Nested bash functions | Yes | `helper() { ... }` (internal to the function body) |
| `source` shared lib | Yes | `source "$JAIPH_LIB/utils.sh"` |
| `return N` | Yes | Bash exit code (integer only) |
| stdout (`echo`, `printf`) | Yes | Value output mechanism |
| `local` | Yes | Bash variable declarations |
| Other Jaiph function calls | **No** | Functions are atomic; compose in orchestration |
| `run`, `ensure`, `prompt` | **No** | Hard parser error |
| `return "value"` | **No** | Use `echo` for values, `return 0` for success |
| `fail`, `const`, `log`, `logerr` | **No** | Jaiph keywords, not available in bash |
| Parent scope variables | **No** | Full isolation — only `$1`, `$2`, etc. |

## Function Isolation Model

Functions execute in **full isolation**. They receive only their positional arguments. No inherited variables from the orchestration scope, module-level constants, or other functions' state.

**Transpilation**: function bodies run in a clean environment. Only positional args and explicitly passed env vars are available. Implementation: `env -i` wrapper or equivalent restricted execution context.

**Data flow is always explicit**:
- **Input**: positional arguments only (`$1`, `$2`, ...)
- **Output**: stdout (value), stderr (diagnostics), exit code (success/failure)
- **No side channel**: functions cannot read `const` variables from workflows/rules

**Shared utility code**: functions that need common logic `source` a shared bash library rather than calling other Jaiph functions. Libraries live in a conventional location (e.g. `.jaiph/lib/`) and are plain bash files.

```
function check_is_number() {
  source "$JAIPH_LIB/validators.sh"
  is_integer "$1"
}
```

The runtime sets `$JAIPH_LIB` to the project's shared library path. Libraries are not Jaiph constructs — they are plain bash, managed outside the Jaiph compiler.

## Semantics: Values, Returns, Failures

### Functions (pure bash, isolated)

Values are passed via **stdout**. Caller captures with `const result = run fn_name`.

Exit code determines success/failure: `return 0` = success, `return 1` = failure.

The existing `jaiph::set_return_value` mechanism is **removed** from function transpilation. `return "$string"` in a function body is a **parser error** (bash `return` only accepts integers).

### Workflows

`return "value"` passes a value to the caller via the Jaiph runtime (not stdout).

`fail "reason"` terminates the workflow with a non-zero exit and logs the reason to stderr. An unrecovered `ensure` failure also terminates the workflow.

Exit code: 0 on natural completion or `return`. Non-zero on `fail` or unrecovered failure.

### Rules

`return "value"` passes a value to the caller. Captured by `const result = ensure rule_name`.

`fail "reason"` causes the rule to fail. In the caller, this triggers a `recover` block (if present) or aborts.

A rule that completes without hitting `fail` passes.

### `fail` vs bash failure

| Context | How to fail | How to return a value |
|---------|-------------|----------------------|
| `function` | `return 1` / `exit 1` | `echo "value"` (stdout) |
| `workflow` | `fail "reason"` | `return "value"` |
| `rule` | `fail "reason"` | `return "value"` |

## Migration Examples

### Rule: raw shell → structured

Before:

```
rule ensure_is_number {
  if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Expected a non-negative integer, got: $1" >&2
    exit 1
  fi
}
```

After:

```
function check_is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

rule ensure_is_number {
  if not run check_is_number "$1" {
    fail "Expected a non-negative integer, got: $1"
  }
}
```

### Workflow: inline shell → named function

Before:

```
workflow default {
  n="${1:-10}"
  ensure ensure_is_number "$n"
  result = run fib "$n"
  log "$result"
}
```

After:

```
workflow default {
  const n = "${1:-10}"
  ensure ensure_is_number "$n"
  const result = run fib "$n"
  log "$result"
}
```

### Function: return value via stdout (not `jaiph::set_return_value`)

Before:

```
function fib() {
  local result
  result="$(fib_impl "$n")"
  return "$result"
}
```

After:

```
function fib() {
  fib_impl() {
    local x="$1"
    if [ "$x" -le 1 ]; then
      echo "$x"
      return 0
    fi
    local a b
    a="$(fib_impl "$((x - 1))")"
    b="$(fib_impl "$((x - 2))")"
    echo "$((a + b))"
  }
  fib_impl "$1"
}
```

All data is internal. Caller captures via `const result = run fib "$n"`.

### Prompt with `returns` + value dispatch (engineer.jh pattern)

Before:

```
local role_surgical = "<role>...</role>"
local role_reductionist = "<role>...</role>"

workflow implement {
  local role_name="$2"
  local role
  if [ "$role_name" = "surgical" ]; then
    role="$role_surgical"
  elif [ "$role_name" = "reductionist" ]; then
    role="$role_reductionist"
  fi
  prompt "$role ..."
}
```

After:

```
function select_role() {
  local role_surgical='<role>
    You are a surgical engineer. ...
  </role>'
  local role_reductionist='<role>
    You are a reductionist engineer. ...
  </role>'

  case "$1" in
    surgical) echo "$role_surgical" ;;
    reductionist) echo "$role_reductionist" ;;
    *) echo "Unknown role: $1" >&2; return 1 ;;
  esac
}

workflow implement {
  const task = "$1"
  const role_name = "$2"
  const role = run select_role "$role_name"

  prompt "
    $role
    ...
    $task
  "
}
```

Role data is internal to the function. Orchestration only passes the role name and receives the resolved text. Full isolation — function has zero knowledge of caller scope.

### Send operator

Before:

```
workflow scanner {
  findings <- echo "Found 3 issues in auth module"
}
```

After:

```
workflow scanner {
  findings <- "Found 3 issues in auth module"
}
```

### Rule with value return

Before:

```
rule echo_line {
  echo "this goes to logs only"
  return "captured-value"
}
```

After:

```
function echo_impl() {
  echo "this goes to logs only" >&2
}

rule echo_line {
  run echo_impl
  return "captured-value"
}
```

## Pattern Catalog: .jaiph/ and e2e/ audit

Every `.jh` file was scanned. Below are all patterns found that require migration, grouped by category.

### P1: Raw shell in workflows (every .jaiph/ file)

**Files**: queue.jh, docs_parity.jh, simplifier.jh, architect_review.jh, ensure_ci_passes.jh, qa.jh, git.jh, log_keyword.jh, nested_run.jh, workflow_greeting.jh, prompt_unmatched.jh, rule_pass.jh, assign_capture.jh

**Examples**: `echo "..."`, `printf`, `mkdir -p`, `rm -f`, `exit 0`, `exit 1`, `test -n`, bare assignment (`dataset="testdata"`)

**Migration**: each becomes a named `function` or a `const` declaration. `exit 0` → `return` (early success). `exit 1` → `fail "reason"`.

### P2: Raw shell in rules (every rule)

**Files**: git.jh (`git rev-parse`, `test -z "$(git status)"`), queue.jh (`echo | grep -q`), ensure_ci_passes.jh (`npm run test:ci`), docs_parity.jh (`test -f`, `while IFS= read`), simplifier.jh, say_hello.jh, say_hello_json.jh, current_branch.jh

**Migration**: shell logic moves to functions. Rules become structured: `run` the function, `if`/`fail` on the result.

### P3: Iteration in workflows

**Files**: architect_review.jh (`while IFS= read -r header; do ... done <<< "$headers"`), docs_parity.jh (`for f in docs/*.md`, `for f in "${docs_md_files[@]}"`).

**Problem**: the loop body contains orchestration keywords (`run`, `ensure`, `prompt`, `log`). Cannot be pushed to a function.

**Resolution**: use **workflow recursion**. Extract per-item logic into a workflow, then recurse over the list. Shared utility functions `first_line` and `rest_lines` (in `$JAIPH_LIB`) split newline-delimited lists.

```
function list_docs_files() {
  for f in docs/*.md; do
    echo "$f"
  done
}

workflow process_docs_recursive {
  const file = "$1"
  const remaining = "$2"

  run docs_page "$file"

  if run has_value "$remaining" {
    const next = run first_line "$remaining"
    const rest = run rest_lines "$remaining"
    run process_docs_recursive "$next" "$rest"
  }
}

workflow default {
  const docs_files = run list_docs_files
  const first = run first_line "$docs_files"
  const rest = run rest_lines "$docs_files"
  run process_docs_recursive "$first" "$rest"
}
```

**Future feature: `each` modifier.** Planned syntax sugar that replaces the recursion boilerplate:

```
run docs_page each $docs_files
```

`each` is a modifier on `run`/`ensure` that calls the target once per newline-delimited item. No loop body, no mutable state, no break/continue. Backward-compatible addition — does not block v1.

### P4: Bash arrays in workflows

**File**: docs_parity.jh — builds arrays dynamically (`local files=()`, `files+=("$f")`), passes them as args (`"${files[@]}"`).

**Resolution**: avoid arrays in orchestration. Represent lists as newline-delimited strings. Functions that need to process multiple items receive them as a single string argument. Glob expansion (`docs/*.md`) stays in functions.

### P5: Mutable variables in workflows

**File**: architect_review.jh — `local failed=0` then `failed=1` inside a loop to track whether any task failed.

**Resolution**: restructure to avoid mutable state. The per-item workflow performs side effects (marking tasks). After recursion completes, re-check the final state:

```
workflow review_single_task {
  const header = "$1"
  const task = run queue.get_task_by_header "$header"

  if run is_dev_ready "$task" {
    log "Already dev-ready: $header"
    return
  }

  const verdict = run review_task "$task"
  if run matches "$verdict" "dev-ready" {
    run queue.mark_task_dev_ready "$header"
    log "Marked dev-ready: $header"
  } else {
    log "Needs work: $header"
  }
}

workflow default {
  const headers = run queue.get_all_task_headers
  # recurse over headers (or use `each` when available)
  ...

  const remaining = run queue.count_not_ready
  if not run is_zero "$remaining" {
    fail "One or more tasks need work"
  }
}
```

No mutable counter. The source of truth is the queue state, not a variable.

### P6: String comparison in workflows (SPEC GAP)

**Files**: architect_review.jh (`[[ "$verdict" == "dev-ready" ]]`), engineer.jh (role name dispatch), git.jh (`[ -z "$role_name" ]`).

**Resolution**: push to functions under Path 1.

```
function matches() {
  [ "$1" = "$2" ]
}

function has_value() {
  [ -n "$1" ]
}

if run matches "$verdict" "dev-ready" {
  ...
}
```

These are small, reusable utility functions. Candidates for a shared library (`$JAIPH_LIB/checks.sh`).

### P7: `return "$(command)"` in functions (Jaiph value return)

**Files**: queue.jh (`return "$(awk ...)"`), docs_parity.jh (`return "$(git diff ...)"`), simplifier.jh (same pattern).

**Migration**: replace `return "$(command)"` with direct stdout passthrough:

Before: `return "$(awk '/^## /{print}' "$queue_file")"`

After: `awk '/^## /{print}' "$queue_file"` (just let stdout flow)

### P8: `logerr` in rules

**Files**: say_hello.jh, say_hello_json.jh — `logerr "message"` inside raw shell rule body.

**Migration**: under structured rules, `logerr` becomes a Jaiph keyword (already in legality matrix):

```
rule name_was_provided {
  if not run has_value "$1" {
    logerr "You didn't provide your name :("
    fail "name argument required"
  }
}
```

### P9: `ensure` with `recover` containing shell

**File**: ensure_ci_passes.jh — `recover` block contains `echo "$1" > "$ci_log_file"`, shell conditionals, and a `prompt`.

**Migration**: shell in recover body moves to functions. `prompt` stays (recover body follows workflow rules):

```
function save_ci_log() {
  echo "$1" > "$2"
}

function ci_log_exists() {
  [ -s "$1" ]
}

workflow ensure_ci_passes {
  const ci_log_file = ".jaiph/tmp/ensure_ci_passes.last.log"
  run mkdir_p ".jaiph/tmp"

  ensure ci_passes recover {
    run save_ci_log "$1" "$ci_log_file"
    if not run ci_log_exists "$ci_log_file" {
      fail "ci failure log is empty at $ci_log_file"
    }
    prompt "Fix failing CI... log at: $ci_log_file"
  }

  run rm_file "$ci_log_file"
}
```

### P10: Shell variable expansion in `const` RHS

**Files**: multiple — `"${1:-10}"`, `"${1:-}"`, `"${task%%$'\n'*}"`.

**Ruling**: simple interpolation (`$var`, `"${var:-default}"`) is allowed in `const` RHS — these are value lookups, not computation. Bash string operations (`${var%%pattern}`, `${var//old/new}`) are computation — push to a function.

| Allowed in `const` RHS | Not allowed (use function) |
|------------------------|---------------------------|
| `"$var"` | `"${var%%pattern}"` |
| `"${var:-default}"` | `"${var//old/new}"` |
| `"${var:+alt}"` | `"${#var}"` |
| `"literal"` | `$(command)` |

### P11: Function-to-function calls

**File**: docs_parity.jh — rule `only_expected_docs_changed_after_prompt` calls function `is_allowed_file` directly.

**Migration**: under full isolation + no fn-to-fn calls, inline the logic or use a shared lib:

```
function check_only_expected_changed() {
  source "$JAIPH_LIB/file_checks.sh"
  local allowed="$1"
  local changed="$2"

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! is_in_list "$allowed" "$f"; then
      echo "Unexpected file changed: $f" >&2
      return 1
    fi
  done <<< "$changed"
}
```

## Implementation Plan

### Phase 1: Language additions (no breaking changes)

**1a. Add `fail` keyword**
- AST: new `WorkflowStepDef` variant `{ type: "fail"; message: string; loc: SourceLoc }`
- Parser: recognize `fail "reason"` in `workflows.ts`
- Transpiler: emit `echo "reason" >&2; exit 1`

**1b. Add `const` declaration**
- AST: new step type `{ type: "const"; name: string; value: ConstValue; loc: SourceLoc }` where `ConstValue` is string-expr | run-capture | ensure-capture | prompt-capture
- Parser: `const name = ...` with RHS dispatch
- Transpiler: emit `local name; name="value"` or appropriate capture form

**1c. Formalize `wait` as keyword**
- AST: new variant `{ type: "wait"; loc: SourceLoc }`
- Parser: recognize `wait` in workflows (currently falls through to shell)
- Transpiler: emit `wait`

**1d. Switch `if` to brace syntax**
- Parser: recognize `if [not] ensure/run ref { ... } [else if ...] [else { ... }]`
- Keep old `if ... then ... fi` working during Phase 1 (dual parsing)
- Transpiler: both forms emit the same bash

### Phase 2: Rule parser rewrite

**2a. Restructure `RuleDef`**
- Change `RuleDef.commands: string[]` → `RuleDef.steps: RuleStepDef[]` (or reuse `WorkflowStepDef` subset)
- Rewrite `rules.ts` with keyword-aware parsing (mirror `workflows.ts` structure)
- Port existing rule tests first, then validate structured output

**2b. Update rule emission**
- `emit-workflow.ts`: handle structured rule steps instead of opaque command strings

### Phase 3: Function isolation

**3a. Implement full isolation for function execution**
- Transpile function calls to run in a clean environment (only positional args)
- Set `$JAIPH_LIB` env var for shared library access
- Validate that no function body references Jaiph-level symbols

**3b. Reject function-to-function calls**
- Parser/validator: detect when a function body references another Jaiph function name
- Error: `"functions cannot call other Jaiph functions; use a shared library or compose in a workflow"`

### Phase 4: Remove shell (breaking changes)

**4a. Remove shell fallback from workflow parser**
- `workflows.ts`: delete the catch-all `type: "shell"` codepath
- Remove `shellAccumulator` / `braceDepthDelta` shell accumulation
- Emit parser error: `"raw shell is not allowed in workflow; extract to a function"`

**4b. Remove shell fallback from rule parser**
- Same treatment after Phase 2

**4c. Remove old `if` syntax**
- Drop `if ... then ... fi` / `elif` parsing
- Only accept brace syntax with `not` / `else if`

**4d. Enforce pure bash in functions**
- `functions.ts`: reject `return "value"` (non-integer return)
- Remove `jaiph::set_return_value` from function transpilation

**4e. Update send operator**
- Accept `"value"` / `$var` / `run ref` as RHS
- Reject raw shell command as RHS

### Phase 5: Migrate all first-party code

- Rewrite all `e2e/*.jh` fixtures
- Rewrite all `.jaiph/*.jh` workflows
- Create shared libraries in `.jaiph/lib/` for common patterns (P6, P11)
- Update test fixtures and golden transpilation outputs
- Update docs and README examples

### Phase 6: Ship

- Hard parser errors on all legacy syntax
- Error messages include rewrite examples
- Full e2e + golden snapshot CI gate
- Zero P0 parser/runtime failures before merge

## Code Changes Required

| File | Change |
|------|--------|
| `src/types.ts` | Add `fail`, `wait`, `const` step types. Change `RuleDef.commands` → `RuleDef.steps`. Remove `shell` condition kind from `if`. Add `not` / brace-style `if` AST. |
| `src/parse/workflows.ts` | Remove shell fallback, shell accumulator. Add `fail`, `const`, `wait` parsing. Replace `if ... then ... fi` with brace syntax. |
| `src/parse/rules.ts` | Full rewrite: keyword-aware structured parser mirroring workflow parser. |
| `src/parse/functions.ts` | Reject Jaiph `return "value"`, reject calls to other Jaiph functions. |
| `src/transpile/emit-workflow.ts` | Handle new step types. Rewrite rule emission for structured steps. Remove `jaiph::set_return_value` from function paths. Emit function calls with isolation wrapper. |
| `src/transpile/emit-steps.ts` | Remove `emitShellStep` for workflows. Add `emitFailStep`, `emitConstStep`, `emitWaitStep`. |
| `src/transpile/validate.ts` | Allow `run` in rules (functions only). Remove shell-condition validation. Add function isolation validation. |
| `src/transpile/shell-jaiph-guard.ts` | Scope down or remove — shell only exists in functions now. |
| `e2e/*.jh` | Rewrite all fixtures to new syntax. |
| `.jaiph/*.jh` | Rewrite all workflows to new syntax. Create `.jaiph/lib/` shared libraries. |
| `test/fixtures/**` | Update golden transpilation outputs. |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Wide breakage: all raw-shell workflows/rules fail at parse time | High | Single branch, full e2e gate, no merge without 100% pass |
| Rule parser rewrite introduces regressions | High | Port existing rule tests before rewriting parser |
| Ergonomic cost of named functions for trivial shell | Medium | Accepted tradeoff — boundary clarity > brevity |
| `fail` interacts badly with `recover` | Medium | Explicit test: `ensure rule_with_fail recover { ... }` must trigger recover |
| `const` scoping conflicts with bash `local` | Low | `const` is parser-level immutability; transpiles to `local` |
| Return semantics confusion during migration | Medium | Parser errors guide users: `"return 'value' not allowed in function; use echo"` |
| Function isolation perf overhead | Medium | Measure fork cost; optimize hot paths if needed |
| Shared lib mechanism needs runtime support (`$JAIPH_LIB`) | Low | Simple: runtime sets one env var before function execution |
| .jaiph/ workflow migration is large (9 files) | High | Migrate in parallel with parser changes; each file is independently testable |

## Success Criteria

- 100% first-party `.jh` files parse under new grammar
- 100% e2e pass under new runtime
- Zero `type: "shell"` steps in workflow/rule AST output
- `fail` triggers `recover` correctly in `ensure` blocks
- Function bodies reject `return "value"`, `fail`, `const`, other Jaiph keywords
- Function bodies reject calls to other Jaiph functions
- Functions execute in full isolation (no inherited variables)
- `const` declarations work in workflows and rules with all RHS forms
- `if` brace syntax works with `not` and `else if`
- Shared libraries loadable from functions via `$JAIPH_LIB`
- Parser errors for raw shell include actionable rewrite examples
- `jaiph::set_return_value` removed from function transpilation paths
