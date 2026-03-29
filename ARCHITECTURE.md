# Jaiph Architecture

This document describes how Jaiph is structured and how execution flows through the system for both:

- regular workflows (`*.jh`),
- Jaiph runtime tests (`*.test.jh`).

## System overview

Jaiph is a workflow system with a **TypeScript CLI**. The default orchestration path uses a **Node.js kernel** that interprets the AST directly:

1. Parse source into AST (quick parse on the CLI for `jaiph run` metadata; full graph loads use the same parser).
2. **Compile-time** validation (`validateReferences` inside `transpileFile`) runs during **`buildScripts()` / `build()`**, not inside `buildRuntimeGraph()` (the graph loader only parses modules and follows imports).
3. **CLI** (Node from `dist/src/cli.js`, or a **Bun-compiled** `jaiph` binary) prepares script executables (scripts-only for normal `run`/`test`), spawns the **`node-workflow-runner`** child (non-Docker), **which** builds `RuntimeGraph` and runs **`NodeWorkflowRuntime`**. Script steps execute as managed subprocesses; prompt, inbox I/O, and event/summary emission are handled by the JS kernel under `src/runtime/kernel/`.
4. Stream live events to CLI and persist durable run artifacts.

**Default** local `jaiph run` and all `jaiph test` orchestration use the **Node workflow runtime** (AST interpreter). **`jaiph run` with Docker enabled** is a compatibility path: the CLI emits a full module `.sh` and the container runs that shell entrypoint instead of `node-workflow-runner`.

## Core components

- **CLI (`src/cli`)**
  - Entry point (`run`, `test`, `init`, `use`, `report`).
  - **Workflow launch** is owned in TypeScript (`src/runtime/kernel/workflow-launch.ts` + `src/cli/run/lifecycle.ts`): spawns the **Node workflow runner** (`node-workflow-runner.ts`), which calls `buildRuntimeGraph()` then `NodeWorkflowRuntime`.
  - Parses runtime events and renders progress; dispatches hooks.

- **Parser (`src/parser.ts`, `src/parse/*`)**
  - Converts `.jh`/`.test.jh` into `jaiphModule` AST.

- **AST / Types (`src/types.ts`)**
  - Shared compile-time schema (`jaiphModule`, step defs, test defs, hook payload types).

- **Validator (`src/transpile/validate.ts`)**
  - Resolves imports and symbol references; emits deterministic compile-time errors.

- **Transpiler (`src/transpiler.ts`, `src/transpile/*`)**
  - `transpileFile()` still emits module `.sh` + per-step source map entries and extracted script files.
  - `buildScripts()` is the default runtime preparation path for `jaiph run` / `jaiph test` (scripts-only output, no module `.sh` emission).
  - Full `build()` output (module `.sh` + scripts) remains for internal compatibility flows (not user-facing as a CLI subcommand).

- **Node Workflow Runtime (`src/runtime/kernel/node-workflow-runtime.ts`)**
  - `NodeWorkflowRuntime` interprets the AST directly: walks workflow steps, manages scope/variables, delegates prompt and script execution to kernel helpers, handles channels/inbox/dispatch, emits events, and writes run artifacts.
  - `buildRuntimeGraph()` (`graph.ts`) loads reachable modules with **`parsejaiph` only** (import closure); it does **not** run `validateReferences`. Cross-module refs are resolved from that graph at runtime.

- **Node Test Runner (`src/runtime/kernel/node-test-runner.ts`)**
  - Executes `*.test.jh` test blocks using `NodeWorkflowRuntime` with mock support (mock prompts, mock workflow/rule/script bodies). Pure Node harness — no Bash test transpilation.

- **JS kernel (`src/runtime/kernel/`)**
  - Prompt execution (`prompt.ts`), managed subprocess execution, streaming parse, schema, mocks, **`emit.ts`** (live `__JAIPH_EVENT__` + `run_summary.jsonl`), **`inbox.ts`** (file-backed inbox), **`workflow-launch.ts`** (spawn contract).

- **Runtime shell stdlib (`src/jaiph_stdlib.sh`)**
  - Legacy/compatibility shell runtime library used when executing generated module `.sh` artifacts (for example docker compatibility flows and legacy tests). Not on the default Node orchestration path for `jaiph run` / `jaiph test`.

