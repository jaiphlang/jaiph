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

# E2E fixture: ensure pass then ensure fail; we only run the fail path in e2e.
e2e::ensure_fail::rule::step_ok::impl() {
  set -eo pipefail
  set +u
  mock_ok
}

e2e::ensure_fail::rule::step_ok() {
  jaiph::run_step e2e::ensure_fail::rule::step_ok jaiph::execute_readonly e2e::ensure_fail::rule::step_ok::impl "$@"
}

e2e::ensure_fail::rule::step_fail::impl() {
  set -eo pipefail
  set +u
  mock_fail
}

e2e::ensure_fail::rule::step_fail() {
  jaiph::run_step e2e::ensure_fail::rule::step_fail jaiph::execute_readonly e2e::ensure_fail::rule::step_fail::impl "$@"
}

e2e::ensure_fail::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::ensure_fail::rule::step_ok
  e2e::ensure_fail::rule::step_fail
}

e2e::ensure_fail::workflow::default() {
  jaiph::run_step e2e::ensure_fail::workflow::default e2e::ensure_fail::workflow::default::impl "$@"
}