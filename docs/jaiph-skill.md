---
name: write-jaiph-programs
description: Writes and modifies Jaiph programs that orchestrate native control flow, scripts in multiple languages, and AI prompts. Use when creating, editing, debugging, or testing .jh and .test.jh files.
title: Agent Skill
permalink: /jaiph-skill
diataxis: contributor
redirect_from:
  - /jaiph-skill.md
---

# Write Jaiph programs

Use this checklist when creating or changing Jaiph programs. Jaiph is the orchestration layer: keep workflow control in Jaiph, deterministic implementation in scripts, and judgment-driven work in prompts. This skill is not a language reference. Exact syntax lives at [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar); semantics live at [https://jaiph.org/reference/language](https://jaiph.org/reference/language). When this page and the compiler disagree, the compiler wins.

## Design the workflow first

Classify every operation before writing code:

| Need | Use |
|---|---|
| Composition, branching, loops, concurrency, recovery, or data flow | Native Jaiph in a `def` |
| Deterministic computation, filesystem/process access, or an existing CLI/library | `script` in Bash, Python, Node, or another interpreter |
| Work requiring model judgment or generation | `prompt`; capture the result with `const` when another step needs it |
| Decoupled message dispatch | `channel` and `send` |

Do not hide orchestration in a large shell or Python script. Do not use a prompt for work that a deterministic script can perform. Reuse imported modules and nearby definitions before adding another implementation. Prefer small named `def`, `script`, and named `prompt` units when logic is reused.

Native orchestration includes `if`, `match`, `for`, `async`, `stdin` pipelines, `catch`, `recover`, `return`, logging, and failure. Read [Language](https://jaiph.org/reference/language) before recreating any of these inside a script.

Scripts and tool-capable prompts run as the user who launched Jaiph; Jaiph is not a process sandbox. Use a container, pod, CI runner, or dedicated user when isolation is required. See [Deploy Jaiph](https://jaiph.org/how-to/deploy).

## Working polyglot example

```jaiph
script extension_counts = '''python3
  import collections
  import pathlib
  import sys

  root = pathlib.Path(sys.argv[1])
  counts = collections.Counter(
      path.suffix or "<none>" for path in root.rglob("*") if path.is_file()
  )
  for suffix, count in sorted(counts.items()):
      print(f"{suffix}: {count}")
'''

script write_report = '''node
  const fs = require("fs");
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    fs.writeFileSync(process.argv[2], Buffer.concat(chunks));
  });
'''

export def main(root, output) {
  const counts = extension_counts(root)
  const report = prompt """
    Explain this source-tree composition and identify likely maintenance risks:
    ${counts}
  """
  stdin "${report}" -> write_report(output)
  return report
}
```

This keeps sequencing and data flow in Jaiph, deterministic inspection in Python, model judgment in a prompt, and file writing in Node. `const report = prompt …` intentionally materializes the result because the workflow both writes and returns it. The following `stdin "${report}"` passes that already-materialized string safely to Node; it does not turn the string back into an output handle. For script fences, argv, prompt capture, and `stdin`, use [Language](https://jaiph.org/reference/language).

## Choose materialization boundaries intentionally

A call result is an output handle until a force site materializes it. `const`, interpolation, comparisons, and call arguments force handles; `stdin producer() -> consumer()` and a prompt whose entire body is a handle can stream. Passing an already-materialized string through `stdin` avoids argv limits but does not restore streaming. For large or arbitrary data, preserve the handle when possible and connect the producer directly. See [Value types](https://jaiph.org/reference/language#value-types) and [Arguments and stdin](https://jaiph.org/reference/language#arguments-and-stdin).

## Your authoring loop

1. Inspect nearby `.jh` and `*.test.jh` files for reusable imports, defs, scripts, prompts, and project conventions.
2. Classify each operation using the table above; make inputs, outputs, and failure paths explicit.
3. Write the smallest coherent change. Read the owner page instead of guessing syntax.
4. Format: `jaiph format <file…>`.
5. Compile: `jaiph compile <file-or-dir>`. Fix every reported diagnostic.
6. Add or update `*.test.jh` coverage. Mock every prompt, then run `jaiph test <file-or-dir>`.
7. Run `jaiph run <file.jh> [args…]` for an end-to-end check when its external effects and agent calls are intended.

Do not claim completion until formatting, compilation, and relevant tests pass. The full command surface and flags live at [CLI](https://jaiph.org/reference/cli).

## Authoring mistakes to check for

This skill is published independently of the Jaiph repository. Open the absolute owner URL; do not resolve a relative path.

- Missing `()` on a definition or call site — see [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar).
- Capturing without `const`, or rebinding an immutable name — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- `$name`, `$(…)`, or `${var:-default}` in an orchestration string instead of a script body — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Interpolating a prompt result into shell code instead of passing it through argv or `stdin` — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Not forwarding a parameter to a called def (`impl(task)`, not `impl()`) — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Requesting a host env key without a `use` clause plus a matching `--env` grant — see [https://jaiph.org/reference/env-vars](https://jaiph.org/reference/env-vars).
- Leaving any prompt path unmocked in a `*.test.jh` file — see [https://jaiph.org/how-to/testing](https://jaiph.org/how-to/testing).

## Related

- [https://jaiph.org/reference/language](https://jaiph.org/reference/language) — what every construct means.
- [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar) — the exact syntax and EBNF.
- [https://jaiph.org/reference/cli](https://jaiph.org/reference/cli) — commands, flags, and invocation.
- [https://jaiph.org/reference/configuration](https://jaiph.org/reference/configuration) — config keys and precedence.
- [https://jaiph.org/how-to/testing](https://jaiph.org/how-to/testing) — write and run `*.test.jh` tests.