- **Reporting (`src/reporting/*`)**
  - Reads `.jaiph/runs` and `run_summary.jsonl`; `jaiph report` serves the local UI. Standalone binaries resolve static assets from `reporting/public` next to the executable when bundled.

## Runtime vs CLI responsibilities

### Runtime responsibilities (Node workflow runtime)

- Interpret the AST and execute workflow semantics directly (`NodeWorkflowRuntime`).
- Manage channels (`send`, routes, queue drain) through kernel logic.
- Emit step/log events; persist run logs and summary timeline.
- Prompt steps and managed script subprocesses: Node kernel owns execution, events, and control flow.
- Execute test blocks with mock support (`NodeTestRunner`).

### CLI responsibilities

- Parse, validate, and launch workflows/tests.
- Own **process spawn** for `jaiph run` (detached workflow runner process group for signal propagation).
- Parse live runtime events; render terminal progress; trigger hooks.

## Contracts

- **Live contract (runtime -> CLI):** `__JAIPH_EVENT__` JSON lines on **stderr** by default; **`jaiph run` in Docker** also scans container **stdout** for the same event shapes (see `src/cli/commands/run.ts`).
- **Durable contract:** `.jaiph/runs/...` + `run_summary.jsonl`.

Channel transport remains file/queue based in runtime inbox logic.

## Channels and hooks in context

(Unchanged semantics; see previous docs.) Channels are AST → validated → executed via queue/dispatch in the Node runtime. Hooks load from `hooks.json` and run as shell commands with JSON on stdin.

## Jaiph runtime testing (`*.test.jh`)

`*.test.jh` files are parsed in the CLI; `runTestFile()` drives blocks in-process. Each **`test_run_workflow`** step **`buildRuntimeGraph(testFile)`**, resolves mocks against that graph, then constructs `NodeWorkflowRuntime` with `mockBodies` / mock prompt env. Mock prompts, workflows, rules, and functions are supported through the runtime's mock infrastructure.
Before that, the CLI prepares script executables via **`buildScripts(workspace)`** so imported workflow modules have concrete script paths under `JAIPH_SCRIPTS` (workspace `*.jh` files only; `*.test.jh` is not part of that walk).

## CLI progress reporting pipeline

Static tree from AST (`progress.ts`); runtime events (`events.ts`, `stderr-handler.ts`); emitter (`emitter.ts`); display (`display.ts`, `progress.ts`).

## Distribution: Node vs Bun standalone

- **Development / npm:** `npm run build` → `tsc` + copy `runtime/kernel/` and `reporting/public` into `dist/`. `node dist/src/cli.js` runs the CLI.
- **Standalone:** `npm run build:standalone` produces `dist/jaiph` (Bun `--compile`) and copies **`runtime/kernel/`** and **`reporting/public`** into **`dist/`** next to the binary. Reporting asset resolution falls back to `dirname(process.execPath)` so the bundle runs **without a Node.js install**. Target machines still need **bash** (or another interpreter) for `script` step subprocess execution and **Node.js** for the runtime kernel.

## Mermaid architecture diagram

```mermaid
flowchart TD
    U[User / CI] --> CLI[CLI: Node or Bun jaiph]

    subgraph Transpile["Per-module transpile: transpileFile()"]
        PARSE[parsejaiph]
        VAL[validateReferences]
        EMIT[Emit script files and optional workflow .sh]
        PARSE --> VAL
        VAL -->|compile errors| ERR[Deterministic compile errors]
        VAL --> EMIT
    end

    CLI -->|jaiph run| BS1[buildScripts or full build when Docker]
    BS1 --> Transpile

    CLI -->|jaiph test| BS2[buildScripts workspace]
    BS2 --> Transpile
    BS2 --> TR[Node Test Runner in-process]

    Transpile -->|default jaiph run| RW[Node workflow runner child]
    Transpile -->|Docker jaiph run| DC[Container runs generated module .sh + stdlib]

    RW --> G[buildRuntimeGraph parse-only + imports]
    G --> GRAPH[RuntimeGraph]
    RW --> RT[NodeWorkflowRuntime]
    RT --> GRAPH

    TR -->|test_run_workflow| G
    TR --> RT

    RT -->|script steps| SCRIPT[Managed script subprocesses]
    RT -->|prompt steps| KERNEL[JS kernel: prompt / emit / inbox / stream / schema / mock]

    RT -->|live events| EV["__JAIPH_EVENT__ stderr or stdout in Docker"]
    DC -->|bridged streams| EV
    EV --> CLI
    CLI --> PR[Progress rendering]

    RT -->|channels files / queues| INBOX[Inbox under .jaiph/runs]
    RT -->|durable artifacts| SUM[.jaiph/runs + run_summary.jsonl]
    SUM --> REP[Reporting server / UI]

    CLI --> HK[Hook dispatcher via event stream]
    HK --> HPROC[Hook shell commands]
```

