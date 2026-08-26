---
title: Agent analyzability
permalink: /agent-analyzability
diataxis: explanation
redirect_from:
  - /agent-analyzability.md
---

# Agent analyzability

**Summary.** AI coding agents have a limited context budget. This page makes analyzability a property that CI enforces. Understanding any one file must require only that file plus the small public interfaces of its direct dependencies, and never the surrounding codebase. We keep the TypeScript import graph acyclic, layered, and low in fan-out, built from deep modules, and we keep each docs page scoped to one topic with a summary first. Violations fail the build.

For runtime/CLI contracts and pipelines, see [Architecture](architecture.md). For contributor workflow, see [Contributing](contributing.md).

## Decision

Treat **agent analyzability** as a formal, enforceable invariant of this codebase. It is the same property as human maintainability, measured strictly.

**Invariant.** Understanding any single production file under `src/` requires loading only:

1. that file, and
2. the **public entry points** (interfaces) of its direct dependencies,

and must **not** require paging in sibling implementations, unrelated feature slices, or the whole repository.

## Why

Agents do not fail first from "not being smart enough". They fail when the import graph forces them to load more than their context window can hold. Tangled imports, cycles, deep reaches into other packages, and oversized files make the context cost of a local change grow with repo size. An unconstrained tree degrades toward "load everything or guess".

Constraining structure keeps the context cost of a task **bounded and independent of repository growth**. Side effects we want anyway: no cycles, isolated slices, smaller modules, docs that stay navigable from headers.

## Non-goals

- Not a freeze on features or a ban on large behavior changes.
- Not a requirement that every helper be a separate package.
- Not "fewer files at any cost". Deep modules hide many private files behind one small interface, and files still stay short.
- Not weakening existing runtime/CLI contracts in [Architecture](architecture.md).

## Code structure

### Layers (DAG)

Imports may point only **downward**. Lower layers never import higher ones.

| Layer | Paths | May import from |
|-------|--------|-----------------|
| **4** CLI | `src/cli/**`, `src/cli.ts` | 3, 2, 1, 0 |
| **3** Runtime | `src/runtime/**` | 2 (only the transpile public entry `src/transpiler.ts`), 1, 0, but **not** CLI |
| **2** Compile | `src/transpile/**`, `src/transpiler.ts` | 1, 0, but **not** runtime |
| **1** Parse / format | `src/parse/**`, `src/parser.ts`, `src/format/**` | 0 only |
| **0** Shared leaf | `src/types.ts`, `src/errors.ts`, `src/diagnostics.ts`, `src/version.ts`, `src/env-reserved.ts`, `src/inline-script-name.ts` | other layer-0 files only |

