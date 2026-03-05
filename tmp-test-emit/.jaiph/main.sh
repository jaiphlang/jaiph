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
source "$(dirname "${BASH_SOURCE[0]}")/implement_from_queue.sh"
source "$(dirname "${BASH_SOURCE[0]}")/docs_parity.sh"
source "$(dirname "${BASH_SOURCE[0]}")/git.sh"

.jaiph::main::workflow::default::impl() {
  set -eo pipefail
  set +u
  .jaiph::git::rule::is_clean
  .jaiph::implement_from_queue::workflow::default
  .jaiph::docs_parity::workflow::default
}

.jaiph::main::workflow::default() {
  jaiph::run_step .jaiph::main::workflow::default .jaiph::main::workflow::default::impl "$@"
}