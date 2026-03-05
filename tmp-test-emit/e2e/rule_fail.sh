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

# E2E fixture: rule that runs mock_fail (deterministic fail).
e2e::rule_fail::rule::check_fails::impl() {
  set -eo pipefail
  set +u
  mock_fail
}

e2e::rule_fail::rule::check_fails() {
  jaiph::run_step e2e::rule_fail::rule::check_fails jaiph::execute_readonly e2e::rule_fail::rule::check_fails::impl "$@"
}

e2e::rule_fail::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::rule_fail::rule::check_fails
  echo "unreachable"
}

e2e::rule_fail::workflow::default() {
  jaiph::run_step e2e::rule_fail::workflow::default e2e::rule_fail::workflow::default::impl "$@"
}