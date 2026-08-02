# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Add parse deep-module public entry and ban deep imports #dev-ready

Context: `docs/agent-analyzability.md` requires each package to be a deep module: outsiders import only the public entry. Today callers reach into `src/parse/**` freely. `src/parser.ts` is the intended parse facade for many call sites.

Problem: Deep imports into parse force agents to load private parser internals to understand a caller.

Remediation: Establish the public parse contract as `src/parser.ts` and/or `src/parse/index.ts` (choose one external entry; re-export only the intentional public API — no `export *` barrels of the whole tree). Retarget every import from **outside** `src/parse/` that currently points at `src/parse/<private>` so it goes through that public entry (add named exports as needed). Extend `.dependency-cruiser.cjs` (create the minimal config from `docs/agent-analyzability.md` if missing) with a `no-deep-imports-into-parse` error rule: from `pathNot` parse package, to parse paths other than the public entry. Baseline only remaining violations you cannot fix without out-of-scope moves; prefer fixing call sites. Keep `npm run arch:check` green. Do not redesign parser internals beyond what the public API surface requires.

### Acceptance criteria
- A dependency-cruiser (or equivalent) test fails when a file outside `src/parse/` imports `src/parse/<non-entry>` and passes when it imports only the public entry.
- `rg`/AST test (or depcruise) asserts zero production deep imports into parse from outside the package remain (or only paths listed in the committed baseline, with count reported).
- `npm run build` and `npm test` pass; public entry does not use `export *` from every parse file (test greps the entry for forbidden star-export of the whole directory or asserts an allowlisted export set).
- `docs/agent-analyzability.md` parse row matches the entry path you chose (update the table if the path differs).

## Add transpile deep-module public entry and ban deep imports #dev-ready

Context: `docs/agent-analyzability.md` — transpile is layer 2; outsiders must use its public entry (`src/transpiler.ts` plus explicit graph API). Runtime is allowlisted to use the public module-graph API only. Callers today import `src/transpile/validate-*.ts`, `emit-*`, etc. directly.

Problem: Deep imports into transpile couple CLI/runtime/parse callers to validator internals and inflate agent context.

Remediation: Define the public transpile entry (`src/transpiler.ts` and/or `src/transpile/index.ts`) exporting the intentional compile/graph API (`buildScripts*`, `loadModuleGraph` / `readModuleGraph` / `ModuleGraph` types, `collectDiagnostics` / `validateReferences` as needed by current external callers — curate, do not star-export). Retarget all imports from outside `src/transpile/` to that entry. Add dependency-cruiser `no-deep-imports-into-transpile`. Preserve the existing invariant that transpile production sources must not import `src/runtime/` (`src/transpile/no-runtime-imports.test.ts` must keep passing). Keep `arch:check` green with baseline only for true leftovers.

### Acceptance criteria
- Test: outside-package import of a transpile private path fails `arch:check` / depcruise rule; import via public entry succeeds.
- Test: no production file outside `src/transpile/` imports a non-entry transpile path except baseline-listed leftovers; baseline count reported if non-zero.
- `src/transpile/no-runtime-imports.test.ts` still passes.
- `npm run build` and `npm test` pass.

## Add runtime deep-module public entry; stop runtime importing CLI #dev-ready

Context: `docs/agent-analyzability.md` — runtime is layer 3 and must not import CLI (layer 4). Known leak: `src/runtime/kernel/node-workflow-runtime.ts` imports `src/cli/commands/format-params`. CLI may import runtime’s public entry, not the reverse.

Problem: Runtime → CLI inverts the layer DAG and pulls CLI command modules into kernel analysis.

Remediation: Create `src/runtime/index.ts` (or equivalent) as the public runtime entry for CLI and other outsiders (launch, docker helpers, runner, `buildRuntimeGraph`, emit/redact helpers that CLI legitimately needs — curate). Move or duplicate the minimal `buildStepDisplayParamPairs` (or equivalent) dependency out of `src/cli/commands/` into a layer ≤3 module (shared leaf or runtime-private helper re-exported only if needed), and change runtime to stop importing anything under `src/cli/`. Retarget external deep imports into `src/runtime/**` to the public entry. Add dependency-cruiser rules: `runtime-must-not-import-cli` (error) and `no-deep-imports-into-runtime` (error). Remove these edges from the known-violations baseline when fixed.

### Acceptance criteria
- Test fails if any production file under `src/runtime/` imports a path under `src/cli/`.
- Test fails if a file outside `src/runtime/` deep-imports a non-entry runtime path (baseline only for documented leftovers).
- `npm run arch:check` reports zero `runtime→cli` violations (not merely baselined).
- `npm run build`, `npm test`, and relevant e2e for run/progress display still pass (display param formatting behaviour preserved).

## Add format deep-module public entry and ban deep imports #dev-ready

Context: `docs/agent-analyzability.md` — format is layer 1 beside parse. External callers should use one public entry.

Problem: Deep imports into `src/format/**` bypass the format contract.

Remediation: Add `src/format/index.ts` (or designate a single existing file as the sole public entry) exporting the intentional formatter API. Retarget outside imports. Add `no-deep-imports-into-format` to dependency-cruiser. Keep format → parse/types only (no transpile/runtime/cli).

