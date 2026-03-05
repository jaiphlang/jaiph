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
source "$(dirname "${BASH_SOURCE[0]}")/nested_inner.sh"

e2e::nested_run::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::nested_inner::workflow::default
  echo "e2e-nested-outer"
}

e2e::nested_run::workflow::default() {
  jaiph::run_step e2e::nested_run::workflow::default e2e::nested_run::workflow::default::impl "$@"
}