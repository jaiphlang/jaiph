# Examples

## Source (`main.jph`)

```jaiph
import "bootstrap_project.jph" as bootstrap
import "tools/security.jph" as security

rule project_ready {
  test -f "package.json"
  test -n "$NODE_ENV"
}

rule build_passes {
  npm run build
}

workflow main {
  if ! ensure project_ready; then
    run bootstrap.nodejs
  fi

  prompt "
    Build the application using best practices.
    Follow requirements: $1
  "

  ensure build_passes
  ensure security.scan_passes
  run update_docs
}

workflow update_docs {
  prompt "Update docs"
}
```

## Transpiled shape (`main.sh`)

```bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/bootstrap_project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/tools/security.sh"

main__rule_project_ready__impl() { ... }
main__rule_project_ready() { jaiph__execute_readonly main__rule_project_ready__impl; }
main__rule_build_passes__impl() { ... }
main__rule_build_passes() { jaiph__execute_readonly main__rule_build_passes__impl; }

main__workflow_main() {
  if ! main__rule_project_ready; then
    bootstrap_project__workflow_nodejs
  fi
  jaiph__prompt "..."
  main__rule_build_passes
  tools__security__rule_scan_passes
  main__workflow_update_docs
}
```

## Naming convention

- Rules: `<module_symbol>__rule_<rule_name>`
- Workflows: `<module_symbol>__workflow_<workflow_name>`
- Module symbol comes from relative file path with `/` converted to `__`.
