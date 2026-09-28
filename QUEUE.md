# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Add a builtin module record #dev-ready

A def can read the `.jh` file it is running in. The name is `module`. It has five string fields. This is the same kind of value as a prompt result with a `returns` schema: the compiler knows the fields, and a bad field name fails at compile time. It is not JSON in the program, and it is not a struct the user declares.

```jaiph
export def main() {
  const manifest = "${module.dir}/sources.json"
  log module.file
}
```

### Fields

| Field | Value |
|---|---|
| `module.file` | Absolute path of the `.jh` file that contains the def now running. |
| `module.dir` | Directory of that file. No trailing slash. `"${module.dir}/sources.json"` must join correctly. |
| `module.name` | The `module.name` string from that file's module-level `config`, or `""` when unset. |
| `module.version` | Same, for `module.version`. |
| `module.description` | Same, for `module.description`. |

The value follows the file, not the process. `main` in `flow.jh` sees `flow.jh`. A def in an imported `lib.jh` sees `lib.jh`, even when `flow.jh` called it. A nested def sees the file it was written in. Use the absolute path already stored on the module graph for that file. Do not `realpath` it. Do not use the workspace root, `process.cwd()`, or the entry file.

`module.name`, `module.version`, and `module.description` are already module-level config keys (`src/parse/metadata.ts`, `DefMetadata.module` in `src/types.ts`). Read the resolved values for the callee's file. Def-level `config` cannot set `module.*` today (`E_PARSE`). Leave that rule as it is. An unset field is `""`, not an error.

### Syntax

`module.dir` and `${module.dir}` already parse. Bare `IDENT.IDENT` is typed-prompt field access (`isBareDottedIdentifier` in `src/parse/core.ts`). A call argument `module.dir` is stored as `{ kind: "var", name: "module.dir" }` and becomes `${module.dir}` via `argsToRuntimeString`. Do not add a new expression kind.

`module` with no field is not a value. These are parse errors, same as any reserved keyword:

- a parameter: `def f(module)`
- a binding name: `const`, `def`, `script`, `prompt`, `channel`, import alias, including nested ones

`JAIPH_KEYWORDS` in `src/parse/core.ts` is what rejects parameter names. It does not by itself reject `const module` or `def module`. Reject the name at every binding site. Do not add a row to the `STATEMENT` table in `src/parse/workflow-brace.ts`. `module` is not a statement. A body line that is only `module.dir` stays "not a statement".

`config { module.name = "..." }` must keep parsing. Those keys are matched against `ALLOWED_KEYS` in `src/parse/metadata.ts`. Do not run them through `isBareIdentifier`.

### Compiler

`validateDotFieldRef` in `src/transpile/validate-step-helpers.ts` allows a dot only when the base is a typed prompt capture. Treat `module` as a builtin with the five fields above, checked the same way.

- `module.dir` and `${module.dir}` pass in strings, `return`, `if` / `match` subjects, and call arguments.
- `module.bogus` is `E_VALIDATE` and the message lists the five fields.
- This applies in every module, including an imported one.

Do not implement this by putting a JSON string in a variable named `module`. `${var.field}` on a prompt capture parses JSON and turns a missing field into `""` (`interpolate` in `src/config.ts`, `resolveSubjectValue` in `src/runtime/kernel/node-workflow-runtime.ts`). `module` must not take that path.

### Runtime

Resolve `module.<field>` from the scope of the def that is running. A call to a def in another file already sets `scope.filePath` to that file (`resolved.filePath` on the def-call path in `src/runtime/kernel/node-workflow-runtime.ts`).

`interpolate` does not know the current file. Do not make it call `process.cwd()` or read `process.env`. Pass the lookup in from the runtime, which has `scope.filePath`. Use that lookup in both places that currently JSON-parse a dotted name:

- `interpolate` in `src/config.ts`, for `${module.dir}` in strings, logs, and call arguments
- `resolveSubjectValue` in `src/runtime/kernel/node-workflow-runtime.ts`, for `if module.dir == "..."` and `match`

When the base is `module`, do not read `scope.vars` and do not fall through to `scope.env`. An environment variable named `module` must not affect the result. An unknown field at runtime fails the step. It does not become `""`. The compiler already rejects that field; the runtime check is there so a skipped validation cannot return an empty path.

### Docs

- `docs/language.md` — what `module` is, the five fields, and that each file sees itself.
- `docs/grammar.md` — add `module` to the reserved-keyword list.
- `docs/configuration.md` — `module.name`, `module.version`, and `module.description` are readable as `module.name`, `module.version`, and `module.description`. They stay module-level config only.

### Out of scope

- No user-declared structs, and no lists of records.
- No change to how a prompt `returns` schema is stored or validated.
- No `process.env` reader and no optional `use`.
- Do not inject these fields into a script subprocess. A script does not see Jaiph names. The def passes `module.dir` as an argument.
- Do not add workspace, cwd, or the entry-file path as `module` fields.

### Acceptance criteria

Each bullet needs a test that fails when the behavior is wrong.

- `def f(module)` is `E_PARSE` (`parameter name "module" is a reserved keyword`). `const module = "x"`, `def module()`, `script module`, and `import "./a.jh" as module` are `E_PARSE` too.
- `config { module.name = "proj" }` still parses, and `module.name` inside a def-level `config` is still `E_PARSE`.
- `${module.dir}`, bare `module.dir` as a call argument, and `return module.file` compile. `module.bogus` is `E_VALIDATE` and names the legal fields.
- Runtime, two files on disk, harness style of the cross-module test in `src/runtime/kernel/node-workflow-runtime.script-env.test.ts`. Entry `flow.jh` returns its own `module.dir` and the return value of an exported def in `lib.jh`. Read `return_value.txt` (see `src/runtime/kernel/node-workflow-runtime.artifacts.test.ts`). The two directories differ. Each is the directory of that `.jh` file, not the temp workspace root when the files live in subdirectories.
- The same run returns `module.file` for the entry file as that file's absolute path.
- `lib.jh` with `config { module.name = "lib" module.version = "1" module.description = "d" }` returns those three strings from its own def. A file with no `module.*` config returns `""` for each.
- `if` / `match` on `module.dir` sees that directory, not `""`.
- A script step's environment does not grow a `module` variable. Existing sterile-env coverage stays green.
- `jaiph compile` and `jaiph test` pass for the touched tests. Update `docs/grammar.md`, `docs/language.md`, and `docs/configuration.md` in the same change. If a compiler txtar fixture gains a new diagnostic, refresh that snapshot the way `docs/contributing.md` describes.
