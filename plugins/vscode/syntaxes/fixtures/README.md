# Syntax Fixture

Use `sample.jph` for manual highlighting checks in the Extension Development Host.

Checklist:

- Jaiph keywords are highlighted (`import`, `rule`, `workflow`, `ensure`, `run`, `prompt`, `if`, `then`, `fi`)
- `security.scan` is scoped as a qualified reference
- Strings and comments are highlighted
- Shell commands inside blocks (`test`, `npm run build`) get shell-like tokenization