## Sequence diagram: regular flow (`*.jh`)

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI jaiph run
    participant Prep as buildScripts or build
    participant TF as transpileFile per module
    participant Runner as node-workflow-runner
    participant Graph as buildRuntimeGraph
    participant Runtime as NodeWorkflowRuntime
    participant Kernel as JS kernel
    participant Report as Artifacts (.jaiph/runs)

    User->>CLI: jaiph run main.jh args...
    Note over CLI: parse once for metadata config only
    CLI->>Prep: buildScripts(input) or build() if Docker
    Prep->>TF: loop: parse + validateReferences + emit
    TF-->>Prep: scripts/ and optional module .sh
    Prep-->>CLI: output dir paths + env JAIPH_SCRIPTS
    alt default non-Docker
        CLI->>Runner: spawn detached node-workflow-runner
        Runner->>Graph: buildRuntimeGraph(sourceAbs) parse-only
        Graph-->>Runner: RuntimeGraph
        Runner->>Runtime: runDefault(run args)
        Runtime->>Kernel: prompt / managed scripts / emit / inbox
        Runtime-->>CLI: __JAIPH_EVENT__ on stderr
        Runtime->>Report: run_summary.jsonl + step artifacts
        Runner-->>CLI: exit + meta file with run_dir paths
    else Docker
        CLI->>CLI: spawn container with generated module .sh entrypoint
        Note over CLI: bash orchestration in container CLI parses events on stderr and stdout
    end
    CLI-->>User: live progress
    CLI-->>User: PASS/FAIL
```

## Sequence diagram: test flow (`*.test.jh`)

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI jaiph test
    participant Parser as parsejaiph
    participant Prep as buildScripts workspace
    participant TestRunner as runTestFile / runTestBlock
    participant Graph as buildRuntimeGraph
    participant Runtime as NodeWorkflowRuntime
    participant Report as Artifacts

    User->>CLI: jaiph test flow.test.jh
    CLI->>Parser: parse test file
    Parser-->>CLI: jaiphModule + tests[] blocks
    CLI->>Prep: buildScripts(workspace) workspace .jh only
    Prep-->>CLI: scriptsDir
    CLI->>TestRunner: runTestFile(test path workspace scriptsDir blocks)
    loop each test block
        TestRunner->>TestRunner: mocks / shell steps / expectations
        opt test_run_workflow step
            TestRunner->>Graph: buildRuntimeGraph(test file) parse-only
            Graph-->>TestRunner: RuntimeGraph
            TestRunner->>Runtime: new runtime mockBodies from block
            Runtime->>Runtime: runNamedWorkflow(ref args)
            Runtime-->>TestRunner: status output returnValue error
        end
    end
    Runtime->>Report: artifacts when workflows ran
    TestRunner-->>CLI: aggregate PASS/FAIL
    CLI-->>User: exit code
```

## TypeScript test organization

(Module tests in `src/**`, cross-cutting in `test/**`, e2e in `e2e/tests/*.sh` — unchanged.)

## Summary

- `.jh` / `*.test.jh` share parser/AST; **compile-time** validation runs in `transpileFile` during **`buildScripts` / `build`**. **`buildRuntimeGraph`** loads modules with **parse-only** imports.
- **Default Node runtime:** local `jaiph run` (non-Docker) and `jaiph test` execute through `NodeWorkflowRuntime`. Docker `jaiph run` executes the generated bash module inside the container.
- **CLI** owns launch, observation, hooks, and runtime preparation (`buildScripts` or full `build`). **Default** workflow execution runs in **`NodeWorkflowRuntime`**, with **script steps** as managed subprocesses.
- User-facing CLI no longer exposes a `build` subcommand; full `.sh` emission remains an internal compatibility path only.
- Contracts: `__JAIPH_EVENT__`, `.jaiph/runs`, `run_summary.jsonl`, hook payloads.
