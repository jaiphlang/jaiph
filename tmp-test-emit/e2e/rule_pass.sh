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

# E2E fixture: rule that runs mock_ok (deterministic pass).
e2e::rule_pass::rule::check_passes::impl() {
  set -eo pipefail
  set +u
  mock_ok
}

e2e::rule_pass::rule::check_passes() {
  jaiph::run_step e2e::rule_pass::rule::check_passes jaiph::execute_readonly e2e::rule_pass::rule::check_passes::impl "$@"
}

e2e::rule_pass::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::rule_pass::rule::check_passes
  echo "e2e-rule-pass-done"
}

e2e::rule_pass::workflow::default() {
  jaiph::run_step e2e::rule_pass::workflow::default e2e::rule_pass::workflow::default::impl "$@"
}