### Acceptance criteria
- Test: deep import into format from outside fails arch check; public-entry import passes.
- Test: format production sources do not import `src/cli`, `src/runtime`, or `src/transpile` (grep or depcruise).
- `npm run build` and formatter round-trip tests pass.

## Enforce CLI slice isolation in dependency-cruiser #dev-ready

Context: `docs/agent-analyzability.md` — CLI slices `commands`, `run`, `serve`, `mcp`, `exec`, `telemetry` must not import each other’s private files; cross-slice reuse goes through `src/cli/shared` (or lower-layer public entries).

Problem: Cross-slice imports couple unrelated CLI features and force agents to load multiple slices for one command change.

Remediation: Add dependency-cruiser rules so a file under `src/cli/<slice>/` cannot import `src/cli/<other-slice>/` (use path group backreferences if supported by the installed dependency-cruiser version; otherwise one explicit rule per slice pair). Allow imports of `src/cli/shared/**` and the CLI package entry `src/cli/index.ts`. Retarget violating imports by moving shared helpers into `src/cli/shared` or going through lower layers. Baseline only what cannot be moved in this task; prefer fixes. Keep `arch:check` green.

### Acceptance criteria
- Test: a fixture or synthetic import from `src/cli/commands/` to `src/cli/serve/` (private) fails the arch check under committed rules.
- Test: imports from a slice into `src/cli/shared/` still allowed.
- Production cross-slice private imports are zero or only baseline-listed; baseline count reported.
- `npm run build` and `npm test` pass.

## Clear layer-violation baselines (parse/transpile/config) #dev-ready

Context: `docs/agent-analyzability.md` layer table. Known structural leaks include `src/parse/metadata.ts` → `src/transpile/validate-string`, and `src/config.ts` → `src/runtime/kernel/runtime-arg-parser`. These may sit on the dependency-cruiser baseline from earlier tasks.

Problem: Baselined upward imports permanently weaken the analyzability invariant for those edges.

Remediation: Remove the leaks by moving shared helpers to the correct lower layer (e.g. string validation needed at parse time belongs under parse or shared; config parsing helpers used at layer 0 must not live under runtime). Update call sites. Delete the corresponding entries from `.dependency-cruiser-known-violations.json` (or regenerate a smaller baseline). Do not weaken rules. Preserve behaviour; add/adjust unit tests for moved helpers.

### Acceptance criteria
- Test/grep: no production import from `src/parse/` to `src/transpile/`.
- Test/grep: `src/config.ts` does not import from `src/runtime/`.
- `npm run arch:check` passes with those edges absent from the baseline file (baseline file may remain for unrelated leftovers, or be deleted if empty).
- `npm run build` and `npm test` pass.

## Enforce docs summary-first and page size guard #dev-ready

Context: `docs/agent-analyzability.md` applies the same context budget to documentation: one topic per file, summary up front, size cap, nav as entry manifest. `integration/docs-structure.test.ts` already enforces Diátaxis front matter, nav bijection, and link resolution.

Problem: Long docs without a leading summary force agents to ingest whole pages to decide relevance.

Remediation: Extend docs structure tests (or add a sibling integration test) so every published `docs/*.md` page either (a) has an explicit **Summary** section / bold summary paragraph within the first ~20 lines of body after the H1, or (b) meets a documented alternate pattern used by existing pages — pick one enforceable rule and apply it consistently; update pages that fail. Add a soft or hard max body-line cap (choose a single number, e.g. 500 body lines, justified in the test comment) that fails CI when exceeded unless the page is on an explicit allowlist with justification. Do not merge unrelated topics into one file to dodge the cap — split instead if needed. Keep nav bijection green.

### Acceptance criteria
- Integration test fails when a published doc lacks the required summary pattern.
- Integration test fails when a non-allowlisted published doc exceeds the chosen body-line cap.
- All current published docs pass; allowlist entries (if any) include a one-line justification in the test file.
- `npm test` (or the docs-structure integration tests) fail if `docs/agent-analyzability.md` is removed from nav or loses its summary.

## Sync factory code_philosophy with agent-analyzability ADR #dev-ready

Context: `.jaiph/engineer.jh` embeds `code_philosophy` used by overnight implementers. `docs/agent-analyzability.md` is now the ADR for layering, deep modules, and CI arch checks. Agents that only see `code_philosophy` can miss the import-graph rules.

Problem: Factory instructions and the ADR can drift; implementers may add cross-layer or deep imports while following only the short philosophy list.

Remediation: Update `code_philosophy` in `.jaiph/engineer.jh` to require: (1) read `docs/agent-analyzability.md` before changing `src/` import structure; (2) import only via package public entries; (3) respect the layer DAG; (4) keep files ≤ ~400 lines and low fan-out; (5) run `npm run arch:check` and `npm run lint` when those scripts exist, in addition to build/test. Update `.jaiph/architect_review.jh` and/or `AGENT.md` only if needed for the same pointers. Add a small test (grep or workflow test) that fails if `code_philosophy` no longer mentions `agent-analyzability` / `arch:check`.

### Acceptance criteria
- Test greps `.jaiph/engineer.jh` (or the embedded philosophy string) for `agent-analyzability` and `arch:check` and fails if absent.
- `AGENT.md` still points at `docs/agent-analyzability.md` (test or assert file contains the link).
- No behaviour change to engineer workflows beyond prompt text; existing engineer tests (if any) still pass.
