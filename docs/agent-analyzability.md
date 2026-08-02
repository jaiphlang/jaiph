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

**Already pinned today:** compile-time must not import runtime (`src/transpile/no-runtime-imports.test.ts`). The layer table generalizes that rule, and `npm run arch:check` now enforces the whole table (see [Enforcement (CI)](#enforcement-ci)).

**Allowlisted exception.** Runtime may depend on the **public** module-graph API from compile (today `loadModuleGraph` / `ModuleGraph` in `module-graph.ts`) because the runner reuses the same graph. That dependency must go through transpile’s public entry, not through validator/emit internals.

### Deep modules (public entry = contract)

Each package is a **deep module**: narrow public surface, large private capability ([Ousterhout](https://www.amazon.com/Philosophy-Software-Design-2nd/dp/173210221X)-style).

| Package | Public entry (contract) | Private |
|---------|-------------------------|---------|
| Shared (0) | the listed `src/*.ts` leaf files themselves | n/a |
| Parse | `src/parser.ts` (sole external entry; re-exports the intentional public API — no `export *` barrel) | `src/parse/**` |
| Format | `src/format/index.ts` (sole external entry; re-exports the intentional formatter API, no `export *` barrel) | other `src/format/**` |
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

Turn a cap off for a file only with a per-file override in `eslint.config.mjs` (or an inline disable) **and** a one-line justification. Prefer split over raise.

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
| `dependency-cruiser` (`npm run arch:check`) | no cycles; the layer DAG (including `runtime` ↛ `cli`); deep imports past the parse public entry (`no-deep-imports-into-parse`), the transpile public entry (`no-deep-imports-into-transpile`), the runtime public entry (`no-deep-imports-into-runtime`), and the format public entry (`no-deep-imports-into-format`); cross-CLI-slice private imports (`no-cross-cli-slice-imports`); deep imports into the remaining packages are still queued |
| ESLint (`npm run lint`) | `import/max-dependencies` and `max-lines` on `src/**/*.ts`, with a grandfather list of existing violators in `eslint.config.mjs` |
| Existing grep/shape tests | e.g. transpile ↛ runtime, trivia isolation, file-size caps on specific hot files |
| Docs structure tests | Diátaxis front matter, nav bijection, link resolution; plus future summary/size guards |

**Baseline policy.** If the tree already violates a new rule, do **not** weaken the rule. Commit a dependency-cruiser known-violations baseline (and an explicit ESLint grandfather list) so **new** violations fail while old ones are tracked. Follow-up work removes baseline entries; it does not relax severity.

**Landed today.** `.dependency-cruiser.cjs` and `npm run arch:check` now enforce `no-circular` and the layer DAG, meaning each layer's rule against upward imports, including the exception that lets runtime reuse only the transpile public module-graph API. Orphan modules are reported as a warning. Pre-existing violations are grandfathered in `.dependency-cruiser-known-violations.json` and passed to the check with `--ignore-known`, so a new cycle or upward import fails the build while the tracked ones do not. `eslint.config.mjs` and `npm run lint` now enforce the two caps below on `src/**/*.ts`: `import/max-dependencies` at 8 (type imports ignored) and `max-lines` at 400 (blank and comment lines skipped). Test files are out of scope, because they legitimately import many modules and run long. Files that already exceed a cap are grandfathered by a per-file override in `eslint.config.mjs` that turns off only the rule they break, each with a one-line reason, and the global cap is never raised, so any new violation still fails. Deep imports past the parse public entry (`src/parser.ts`) are now enforced by the `no-deep-imports-into-parse` rule, and every production call site routes through the entry (the former `validate-string.ts` → `parse/core.ts` baseline is gone: the interpolation validator moved into parse, see below). Deep imports past the transpile public entry are now enforced by the `no-deep-imports-into-transpile` rule: code outside `src/transpile/` imports only `src/transpiler.ts` (the compile/validate surface: `buildScripts*`, `loadModuleGraph`, `collectDiagnostics`, `walkjhFiles`, `ModuleGraph` types, …) or the allowlisted public module-graph API (`src/transpile/module-graph.ts`, which runtime reuses); the CLI `collectDiagnostics`/`walkjhFiles` call sites were retargeted to the entry, and the former parse→transpile leak is gone: `validateJaiphStringContent`/`extractInlineCaptures` (which need `parseCallRef`) moved down into `src/parse/validate-string-content.ts`, so `parse/metadata.ts` uses a parse sibling and `transpile/validate-string.ts` re-exports them through `src/parser.ts` — no production file under `src/parse/` imports `src/transpile/`. The runtime slice now has a public entry too: `src/runtime/index.ts` re-exports the curated CLI-facing surface (graph construction, launch/runner, the Docker sandbox, emit/redact/portability helpers, embedded assets, and run-tree param display) and `no-deep-imports-into-runtime` fails any outside import that reaches a `src/runtime/**` internal. The runtime→CLI leak is gone: `buildStepDisplayParamPairs` moved out of `src/cli/commands/format-params.ts` into `src/runtime/kernel/format-params.ts` (re-exported through the public entry), so no production runtime file imports `src/cli/**` and there are zero baselined `runtime`→`cli` edges. Every production CLI call site that reached a runtime internal (docker, emit, portability, redact, runner, launch, embedded-assets) was retargeted to `src/runtime/index.ts`; the former `src/config.ts` → `runtime/kernel/runtime-arg-parser` leak is gone too — the pure `interpolate` helper moved down into `src/config.ts` (which `runtime-arg-parser` now imports downward and re-exports), so `config.ts` imports nothing from `src/runtime/`. The only baselined `no-deep-imports-into-runtime` leftovers are cross-package test-seam imports (`_dockerExec`, `RuntimeEventEmitter`, …) that are not part of the public surface. The format slice now has a public entry too: `src/format/index.ts` re-exports the formatter API (`emitModule` and the `EmitOptions` type) and `no-deep-imports-into-format` fails any outside import that reaches a `src/format/**` internal such as `emit.ts`. The one outside call site (`src/cli/commands/format.ts`) was retargeted to the entry, and format keeps importing only parse and types, so no format source imports `src/cli`, `src/runtime`, or `src/transpile`. CLI slice isolation is now enforced too: `no-cross-cli-slice-imports` fails any import from one slice (`commands`, `run`, `serve`, `mcp`, `exec`, `telemetry`) into another slice's private tree, using a `$1` path-group backreference so same-slice imports and imports of `src/cli/shared/**` (or lower-layer public entries) stay allowed. The one back-edge that was a shared display helper (`run/display.ts` → `commands/format-params.ts`) was fixed by moving `format-params.ts` into `src/cli/shared/`; the remaining cross-slice edges are composition-root wiring (`commands/*` launching each feature) and feature composition (`serve` exposing `mcp` tools and `exec` over HTTP, `exec` reusing `run` lifecycle), which cannot move within this task and are tracked in the baseline. The deep-import rules for the remaining packages are still queued in `QUEUE.md`.

**Scripts.** The import-graph gate and the ESLint caps gate are both live and wired to their committed configs:

```jsonc
"arch:check": "depcruise src --config .dependency-cruiser.cjs --ignore-known",
"lint": "eslint src --max-warnings 0",
```

Both `arch:check` and `lint` are required CI steps on the Compiler and unit tests job. One script is still planned but not added yet: an optional `arch:graph` (`depcruise … --output-type dot | dot -T svg > docs/dependency-graph.svg`, needs Graphviz).

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

**Accepted** (2026-08-02). Implementation is phased via `QUEUE.md` tasks. The dependency-cruiser gate (`npm run arch:check`) for no cycles and the layer DAG has landed and runs in CI. The ESLint fan-out and file-size caps (`npm run lint`) have also landed and run in CI, with existing violators grandfathered in `eslint.config.mjs`. The `no-deep-imports-into-parse`, `no-deep-imports-into-transpile`, `no-deep-imports-into-runtime`, and `no-deep-imports-into-format` rules now guard the parse, transpile, runtime, and format public entries, and the `runtime` ↛ `cli` inversion is fixed (no production runtime file imports `src/cli/**`). CLI slice isolation (`no-cross-cli-slice-imports`) now guards the six CLI slices against importing each other's private trees, with unmovable composition-root and feature-composition edges tracked in the baseline. The deep-import rules for the remaining packages are still queued, so existing grep tests and docs remain the partial enforcement set for those.
