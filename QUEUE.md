# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Performance — remove redundant local workflow-start work #dev-ready

**Problem**
The default local `jaiph run <file.jh>` path does redundant startup work before the first useful workflow event:

* `src/cli/commands/run.ts` parses the entry file to read metadata/config and print the banner.
* `buildScripts()` walks and parses the transitive `.jh` module set to emit script bodies.
* The spawned `src/runtime/kernel/node-workflow-runner.ts` then calls `buildRuntimeGraph()`, which reads and parses the import closure again before constructing `NodeWorkflowRuntime`.

For small workflows this duplicate parse/graph setup is a plausible source of the observed 2-4 second lag. Optimize this path before chasing Docker, raw mode, or external subprocess costs.

**Goal**
Reduce cold-start latency for default local `jaiph run <file.jh>` by eliminating avoidable repeated `.jh` reads/parses between CLI compile prep and the runtime graph used by `NodeWorkflowRuntime`.

**Scope**

* In scope: non-Docker, non-`--raw` `jaiph run <file.jh>` from the host CLI through the spawned Node workflow runner.
* Out of scope: `jaiph run --raw`, Docker startup/image prep, prompt provider latency, shell command runtime, and bootstrap install performance.
* Prefer one shared module-graph/compile-prep representation over separate ad hoc caches. If serialization is used to cross the process boundary, keep it internal and deterministic.
* Preserve user-visible run semantics: banner, hooks, run artifacts, summaries, return values, exit codes, and `__JAIPH_EVENT__` handling must remain compatible with current behavior.

**Measurement notes**

* Use a minimal workflow and one imported-module workflow as repro cases.
* Measure time from CLI process start to the first parsed `__JAIPH_EVENT__` line on stderr. If an implementation chooses a different first-event marker, define it in the PR or commit message.
* Record before/after timings on the same machine. These timings are evidence for the optimization, not acceptance criteria.

**Acceptance criteria**

* A unit or integration test proves the default local run path does not read/parse the entry module once in the parent and then re-read/re-parse the same module in the child to build the runtime graph. The test must fail if the old `run.ts` + `buildScripts()` + `node-workflow-runner.ts` duplicate parse pattern returns.
* A test with at least one imported `.jh` module proves the optimized graph/compile-prep path preserves cross-module workflow, rule, and script resolution.
* Existing local run behavior remains covered: a minimal workflow still emits the expected start/end events, writes run artifacts/summary metadata, returns the workflow return value, and exits with the correct status.
* The change does not alter `jaiph run --raw` or Docker launch behavior; add a focused test or assertion if shared launch code is touched.
* `npm test` passes.

***
