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

e2e::say_hello::rule::name_was_provided::impl() {
  set -eo pipefail
  set +u
  if [ -z "$1" ]; then
  echo "You didn't provide your name :(" >&2
  exit 1
  fi
}

e2e::say_hello::rule::name_was_provided() {
  jaiph::run_step e2e::say_hello::rule::name_was_provided jaiph::execute_readonly e2e::say_hello::rule::name_was_provided::impl "$@"
}

e2e::say_hello::function::format_text::impl() {
  set -eo pipefail
  set +u
  fold -s -w 80
}

e2e::say_hello::function::format_text() {
  jaiph::run_step_passthrough e2e::say_hello::function::format_text e2e::say_hello::function::format_text::impl "$@"
}

format_text() {
  e2e::say_hello::function::format_text "$@"
}

e2e::say_hello::workflow::default::impl() {
  set -eo pipefail
  set +u
  e2e::say_hello::rule::name_was_provided "$1"
  response=$(jaiph::prompt_capture "$@" <<__JAIPH_PROMPT_17__

    Say hello to $1 and provide a fun fact about a person with the same name.
  
__JAIPH_PROMPT_17__
)
  echo "$response" | format_text > "hello.txt"
}

e2e::say_hello::workflow::default() {
  jaiph::run_step e2e::say_hello::workflow::default e2e::say_hello::workflow::default::impl "$@"
}