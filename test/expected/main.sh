set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/bootstrap_project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/tools/security.sh"

# Validates local build prerequisites.
main__rule_project_ready__impl() {
  test -f "package.json"
  test -n "$NODE_ENV"
}

main__rule_project_ready() {
  jaiph__run_step main__rule_project_ready jaiph__execute_readonly main__rule_project_ready__impl
}

# Verifies the project compiles successfully.
main__rule_build_passes__impl() {
  npm run build
}

main__rule_build_passes() {
  jaiph__run_step main__rule_build_passes jaiph__execute_readonly main__rule_build_passes__impl
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
main__workflow_default__impl() {
  if ! main__rule_project_ready; then
    bootstrap_project__workflow_nodejs
  fi
  jaiph__prompt "
    Build the application using best practices.
    Follow requirements: $1
  "
  main__rule_build_passes
  tools__security__rule_scan_passes
  main__workflow_update_docs
}

main__workflow_default() {
  jaiph__run_step main__workflow_default main__workflow_default__impl "$@"
}

# Refreshes documentation after a successful build.
main__workflow_update_docs__impl() {
  jaiph__prompt "Update docs"
}

main__workflow_update_docs() {
  jaiph__run_step main__workflow_update_docs main__workflow_update_docs__impl "$@"
}