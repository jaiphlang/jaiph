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

# E2E fixture: workflow used by workflow_greeting.test.jh (Given/When/Then with mocked prompt).
e2e::workflow_greeting::workflow::default::impl() {
  set -eo pipefail
  set +u
  jaiph::prompt "$@" <<__JAIPH_PROMPT_4__
e2e-greeting-prompt
__JAIPH_PROMPT_4__
  echo "done"
}

e2e::workflow_greeting::workflow::default() {
  jaiph::run_step e2e::workflow_greeting::workflow::default e2e::workflow_greeting::workflow::default::impl "$@"
}