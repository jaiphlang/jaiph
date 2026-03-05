#!/usr/bin/env bash

set -euo pipefail
jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"
if [[ ! -f "$jaiph_stdlib_path" ]]; then
  echo "jai: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2
  exit 1
fi
source "$jaiph_stdlib_path"
if [[ "$(jaiph__runtime_api)" != "1" ]]; then
  echo "jai: incompatible jaiph stdlib runtime (required api=1)" >&2
  exit 1
fi
source "$(dirname "${BASH_SOURCE[0]}")/bootstrap_project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/tools/security.sh"

# Validates local build prerequisites.
test::fixtures::main::rule::project_ready::impl() {
  set -eo pipefail
  set +u
  test -f "package.json"
  test -n "$NODE_ENV"
}

test::fixtures::main::rule::project_ready() {
  jaiph::run_step test::fixtures::main::rule::project_ready jaiph::execute_readonly test::fixtures::main::rule::project_ready::impl "$@"
}

# Verifies the project compiles successfully.
test::fixtures::main::rule::build_passes::impl() {
  set -eo pipefail
  set +u
  npm run build
}

test::fixtures::main::rule::build_passes() {
  jaiph::run_step test::fixtures::main::rule::build_passes jaiph::execute_readonly test::fixtures::main::rule::build_passes::impl "$@"
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
test::fixtures::main::workflow::default::impl() {
  set -eo pipefail
  set +u
  if ! test::fixtures::main::rule::project_ready; then
    test::fixtures::bootstrap_project::workflow::nodejs
  fi
  jaiph::prompt "$@" <<__JAIPH_PROMPT_25__

    Build the application using best practices.
    Follow requirements: $1
  
__JAIPH_PROMPT_25__
  test::fixtures::main::rule::build_passes
  test::fixtures::tools::security::rule::scan_passes
  test::fixtures::main::workflow::update_docs
}

test::fixtures::main::workflow::default() {
  jaiph::run_step test::fixtures::main::workflow::default test::fixtures::main::workflow::default::impl "$@"
}

# Refreshes documentation after a successful build.
test::fixtures::main::workflow::update_docs::impl() {
  set -eo pipefail
  set +u
  jaiph::prompt "$@" <<__JAIPH_PROMPT_38__
Update docs
__JAIPH_PROMPT_38__
}

test::fixtures::main::workflow::update_docs() {
  jaiph::run_step test::fixtures::main::workflow::update_docs test::fixtures::main::workflow::update_docs::impl "$@"
}