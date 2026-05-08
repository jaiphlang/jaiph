set -euo pipefail
export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/scripts" && pwd)}"
source "$(dirname "${BASH_SOURCE[0]}")/bootstrap_project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/tools/security.sh"

# Validates local build prerequisites.
main::project_ready::impl() {
  test -f "package.json"
  test -n "$NODE_ENV"
}

main::project_ready() {
  jaiph::run_step main::project_ready rule jaiph::execute_readonly main::project_ready::impl
}

# Verifies the project compiles successfully.
main::build_passes::impl() {
  npm run build
}

main::build_passes() {
  jaiph::run_step main::build_passes rule jaiph::execute_readonly main::build_passes::impl
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
main::default::impl() {
  if ! main::project_ready; then
    bootstrap_project::nodejs
  fi
  jaiph::prompt "
    Build the application using best practices.
    Follow requirements: $1
  "
  main::build_passes
  tools::security::scan_passes
  main::update_docs
}

main::default() {
  jaiph::run_step main::default workflow main::default::impl "$@"
}

# Refreshes documentation after a successful build.
main::update_docs::impl() {
  jaiph::prompt "Update docs"
}

main::update_docs() {
  jaiph::run_step main::update_docs workflow main::update_docs::impl "$@"
}
