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

# Verifies the queue file exists and has at least one pending task.
implement_from_queue::rule::queue_has_tasks::impl() {
  set -eo pipefail
  set +u
  test -f ".jaiph/QUEUE.md"
  grep -q "^## " .jaiph/QUEUE.md
}

implement_from_queue::rule::queue_has_tasks() {
  jaiph::run_step implement_from_queue::rule::queue_has_tasks jaiph::execute_readonly implement_from_queue::rule::queue_has_tasks::impl "$@"
}

# Verifies the project compiles after changes.
implement_from_queue::rule::project_compiles::impl() {
  set -eo pipefail
  set +u
  npm run build
}

implement_from_queue::rule::project_compiles() {
  jaiph::run_step implement_from_queue::rule::project_compiles jaiph::execute_readonly implement_from_queue::rule::project_compiles::impl "$@"
}

# Verifies tests pass after changes.
implement_from_queue::rule::tests_pass::impl() {
  set -eo pipefail
  set +u
  npm test
}

implement_from_queue::rule::tests_pass() {
  jaiph::run_step implement_from_queue::rule::tests_pass jaiph::execute_readonly implement_from_queue::rule::tests_pass::impl "$@"
}

implement_from_queue::rule::e2e_tests_pass::impl() {
  set -eo pipefail
  set +u
  npm run test:e2e
}

implement_from_queue::rule::e2e_tests_pass() {
  jaiph::run_step implement_from_queue::rule::e2e_tests_pass jaiph::execute_readonly implement_from_queue::rule::e2e_tests_pass::impl "$@"
}

implement_from_queue::function::get_first_task::impl() {
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

implement_from_queue::function::get_first_task() {
  jaiph::run_step_passthrough implement_from_queue::function::get_first_task implement_from_queue::function::get_first_task::impl "$@"
}

get_first_task() {
  implement_from_queue::function::get_first_task "$@"
}

# Reads the first task block from .jaiph/QUEUE.md and asks the agent to implement it.
implement_from_queue::workflow::implement_task::impl() {
  set -eo pipefail
  set +u
  jaiph::prompt "$@" <<__JAIPH_PROMPT_47__

    You are working on the Jaiph codebase (https://github.com/jaiphlang/jaiph).
    The codebase is a TypeScript compiler and runtime for a DSL that transpiles to bash.

    Your job is to implement this task block (passed as argument):
    $1

    Start by reading ARCHITECTURE.md at the repository root for current module boundaries.
    If ARCHITECTURE.md is missing or stale, infer architecture from existing directories/files first.

    Steps:
    1. Parse the provided task block from $1.
    2. Read ARCHITECTURE.md, then read the relevant source files listed under 'Files to change' in that task.
    3. If the task list is incomplete, edit only directly-related files needed to deliver acceptance criteria.
    4. Implement the changes described. Follow the existing code style exactly.
    5. Add or update tests needed for acceptance criteria.
    6. Run npm run build, npm test, and npm run test:e2e.
    7. If checks fail, fix and retry until all pass.
    8. Before finishing, ensure acceptance criteria from the task are demonstrably satisfied.

    When done, confirm which task ID you implemented and list every file you changed.
  
__JAIPH_PROMPT_47__
}

implement_from_queue::workflow::implement_task() {
  jaiph::run_step implement_from_queue::workflow::implement_task implement_from_queue::workflow::implement_task::impl "$@"
}

implement_from_queue::workflow::make_ci_pass::impl() {
  set -eo pipefail
  set +u
  if ! implement_from_queue::rule::project_compiles; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_73__
Fix failing compilation so npm run build passes.
__JAIPH_PROMPT_73__
    implement_from_queue::workflow::make_ci_pass
  fi
  if ! implement_from_queue::rule::tests_pass; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_77__
Fix failing tests so npm test passes.
__JAIPH_PROMPT_77__
    implement_from_queue::workflow::make_ci_pass
  fi
  if ! implement_from_queue::rule::e2e_tests_pass; then
    jaiph::prompt "$@" <<__JAIPH_PROMPT_81__
Fix failing e2e tests so npm run test:e2e passes.
__JAIPH_PROMPT_81__
    implement_from_queue::workflow::make_ci_pass
  fi
}

implement_from_queue::workflow::make_ci_pass() {
  jaiph::run_step implement_from_queue::workflow::make_ci_pass implement_from_queue::workflow::make_ci_pass::impl "$@"
}

# Removes the first completed task block from .jaiph/QUEUE.md.
implement_from_queue::workflow::remove_completed_task::impl() {
  set -eo pipefail
  set +u
  test -n "${1:-}"
  header="$1"
  awk -v header="${header}" 'BEGIN{skipping=0;removed=0} {if(!removed && $0==header){skipping=1;removed=1;next} if(skipping && $0 ~ /^## /){skipping=0} if(!skipping){print}} END{if(!removed) exit 2}' .jaiph/QUEUE.md > .jaiph/QUEUE.md.tmp
  mv .jaiph/QUEUE.md.tmp .jaiph/QUEUE.md
  sed -i.bak -E '/^[[:space:]]*$/N;/^\n$/D' .jaiph/QUEUE.md
  rm -f .jaiph/QUEUE.md.bak
}

implement_from_queue::workflow::remove_completed_task() {
  jaiph::run_step implement_from_queue::workflow::remove_completed_task implement_from_queue::workflow::remove_completed_task::impl "$@"
}

implement_from_queue::workflow::default::impl() {
  set -eo pipefail
  set +u
  task="$(get_first_task)"
  task_header="${task%%$'\n'*}"
  set -- "$task"
  implement_from_queue::workflow::implement_task
  implement_from_queue::workflow::make_ci_pass
  set -- "$task_header"
  implement_from_queue::workflow::remove_completed_task
}

implement_from_queue::workflow::default() {
  jaiph::run_step implement_from_queue::workflow::default implement_from_queue::workflow::default::impl "$@"
}