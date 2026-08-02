---
title: Agent analyzability
permalink: /agent-analyzability
diataxis: explanation
redirect_from:
  - /agent-analyzability.md
---

# Agent analyzability

**Summary.** AI coding agents have a hard context budget. This decision makes analyzability a CI-enforced property of the repo: understanding any one file must require that file plus the small public interfaces of its direct dependencies — never the surrounding codebase. We keep the TypeScript import graph an acyclic, layered, low-fan-out DAG of deep modules, and we keep docs topic-scoped with summary-first headers. Violations fail the build.

For runtime/CLI contracts and pipelines, see [Architecture](architecture.md). For contributor workflow, see [Contributing](contributing.md).

## Decision

Treat **agent analyzability** as a formal, enforceable invariant of this codebase — the same property as human maintainability, measured strictly.

**Invariant.** Understanding any single production file under `src/` requires loading only:

1. that file, and
2. the **public entry points** (interfaces) of its direct dependencies,

and must **not** require paging in sibling implementations, unrelated feature slices, or the whole repository.

## Why

Agents do not fail first from “not being smart enough”; they fail when the import graph forces them to load more than their context window can hold. Tangled imports, cycles, deep reaches into other packages, and oversized files make the context cost of a local change grow with repo size. An unconstrained tree degrades toward “load everything or guess.”

Constraining structure keeps the context cost of a task **bounded and independent of repository growth**. Side effects we want anyway: no cycles, isolated slices, smaller modules, docs that stay navigable from headers.

## Non-goals

- Not a freeze on features or a ban on large behavior changes.
- Not a requirement that every helper be a separate package.
- Not “fewer files at any cost” — deep modules hide many private files behind one small interface; files still stay short.
- Not weakening existing runtime/CLI contracts in [Architecture](architecture.md).

## Code structure

### Layers (DAG)

Imports may point only **downward**. Lower layers never import higher ones.

| Layer | Paths | May import from |
|-------|--------|-----------------|
| **4** CLI | `src/cli/**`, `src/cli.ts` | 3, 2, 1, 0 |
| **3** Runtime | `src/runtime/**` | 2 (only the transpile public graph API), 1, 0 — **not** CLI |
| **2** Compile | `src/transpile/**`, `src/transpiler.ts` | 1, 0 — **not** runtime |
| **1** Parse / format | `src/parse/**`, `src/parser.ts`, `src/format/**` | 0 only |
| **0** Shared leaf | `src/types.ts`, `src/errors.ts`, `src/diagnostics.ts`, `src/version.ts`, `src/env-reserved.ts`, `src/inline-script-name.ts` | other layer-0 files only |

**Already pinned today:** compile-time must not import runtime (`src/transpile/no-runtime-imports.test.ts`). The layer table generalizes that rule.

**Allowlisted exception.** Runtime may depend on the **public** module-graph API from compile (today `loadModuleGraph` / `ModuleGraph` in `module-graph.ts`) because the runner reuses the same graph. That dependency must go through transpile’s public entry, not through validator/emit internals.

### Deep modules (public entry = contract)

