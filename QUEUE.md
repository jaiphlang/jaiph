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

## Performance — investigate and fix slow installation

**Goal**
`jaiph install` (and related dependency or bootstrap steps) feels unreasonably slow; find the dominant cost and improve it without weakening reproducibility (lockfile, shallow clone behavior, etc.).

**Scope**

* Profile or instrument the install path (git clone, lockfile I/O, post-install) and document the top 1–3 contributors to latency.
* Implement targeted fixes (e.g. avoid redundant work, reduce subprocess churn, cache safely) and verify wall-clock improvement on a cold and warm run where applicable.

**Acceptance criteria**

* A short note in the commit or PR description states what was slow and what changed, with before/after rough timings on the same machine.
* `jaiph install` behavior remains correct: same lockfile semantics and failure modes for bad URLs or missing refs.
* `npm test` passes.

***

## Performance — investigate and fix slow workflow start (initial 2–4 s lag)

**Goal**
When starting workflows (e.g. `jaiph run` / first step), users observe a 2–4 second delay before useful work; reduce that lag or explain and eliminate unnecessary startup work (JIT, imports, process spawn, discovery).

**Scope**

* Reproduce the lag with a minimal `.jh` workflow; trace Node startup, module load, and runtime init (`NodeWorkflowRuntime` and friends).
* Address fixable costs (e.g. defer heavy work, lazy imports, avoid redundant file scans) without changing user-visible workflow semantics.

**Acceptance criteria**

* Documented repro (command + minimal file) and what was measured (time to first event / first step).
* Measurable reduction in the cold-start path on a representative case, or a clear justification if the lag is irreducible (e.g. external subprocess).
* `npm test` passes.

***

## `for … in …` — optional built-in trim / skip-empty #dev-ready

**Goal**
Evaluate optional sugar (keywords, modifiers, or a small stdlib helper) for trimming each iterated line or skipping empty lines, if authors repeatedly need shell-style normalization beyond an explicit `if line != "" { … }`.

**Scope**

* Baseline behavior and splitting rules are documented in `docs/language.md`.
* If a language change is chosen, add tests and note migration for workflows that would adopt it.

**Acceptance criteria**

* Decision recorded in `docs/language.md` (new subsection or changelog in that doc).
* `npm test` passes.

***
