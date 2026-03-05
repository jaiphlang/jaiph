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
source "$(dirname "${BASH_SOURCE[0]}")/say_hello.sh"

jaiph__test_display_name="${JAIPH_TEST_FILE:-$(basename "${BASH_SOURCE[0]}" .test.sh).test.jh}"

jaiph__test_descs=(
  'without name, rule fails with validation message'
  'with name, returns greeting and writes hello.txt'
)

jaiph__test_0() {
  jaiph__test_name='without name, rule fails with validation message'
  unset JAIPH_MOCK_SCRIPTS_DIR
  jaiph__mock_file=$(mktemp)
  trap 'rm -f "$jaiph__mock_file"' RETURN
  unset JAIPH_MOCK_DISPATCH_SCRIPT
  export JAIPH_MOCK_RESPONSES_FILE="$jaiph__mock_file"
  set +e
  response=$(e2e::say_hello::workflow::default  2>&1)
  jaiph__test_exit=$?
  set -e
  jaiph__expect_contain "$response" '"status":1'
}

jaiph__test_1() {
  jaiph__test_name='with name, returns greeting and writes hello.txt'
  unset JAIPH_MOCK_SCRIPTS_DIR
  jaiph__mock_file=$(mktemp)
  trap 'rm -f "$jaiph__mock_file"' RETURN
  unset JAIPH_MOCK_DISPATCH_SCRIPT
  printf '%s\n' 'Hello Alice! Fun fact: Alice in Wonderland was written by Lewis Carroll.' >> "$jaiph__mock_file"
  export JAIPH_MOCK_RESPONSES_FILE="$jaiph__mock_file"
  set +e
  response=$(e2e::say_hello::workflow::default 'Alice' 2>&1)
  jaiph__test_exit=$?
  set -e
  if [[ $jaiph__test_exit -ne 0 ]]; then
    echo "jai: workflow exited with status $jaiph__test_exit" >&2
    return 1
  fi
    content=$(cat hello.txt)
  jaiph__expect_contain "$content" 'Hello Alice'
}

jaiph__run_tests() {
  local bold=$'\e[1m' reset=$'\e[0m'
  echo -e "${bold}testing${reset} $jaiph__test_display_name"
  local total=0 failed=0 i start elapsed branch desc desc_show
  local -a failed_names=()
  for ((i=0; i<2; i++)); do
    desc="${jaiph__test_descs[$i]}"
    desc_show="${desc/runs/${bold}test${reset}}"
    start=$SECONDS
    if jaiph__test_$i; then
      elapsed=$((SECONDS - start))
      [[ $i -eq 1 ]] && branch="└──" || branch="├──"
      echo -e "  $branch $desc_show (${elapsed}s)"
    else
      failed=$((failed + 1))
      failed_names+=("$desc")
      elapsed=$((SECONDS - start))
      [[ $i -eq 1 ]] && branch="└──" || branch="├──"
      echo -e "  $branch $desc_show (${elapsed}s failed)" >&2
    fi
    total=$((total + 1))
  done
  if [[ $failed -gt 0 ]]; then
    echo "" >&2
    echo "✗ $failed / $total test(s) failed" >&2
    for name in "${failed_names[@]}"; do echo "  - $name" >&2; done
    return 1
  fi
  echo "✓ $total test(s) passed"
  return 0
}

jaiph__run_tests