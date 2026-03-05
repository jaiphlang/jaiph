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

test::fixtures::bootstrap_project::workflow::nodejs::impl() {
  set -eo pipefail
  set +u
  echo "Sorry, I cannot setup nodejs yet"
  exit 1
}

test::fixtures::bootstrap_project::workflow::nodejs() {
  jaiph::run_step test::fixtures::bootstrap_project::workflow::nodejs test::fixtures::bootstrap_project::workflow::nodejs::impl "$@"
}