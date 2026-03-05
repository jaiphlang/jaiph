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

e2e::current_branch::rule::current_branch::impl() {
  set -eo pipefail
  set +u
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
  fi
  if [ "$(git branch --show-current)" != "$1" ]; then
  echo "Current branch is not '$1'." >&2
  exit 1
  fi
}

e2e::current_branch::rule::current_branch() {
  jaiph::run_step e2e::current_branch::rule::current_branch jaiph::execute_readonly e2e::current_branch::rule::current_branch::impl "$@"
}

e2e::current_branch::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::current_branch::rule::current_branch "$1"
}

e2e::current_branch::workflow::default() {
  jaiph::run_step e2e::current_branch::workflow::default e2e::current_branch::workflow::default::impl "$@"
}