Each package is a **deep module**: narrow public surface, large private capability ([Ousterhout](https://www.amazon.com/Philosophy-Software-Design-2nd/dp/173210221X)-style).

| Package | Public entry (contract) | Private |
|---------|-------------------------|---------|
| Shared (0) | the listed `src/*.ts` leaf files themselves | n/a |
| Parse | `src/parser.ts` (and, once introduced, `src/parse/index.ts` if used as the sole external entry) | `src/parse/**` except the entry |
| Format | `src/format/index.ts` (or a single documented emit entry) | other `src/format/**` |
| Transpile | `src/transpiler.ts` + explicit graph exports on the public entry | `validate-*.ts`, emit internals, etc. |
| Runtime | `src/runtime/index.ts` (launch, docker, runner, `buildRuntimeGraph`, shared types/helpers intended for CLI) | `src/runtime/kernel/**` and other internals |
| CLI | `src/cli/index.ts` plus per-slice entries under `src/cli/<slice>/` as needed | slice-private files |

**Rule.** Code **outside** a package imports **only** that package’s public entry. Code **inside** a package may import siblings freely, subject to no-cycles, fan-out, and file-size caps.

**Deep ≠ fat files.** Depth is interface/implementation asymmetry. Implementations stay split into short private files (prefer ≤ ~400 lines; see factory `code_philosophy` and ESLint `max-lines` below).

**Facades are curated.** Public entries export a small, intentional API. `export * from './everything'` is forbidden — it recreates shallow modules and blows fan-out.

### CLI slice isolation

Treat these as vertical slices that must not import each other’s private trees:

`commands`, `run`, `serve`, `mcp`, `exec`, `telemetry`

Cross-slice reuse goes through `src/cli/shared` (or layer 3/0 public entries). Same idea as “no cross-feature imports” in a feature-slice layout.

### Fan-out and file size

| Cap | Default | Enforcement |
|-----|---------|-------------|
| Runtime imports per file | ≤ 8 | ESLint `import/max-dependencies` (`ignoreTypeImports: true`) |
| Lines per file | ≤ 400 | ESLint `max-lines` (`skipBlankLines`, `skipComments`) |

Raise a cap only with an inline disable **and** a one-line justification. Prefer split over raise.

### Cycles

No circular dependencies anywhere under `src/`. Cycles destroy the “direct deps’ interfaces suffice” story: each side needs the other’s body.

## Documentation structure

Docs obey the same budget discipline:

1. **One topic per file** (aligned with Diátaxis page types already in use).
2. **Size cap** — prefer pages agents can load whole; split when a page outgrows a single topic (enforced when the docs-guard task lands).
3. **Summary first** — every page opens with a short summary so an agent can skip the body from the header alone.
4. **Entry-point manifest** — nav in `docs/_layouts/docs.html` plus this page and [Architecture](architecture.md) as the structural maps; do not bury contracts only in chat history or `QUEUE.md`.

## Enforcement (CI)

These are **guardrails**, not conventions. Violations fail CI.

| Mechanism | What it enforces |
|-----------|------------------|
| `dependency-cruiser` (`npm run arch:check`) | no cycles; layer DAG; no cross-CLI-slice private imports; no deep imports past public entries |
| ESLint | `import/max-dependencies`, `max-lines` |
| Existing grep/shape tests | e.g. transpile ↛ runtime, trivia isolation, file-size caps on specific hot files |
| Docs structure tests | Diátaxis front matter, nav bijection, link resolution; plus future summary/size guards |

**Baseline policy.** If the tree already violates a new rule, do **not** weaken the rule. Commit a dependency-cruiser known-violations baseline (and an explicit ESLint grandfather list) so **new** violations fail while old ones are tracked. Follow-up work removes baseline entries; it does not relax severity.

**Scripts (target state).**

```jsonc
"arch:check": "depcruise src --config .dependency-cruiser.cjs",
"arch:graph": "depcruise src --config .dependency-cruiser.cjs --output-type dot | dot -T svg > docs/dependency-graph.svg",
"lint": "eslint src --max-warnings 0"
```

`arch:graph` is optional (needs Graphviz). `arch:check` and `lint` are required CI steps.

## How agents should navigate

1. Read [Architecture](architecture.md) for pipelines and runtime/CLI contracts.
2. Read this page for import-graph and module-boundary rules.
3. Open the **public entry** of the package you need; treat it as the contract.
4. Open private implementations only at the point of change.
5. Assume CI structure checks are trustworthy: if `arch:check` / `lint` pass, the loaded interface set is sufficient for local reasoning.

## Consequences

- New code must land in the correct layer and behind the correct public entry.
- Moving a helper “up” a layer to fix a convenience import is a design smell; move the helper down or widen the lower layer’s public API instead.
- Fixing grandfathered violations (oversized files, deep imports, `runtime` → `cli` leaks) is intentional queued work, not optional cleanup.
- Analyzability and human maintainability are the same invariant measured with tools.

## Status

**Accepted** (2026-08-02). Implementation is phased via `QUEUE.md` tasks; until those land, existing grep tests and docs remain the partial enforcement set.
