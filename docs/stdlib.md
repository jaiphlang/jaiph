# Stdlib Reference

Jaiph-generated scripts source `jaiph_stdlib.sh` automatically.

## Functions

- `jaiph__version`
  - Prints current stdlib/compiler version string.
- `jaiph__die <message>`
  - Prints an error message to stderr and returns non-zero.
- `jaiph__prompt <text...>`
  - Sends prompt text to the configured agent command (`cursor-agent`).
- `jaiph__execute_readonly <function_name>`
  - Runs a function in a read-only mount namespace via `sudo unshare -m`.
  - Used by transpiled rule wrappers (`<rule> -> <rule>__impl`).

## Contract

- Function names prefixed with `jaiph__` are reserved for stdlib.
- Generated code may assume these functions exist in every module.
- Custom user code should avoid redefining stdlib symbols.

## Notes

- `jaiph__execute_readonly` currently assumes Linux tooling (`unshare`, mount remount support, `sudo`).
- If required tools are missing, stdlib returns an error with a clear message.
