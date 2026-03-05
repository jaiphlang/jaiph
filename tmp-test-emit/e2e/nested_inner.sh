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

# E2E fixture: nested workflow via run.
e2e::nested_inner::workflow::default::impl() {
  set -eo pipefail
  set +u
  echo "e2e-nested-inner"
}

e2e::nested_inner::workflow::default() {
  jaiph::run_step e2e::nested_inner::workflow::default e2e::nested_inner::workflow::default::impl "$@"
}