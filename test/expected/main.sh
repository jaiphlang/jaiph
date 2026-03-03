set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/bootstrap_project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/tools/security.sh"

# Validates local build prerequisites.
main::rule::project_ready::impl() {
  test -f "package.json"
  test -n "$NODE_ENV"
}

main::rule::project_ready() {
  jaiph::run_step main::rule::project_ready jaiph::execute_readonly main::rule::project_ready::impl
}

# Verifies the project compiles successfully.
main::rule::build_passes::impl() {
  npm run build
}

main::rule::build_passes() {
  jaiph::run_step main::rule::build_passes jaiph::execute_readonly main::rule::build_passes::impl
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
main::workflow::default::impl() {
  if ! main::rule::project_ready; then
    bootstrap_project::workflow::nodejs
  fi
  jaiph::prompt "
    Build the application using best practices.
    Follow requirements: $1
  "
  main::rule::build_passes
  tools::security::rule::scan_passes
  main::workflow::update_docs
}

main::workflow::default() {
  jaiph::run_step main::workflow::default main::workflow::default::impl "$@"
}

# Refreshes documentation after a successful build.
main::workflow::update_docs::impl() {
  jaiph::prompt "Update docs"
}

main::workflow::update_docs() {
  jaiph::run_step main::workflow::update_docs main::workflow::update_docs::impl "$@"
}
