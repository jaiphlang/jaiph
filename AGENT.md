# AGENT.md

This document defines how coding agents should work in this repository.

## Architecture Source of Truth

- `docs/architecture.md` is the source of truth for system architecture and execution flow.
- Before changing parser/transpiler/runtime/CLI boundaries, read `docs/architecture.md` and keep changes aligned.
- Preserve the documented contracts:
  - runtime -> CLI live events via `__JAIPH_EVENT__`,
  - runtime -> durable artifacts via `.jaiph/runs` and `run_summary.jsonl`,
  - Jaiph runtime test lane (`*.test.jh`) via `jaiph test`.

## Core Goals

- Preserve user-facing CLI behavior, especially `jaiph run` output.
- Prefer small, verifiable changes over broad rewrites.
- Keep tests readable and stable; treat them as product contracts.

## Testing Strategy (Required)

- **Run tests for every substantive change.**
- **Order of confidence:**
  - Colocated module tests in `src/**/*.test.ts` for pure logic.
  - Cross-cutting tests in `test/*.test.ts` for process/runtime behavior.
  - E2E shell tests in `e2e/tests/*.sh` for CLI contracts and golden outputs.
- Before broad test runs, execute the most relevant targeted test(s) first.
- New module tests go next to the source file they test (e.g. `src/parse/core.test.ts`).
- Tests that span multiple modules or test process-level behavior go in `test/`.

Useful commands:

- `npm run build`
- `node --test dist/src/**/*.test.js` (colocated module tests)
- `node --test dist/test/*.test.js` (cross-cutting tests)
- `bash e2e/test_all.sh`
- Single e2e script: `bash e2e/tests/<name>.sh`

## E2E Shell Test Style (Strict)

E2E tests are documentation. They must be easy for humans to read.

- Use clear sections and comments.
- Structure each scenario with explicit comments:
  - `# Given`
  - `# When`
  - `# Then`
- Keep setup local to the scenario; avoid hidden coupling.
- Prefer deterministic inputs and outputs.

### Tree Output Assertions

For `jaiph run` output, assert the **whole tree contract**, not isolated fragments.

- Use `e2e::assert_output_equals` with normalized output whenever possible.
- Build an expected multiline output block and compare end-to-end.
- Do not rely only on partial `assert_contains` checks for tree structure.
- If output is dynamic (timings/colors), normalize first via `e2e::normalize_output`.

## TTY / Progress Rendering Guidance

- TTY behavior is fragile and must be protected by acceptance/e2e coverage.
- Validate observable behavior, not implementation details:
  - Running line appears.
  - Timer updates over time.
  - Final PASS/FAIL summary is present.
  - Tree projection remains correct.
- Avoid overfitting tests to exact ANSI escape internals.

## Change Discipline

- Do not modify unrelated files.
- If you find unrelated failing tests, call them out explicitly.
- If updating behavior, update tests in the same change.
- Keep commits coherent: one logical intent per change.

## Practical Coding Rules

- Keep code and tests readable for humans.
- Prefer existing helpers in `e2e/lib/common.sh` over custom assertion logic.
- Avoid large custom test harnesses unless existing tools cannot solve the problem.
- When introducing nontrivial logic, add concise comments explaining intent.