**Already pinned today:** compile-time must not import runtime (`src/transpile/no-runtime-imports.test.ts`). The layer table generalizes that rule, and `npm run arch:check` now enforces the whole table (see [Enforcement (CI)](#enforcement-ci)).

**Allowlisted exception.** Runtime may depend on the **public** module-graph API from compile (`loadModuleGraph` / `readModuleGraph` / `writeModuleGraph` / `ModuleGraph`, …) because the runner reuses the same graph. That dependency must go through transpile's single public entry `src/transpiler.ts` (which re-exports the module-graph API), never through `src/transpile/module-graph.ts` or any other internal.

### Deep modules (public entry = contract)

Each package is a **deep module**: narrow public surface, large private capability ([Ousterhout](https://www.amazon.com/Philosophy-Software-Design-2nd/dp/173210221X)-style).

| Package | Public entry (contract) | Private |
|---------|-------------------------|---------|
| Shared (0) | the listed `src/*.ts` leaf files themselves | n/a |
| Parse | `src/parser.ts` (sole external entry; re-exports the intentional public API, with no `export *` barrel) | `src/parse/**` |
| Format | `src/format/index.ts` (sole external entry; re-exports the intentional formatter API, no `export *` barrel) | other `src/format/**` |
| Transpile | `src/transpiler.ts` (sole external entry; re-exports the compile/validate surface plus the full module-graph API, no `export *` barrel) | `module-graph.ts`, `validate-*.ts`, emit internals, etc. |
| Runtime | `src/runtime/index.ts` (launch, runner, `buildRuntimeGraph`, shared types/helpers intended for CLI); `src/runtime/testing.ts` is a second entry for named test seams that cross-package `*.test.ts` files reach (kept off the production entry) | `src/runtime/kernel/**` and other internals |
| CLI | `src/cli/index.ts` plus per-slice entries under `src/cli/<slice>/` as needed | slice-private files |

**Rule.** Code **outside** a package imports **only** that package's public entry. Code **inside** a package may import siblings freely, subject to no-cycles, fan-out, and file-size caps.

**Deep ≠ fat files.** Depth is interface/implementation asymmetry. Implementations stay split into short private files (prefer ≤ ~400 lines; see factory `code_philosophy` and ESLint `max-lines` below).

**Facades are curated.** Public entries export a small, intentional API. `export * from './everything'` is forbidden, because it recreates shallow modules and raises fan-out.

### CLI slice isolation

Treat these as vertical slices: `commands`, `run`, `serve`, `mcp`, `exec`, `telemetry`.

**`commands` is the composition root.** It wires the other slices together (each `jaiph` subcommand launches its feature), so `commands` may import any slice's private tree, which is orchestration and not peer coupling.

**Peer slices must not import each other.** `run`, `serve`, `mcp`, `exec`, and `telemetry` must **not** import each other's private trees. Peer coupling, for example `serve` importing `mcp`, is the analyzability problem this rule targets, because it makes one feature impossible to understand without paging in another. Cross-slice reuse among peers goes through `src/cli/shared` (or layer 3/0 public entries). This is the same idea as "no cross-feature imports" in a feature-slice layout, with the composition root exempted.

Enforced by `no-cross-cli-slice-imports` in `.dependency-cruiser.cjs`: its `from` set is the peer slices only (`commands` excluded), so a `commands` → slice import passes while a peer → peer private import fails. The former feature-composition edges (`serve` mounting `mcp`/`exec`, `exec` reusing `run`/`telemetry`) are **gone, not baselined**: the shared MCP-protocol engine (`shared/mcp-server`, `shared/mcp-tools`) and the workflow-call executor (`shared/workflow-call`) now live under `src/cli/shared`, so `serve`, the `jaiph mcp` subcommand, and `shared/generation` all reach them downward and no peer slice imports another peer's private tree. The baseline carries **zero** `no-cross-cli-slice-imports` entries.

### Fan-out and file size

| Cap | Default | Enforcement |
|-----|---------|-------------|
| Runtime imports per file | ≤ 8 | ESLint `import/max-dependencies` (`ignoreTypeImports: true`) |
| Lines per file | ≤ 400 | ESLint `max-lines` (`skipBlankLines`, `skipComments`) |

Turn a cap off for a file only with a per-file override in `eslint.config.mjs` (or an inline disable) **and** a one-line justification. Prefer split over raise.

### Cycles

No circular dependencies anywhere under `src/`. Cycles break the guarantee that a file's direct dependencies and their public interfaces are enough to understand it, because each side then needs the other's body.

## Documentation structure

Docs obey the same budget discipline:

1. **One topic per file** (aligned with Diátaxis page types already in use).
2. **Size cap.** Prefer pages agents can load whole, and split a page when it outgrows a single topic. This is enforced by `integration/docs-structure.test.ts`, which fails any non-allowlisted `docs/*.md` whose body exceeds 500 lines (front matter excluded). An oversized single-topic page goes on the test's `DOC_SIZE_ALLOWLIST` with a justification rather than merging topics.
3. **Summary first.** Every page opens with a short summary so an agent can skip the body from the header alone. The same test requires the first body line after the H1 to be a prose lead paragraph (this page labels its lead `**Summary.**`), not a subheading, list, or table.
4. **Entry-point manifest.** The nav in `docs/_layouts/docs.html`, plus this page and [Architecture](architecture.md), are the structural maps. Do not bury contracts only in chat history or `QUEUE.md`.

## Enforcement (CI)

These are **guardrails**, not conventions. Violations fail CI.

| Mechanism | What it enforces |
|-----------|------------------|
| `dependency-cruiser` (`npm run arch:check`) | no cycles; the layer DAG (including `runtime` ↛ `cli`); deep imports past the parse public entry (`no-deep-imports-into-parse`), the transpile public entry (`no-deep-imports-into-transpile`), the runtime public entry (`no-deep-imports-into-runtime`), and the format public entry (`no-deep-imports-into-format`); cross-CLI-slice private imports (`no-cross-cli-slice-imports`). Every layer now sits behind a public-entry gate, and the committed known-violations baseline (`.dependency-cruiser-known-violations.json`) is empty, so no cycles, upward imports, deep imports, or cross-slice edges remain tracked |
| ESLint (`npm run lint`) | `import/max-dependencies` and `max-lines` on `src/**/*.ts`. Most former violators were split into sibling modules and now pass under the global caps with no override; the four largest remaining files keep a per-file override in `eslint.config.mjs`, each with a fresh justification |
| Existing grep/shape tests | e.g. transpile ↛ runtime, trivia isolation, file-size caps on specific hot files |
| Docs structure tests | Diátaxis front matter, nav bijection, link resolution, summary-first lead, and a 500-line body cap (`integration/docs-structure.test.ts`) |

**Baseline policy.** If the tree already violates a new rule, do **not** weaken the rule. Commit a dependency-cruiser known-violations baseline (and an explicit ESLint grandfather list) so **new** violations fail while old ones are tracked. Follow-up work removes baseline entries; it does not relax severity.

**Landed today.** Both gates run in CI, and every rule below is enforced now rather than left open.

The import-graph gate lives in `.dependency-cruiser.cjs` and runs through `npm run arch:check`:

- `no-circular` and the layer DAG are enforced. Each layer's rule forbids upward imports, including the exception that lets runtime reuse compile only through the single public entry `src/transpiler.ts`. Orphan modules are reported as a warning.
- Pre-existing violations were grandfathered in `.dependency-cruiser-known-violations.json` and passed to the check with `--ignore-known`, so a new cycle or upward import fails the build. That baseline is now empty, because every originally grandfathered edge was fixed rather than kept, so no import-graph violation remains tracked.
- Two upward test edges were also cleared by moving each test to its correct layer rather than baselining it. The parser-error snapshot test that needs `loadModuleGraph` moved from `src/parse/` to `src/transpile/`, and the compile-to-runtime graph-reuse test that needs `buildRuntimeGraph` moved from `src/transpile/` to `src/runtime/`.

Every package now sits behind a public-entry rule that fails any outside import reaching an internal file:

- **Parse.** `no-deep-imports-into-parse` guards `src/parser.ts`, and every production call site routes through the entry. The interpolation validators `validateJaiphStringContent` and `extractInlineCaptures` (which need `parseCallRef`) moved down into `src/parse/validate-string-content.ts`, so `parse/metadata.ts` uses a parse sibling and `transpile/validate-string.ts` re-exports them through `src/parser.ts`. No production file under `src/parse/` imports `src/transpile/`.
- **Transpile.** `no-deep-imports-into-transpile` guards the single public entry `src/transpiler.ts`, which re-exports the compile and validate surface plus the full module-graph API (`buildScripts*`, `loadModuleGraph` / `readModuleGraph` / `writeModuleGraph`, `collectDiagnostics`, `walkjhFiles`, and the `ModuleGraph` types). `src/transpile/module-graph.ts` is no longer a second door, so runtime reaches the graph API through `src/transpiler.ts` too, and `layer3-runtime-only-transpile-public-graph` forbids every `runtime` to `src/transpile/**` edge. The CLI `collectDiagnostics` and `walkjhFiles` call sites were retargeted to the entry.
- **Runtime.** `no-deep-imports-into-runtime` guards `src/runtime/index.ts`, which re-exports the CLI-facing surface (graph construction, launch and runner, emit, redact, and portability helpers, embedded assets, and run-tree param display). The runtime-to-CLI leak is gone, because `buildStepDisplayParamPairs` moved out of the CLI into `src/runtime/kernel/format-params.ts` (re-exported through the runtime public entry, with a thin CLI re-export at `src/cli/shared/format-params.ts`), so no production runtime file imports `src/cli/**`. The `src/config.ts` to `runtime-arg-parser` leak is gone too, because the pure `interpolate` helper moved down into `src/config.ts` (which `runtime-arg-parser` now imports downward and re-exports), so `config.ts` imports nothing from `src/runtime/`. The cross-package test seams `CHAIN_GENESIS`, `chainHmac`, and `RuntimeEventEmitter` moved to a second public entry, `src/runtime/testing.ts`, allowlisted beside `index.ts` in the rule, so those seams stay off the production entry while no test reaches a raw `src/runtime/**` path.
- **Format.** `no-deep-imports-into-format` guards `src/format/index.ts`, which re-exports the formatter API (`emitModule` and the `EmitOptions` type). The one outside call site, `src/cli/commands/format.ts`, routes through the entry, and format still imports only parse and types.

CLI slice isolation is enforced by `no-cross-cli-slice-imports`. It fails any import from a peer slice (`run`, `serve`, `mcp`, `exec`, `telemetry`) into another slice's private tree, and a `$1` path-group backreference keeps same-slice imports and imports of `src/cli/shared/**` allowed. `commands` is the composition root and is deliberately absent from the rule's `from` set, so a `commands` to slice import passes while a peer to peer private import fails.

The former 17 peer feature-composition edges were not domain contracts of their home slices. They were shared CLI infrastructure misfiled inside peer slices, and `shared/generation.ts` already reached up into `exec/call`, `mcp/tools`, and three `run/*` modules, an inverted dependency the baseline hid. The fix moves that infrastructure down into `src/cli/shared`: the MCP-protocol engine (`shared/mcp-server.ts` and `shared/mcp-tools.ts`, used by both the `jaiph mcp` stdio subcommand and `jaiph serve` over HTTP) and the workflow-call executor (`shared/workflow-call.ts`, used by `commands/mcp`, `commands/serve`, `serve/handler`, and `shared/generation`). Because `shared` is not in the rule's `from` set, `shared/workflow-call.ts` may import `run/*` and `telemetry/otlp` downward without a peer violation, so the run and telemetry primitives stay put. The `mcp` and `exec` slice directories no longer exist, while the peer-slice regex still names them so a reintroduced private tree stays guarded. Zero cross-slice edges remain in the baseline.

The ESLint caps live in `eslint.config.mjs` and run through `npm run lint`. Both caps apply to `src/**/*.ts`: `import/max-dependencies` at 8 (type imports ignored) and `max-lines` at 400 (blank and comment lines skipped). Test files are out of scope, because they legitimately import many modules and run long. Most files that once exceeded a cap were split into sibling modules in the same directory and now pass with no override. The four largest remaining files keep a per-file override that turns off only the rule they break, each with a justification, and the global cap is never raised, so a new violation still fails.

**Scripts.** The import-graph gate and the ESLint caps gate are both live and wired to their committed configs:

```jsonc
"arch:check": "depcruise src --config .dependency-cruiser.cjs --ignore-known",
"lint": "eslint src --max-warnings 0",
```

Both `arch:check` and `lint` are required CI steps on the Compiler and unit tests job. There is intentionally **no** committed `arch:graph` gate: rendering the graph (`depcruise … --output-type dot | dot -T svg > docs/dependency-graph.svg`) needs Graphviz's `dot`, which is not a declared dependency, so it stays an optional dev-only command you run ad hoc rather than a promised CI step.

## How agents should navigate

1. Read [Architecture](architecture.md) for pipelines and runtime/CLI contracts.
2. Read this page for import-graph and module-boundary rules.
3. Open the **public entry** of the package you need; treat it as the contract.
4. Open private implementations only at the point of change.
5. Assume CI structure checks are trustworthy: if `arch:check` / `lint` pass, the loaded interface set is sufficient for local reasoning.

## Consequences

- New code must land in the correct layer and behind the correct public entry.
- Moving a helper "up" a layer to fix a convenience import is a design smell. Move the helper down or widen the lower layer's public API instead.
- Fixing the remaining grandfathered ESLint hotspots (the four oversized / high-fan-out files with per-file overrides in `eslint.config.mjs`) is intentional follow-up work, not optional cleanup; the import-graph baseline is already empty (deep imports and the `runtime` → `cli` leak are fixed, not baselined).
- Analyzability and human maintainability are the same invariant measured with tools.

## Status

**Accepted** (2026-08-02). The import-graph rollout has landed in full. The dependency-cruiser gate (`npm run arch:check`) for no cycles and the layer DAG has landed and runs in CI. The ESLint fan-out and file-size caps (`npm run lint`) have also landed and run in CI; most former violators were split into sibling modules and now pass the global caps, and only the four largest files keep a per-file override in `eslint.config.mjs`, each with a fresh justification. The `no-deep-imports-into-parse`, `no-deep-imports-into-transpile`, `no-deep-imports-into-runtime`, and `no-deep-imports-into-format` rules now guard the parse, transpile, runtime, and format public entries, and the `runtime` ↛ `cli` inversion is fixed (no production runtime file imports `src/cli/**`). CLI slice isolation (`no-cross-cli-slice-imports`) now bars the five peer CLI slices from importing each other's private trees while exempting `commands` as the composition root, and the former peer feature-composition edges are eliminated (the shared MCP-protocol engine and workflow-call executor moved into `src/cli/shared`), so zero such edges remain in the baseline. No deep-import work remains queued: every layer sits behind a public-entry gate and the dependency-cruiser known-violations baseline is empty. The only grandfathered items left are the four oversized / high-fan-out files carrying per-file ESLint overrides in `eslint.config.mjs`, whose splits are tracked follow-up work.
