# Jaiph Architecture

This document maps the current code layout so queue tasks stay robust after refactors.

## High-level flow

1. Parse `.jh/.jph` source into AST.
2. Validate AST references and test references.
3. Transpile to bash scripts.
4. Run workflows/tests through CLI and runtime shell helpers.

## Source map

- `src/parse/`
  - Parsing logic split by concern (core, imports, rules, workflows, tests, metadata, functions).
- `src/transpile/`
  - Build orchestration, symbol/path resolution, validation, and bash emission.
- `src/cli/`
  - Command entrypoints and run/test/build/init command handlers.
- `src/runtime/`
  - Runtime shell components (prompt execution, test mode, events, sandbox, step handling).
- `src/jaiph_stdlib.sh`
  - Shared shell stdlib used by transpiled workflows.
- `src/types.ts`
  - Core AST/runtime TypeScript types.
- `src/config.ts`
  - Runtime configuration shaping and resolution utilities.

## Command entrypoints

- `src/cli/commands/run.ts` -> `jaiph run`
- `src/cli/commands/test.ts` -> `jaiph test`
- `src/cli/commands/build.ts` -> `jaiph build`
- `src/cli/commands/init.ts` -> `jaiph init`

## Tests and validation

- Unit/integration: `npm test`
- End-to-end: `npm run test:e2e`
- Build check: `npm run build`

## Test stability policy

- `e2e/tests/*` and acceptance JS tests are behavior contracts and should be changed rarely.
- Default approach: change production code to satisfy existing tests, not vice versa.
- Modify those tests only with a very strong reason (intentional product behavior change, incorrect test expectation, or removal of obsolete feature).
- Any such test change should be minimal and paired with a clear rationale in the task/PR notes.

## Queue implementation rule

For `.jaiph/QUEUE.md` tasks:

- Treat each task's `Files to change` as the starting set, not a hard limit.
- Prefer minimal edits that satisfy acceptance criteria.
- Keep behavior-compatible changes localized to module boundaries above.
