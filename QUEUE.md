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
