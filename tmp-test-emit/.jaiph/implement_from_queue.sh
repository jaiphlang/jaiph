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
source "$(dirname "${BASH_SOURCE[0]}")/docs_parity.sh"

# Verifies the project compiles after changes.
.jaiph::implement_from_queue::rule::project_compiles::impl() {
  set -eo pipefail
  set +u
  npm run build
}

.jaiph::implement_from_queue::rule::project_compiles() {
  jaiph::run_step .jaiph::implement_from_queue::rule::project_compiles jaiph::execute_readonly .jaiph::implement_from_queue::rule::project_compiles::impl "$@"
}

# Verifies tests pass after changes.
.jaiph::implement_from_queue::rule::tests_pass::impl() {
  set -eo pipefail
  set +u
  npm test
}

.jaiph::implement_from_queue::rule::tests_pass() {
  jaiph::run_step .jaiph::implement_from_queue::rule::tests_pass jaiph::execute_readonly .jaiph::implement_from_queue::rule::tests_pass::impl "$@"
}

.jaiph::implement_from_queue::rule::e2e_tests_pass::impl() {
  set -eo pipefail
  set +u
  npm run test:e2e
}

.jaiph::implement_from_queue::rule::e2e_tests_pass() {
  jaiph::run_step .jaiph::implement_from_queue::rule::e2e_tests_pass jaiph::execute_readonly .jaiph::implement_from_queue::rule::e2e_tests_pass::impl "$@"
}

.jaiph::implement_from_queue::function::get_first_task::impl() {
  set -eo pipefail
  set +u
  if ! test -f ".jaiph/QUEUE.md"; then
  echo "missing .jaiph/QUEUE.md" >&2
  return 1
  fi
  if ! task="$(awk 'BEGIN{in_task=0;found=0} /^## /{if(in_task) exit; in_task=1; found=1} in_task{if($0 ~ /^---$/) exit; print} END{if(!found) exit 2}' .jaiph/QUEUE.md)"; then
  echo "no tasks found in .jaiph/QUEUE.md" >&2
  return 1
  fi
  if ! test -n "${task}"; then
  echo "first task is empty in .jaiph/QUEUE.md" >&2
  return 1
  fi
  printf "%s" "${task}"
}

.jaiph::implement_from_queue::function::get_first_task() {
  jaiph::run_step_passthrough .jaiph::implement_from_queue::function::get_first_task .jaiph::implement_from_queue::function::get_first_task::impl "$@"
}

get_first_task() {
  .jaiph::implement_from_queue::function::get_first_task "$@"
}

# Reads the first task block from .jaiph/QUEUE.md and asks the agent to implement it.
.jaiph::implement_from_queue::workflow::implement_task::impl() {
  set -eo pipefail
  set +u
  jaiph::prompt "$@" <<__JAIPH_PROMPT_43__

    You are working on the Jaiph codebase (https://github.com/jaiphlang/jaiph), a TypeScript compiler and runtime for a DSL that transpiles to Bash.

    Implement the following task by:
    - Consulting ARCHITECTURE.md at the repo root for module boundaries (or inferring from the file structure if missing or outdated).
    - Editing only files directly relevant to the task or those listed under 'Files to change'.
    - Following the codebase's existing style and conventions precisely.
    - Adding or updating tests as needed for acceptance criteria.
    - Running npm run build, npm test, and npm run test:e2e; fix any failures before continuing.
    - Ensuring all acceptance criteria in the task are met.
    - At the end, state which task ID was implemented and list all files changed.

    Task:
    $1
  
__JAIPH_PROMPT_43__
}

.jaiph::implement_from_queue::workflow::implement_task() {
  jaiph::run_step .jaiph::implement_from_queue::workflow::implement_task .jaiph::implement_from_queue::workflow::implement_task::impl "$@"
}

.jaiph::implement_from_queue::workflow::make_ci_pass::impl() {
  set -eo pipefail
  set +u
  if ! .jaiph::implement_from_queue::rule::project_compiles; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_62__
Fix failing compilation so npm run build passes.
__JAIPH_PROMPT_62__
    .jaiph::implement_from_queue::workflow::make_ci_pass
    return 0
  fi
  if ! .jaiph::implement_from_queue::rule::tests_pass; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_67__
Fix failing tests so npm test passes.
__JAIPH_PROMPT_67__
    .jaiph::implement_from_queue::workflow::make_ci_pass
    return 0
  fi
  if ! .jaiph::implement_from_queue::rule::e2e_tests_pass; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_72__
Fix failing e2e tests so npm run test:e2e passes.
__JAIPH_PROMPT_72__
    .jaiph::implement_from_queue::workflow::make_ci_pass
    return 0
  fi
}

.jaiph::implement_from_queue::workflow::make_ci_pass() {
  jaiph::run_step .jaiph::implement_from_queue::workflow::make_ci_pass .jaiph::implement_from_queue::workflow::make_ci_pass::impl "$@"
}

# Removes the first completed task block from .jaiph/QUEUE.md.
.jaiph::implement_from_queue::workflow::remove_completed_task::impl() {
  set -eo pipefail
  set +u
  test -n "${1:-}"
  header="$1"
  awk -v header="${header}" 'BEGIN{skipping=0;removed=0} {if(!removed && $0==header){skipping=1;removed=1;next} if(skipping && $0 ~ /^## /){skipping=0} if(!skipping){print}} END{if(!removed) exit 2}' .jaiph/QUEUE.md > .jaiph/QUEUE.md.tmp
  mv .jaiph/QUEUE.md.tmp .jaiph/QUEUE.md
  sed -i.bak -E '/^[[:space:]]*$/N;/^\n$/D' .jaiph/QUEUE.md
  rm -f .jaiph/QUEUE.md.bak
}

.jaiph::implement_from_queue::workflow::remove_completed_task() {
  jaiph::run_step .jaiph::implement_from_queue::workflow::remove_completed_task .jaiph::implement_from_queue::workflow::remove_completed_task::impl "$@"
}

.jaiph::implement_from_queue::workflow::default::impl() {
  set -eo pipefail
  set +u
  task="$(get_first_task)"
  task_header="${task%%$'\n'*}" # first line of the task block
  .jaiph::implement_from_queue::workflow::implement_task "$task"
  .jaiph::implement_from_queue::workflow::make_ci_pass
  .jaiph::docs_parity::workflow::default
  .jaiph::implement_from_queue::workflow::remove_completed_task "$task_header"
}

.jaiph::implement_from_queue::workflow::default() {
  jaiph::run_step .jaiph::implement_from_queue::workflow::default .jaiph::implement_from_queue::workflow::default::impl "$@"
}