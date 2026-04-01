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

## Add untested compiler error paths to txtar fixtures <!-- dev-ready -->

**Goal**  
Write new txtar test cases for the ~35 compiler error paths that currently have zero test coverage.

**Context**

- The compiler test coverage audit identified ~35 `fail()` / `jaiphError()` calls with no test coverage (see list below).
- These are all parse-time or validation-time error paths that should produce specific error codes and messages.
- With the txtar infrastructure in place, adding these is straightforward: one `=== test name` block per untested path.

**Untested error paths to cover:**

Parse errors (`compiler-tests/parse-errors.txt`):
- `match.ts`: unterminated string in pattern, unterminated regex, empty regex, invalid regex, empty arm body, unterminated arm string, single-quoted pattern, single-quoted arm body, missing `=>` arrow (9 cases)
- `workflows.ts`: config block must appear before steps, calls require parentheses for run async, log/logerr format errors (4 variants), invalid workflow reference in route (7 cases)
- `workflow-brace.ts`: expected "else {", else body on same line, wait in rules, prompt in rules, send in rules, run async capture in brace, malformed else-if (3 variants) (10 cases)
- `scripts.ts`: unterminated script block, script command required (2 cases)
- `metadata.ts`: single-quoted array element, unquoted array element, unclosed array (3 cases)
- `tests.ts`: unterminated test block, mock function deprecated (2 cases)
- `send-rhs.ts`: unterminated `${...}`, `$(...)` inside `${...}` (2 cases)
- `inline-script.ts`: unexpected content after inline script, unterminated parens (2 cases)

Validation errors (`compiler-tests/validate-errors.txt`):
- `validate.ts`: match exactly one wildcard arm (missing), match multiple wildcards, dot-field not a typed prompt, dot-field unknown field, ensure recover in rules (validate layer), const prompt in rules (validate layer) (6 cases)

**Scope**

1. For each untested path listed above, write a minimal `.jh` source that triggers that specific error.
2. Add the `=== test name` block with `# @expect error E_CODE "message substring"` to the appropriate txtar file.
3. Run `npm run test:compiler` to verify all new cases pass (the compiler produces the expected error).
4. If any error path is unreachable (dead code), document it with a `# NOTE: unreachable` comment and skip.

**Acceptance criteria**

- All ~35 previously untested error paths now have txtar test cases.
- `npm run test:compiler` passes with the new cases.
- Compiler error path coverage reaches ~95%+ (up from ~80%).

---
