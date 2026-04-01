# Compiler test fixtures (txtar format)

Language-agnostic compiler tests for parse and validate outcomes.
Each `.txt` file in this directory contains multiple test cases in txtar format.

## Format

```
=== test name here
# @expect ok
--- input.jh
workflow default() {
  log "hello"
}

=== another test
# @expect error E_PARSE "unterminated workflow block"
--- input.jh
workflow default() {
  log "hello"
```

### Delimiters

- `=== <name>` — starts a new test case. Everything until the next `===` (or EOF) belongs to this case.
- `--- <filename>` — starts a virtual file within the test case. The filename must end in `.jh`.
- `# @expect <directive>` — declares the expected outcome (must appear before the first `---` marker).

### Expect directives

| Directive | Meaning |
|-----------|---------|
| `# @expect ok` | Parse + validate succeed with no errors |
| `# @expect error E_CODE "substring"` | An error is thrown whose message contains both `E_CODE` and `substring` |
| `# @expect error E_CODE "substring" @L` | Same, and the error must be reported at line `L` (any column) |
| `# @expect error E_CODE "substring" @L:C` | Same, and the error must be reported at line `L`, column `C` |

### Single-file vs multi-file tests

- **Single-file:** use `--- input.jh` as the filename. The runner compiles `input.jh`.
- **Multi-file:** use `--- main.jh` as the entry file plus additional `--- lib.jh` etc. The runner compiles `main.jh`.

The entry file is determined by priority: `main.jh` if present, otherwise `input.jh`.

### Conventions

- One `.txt` file per category (e.g., `valid.txt`, `parse-errors.txt`, `validate-errors.txt`).
- Test names should be descriptive and unique within a file.
- Keep test cases minimal — only include what is necessary to trigger the expected outcome.
