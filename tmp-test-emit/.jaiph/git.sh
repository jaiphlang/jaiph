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

# Verifies this workflow is executed inside a git repository.
.jaiph::git::rule::in_git_repo::impl() {
  set -eo pipefail
  set +u
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

.jaiph::git::rule::in_git_repo() {
  jaiph::run_step .jaiph::git::rule::in_git_repo jaiph::execute_readonly .jaiph::git::rule::in_git_repo::impl "$@"
}

# Verifies there are no tracked or untracked changes.
.jaiph::git::rule::branch_clean::impl() {
  set -eo pipefail
  set +u
  test -z "$(git status --porcelain)"
}

.jaiph::git::rule::branch_clean() {
  jaiph::run_step .jaiph::git::rule::branch_clean jaiph::execute_readonly .jaiph::git::rule::branch_clean::impl "$@"
}

# Verifies there is at least one change to commit.
.jaiph::git::rule::has_changes::impl() {
  set -eo pipefail
  set +u
  test -n "$(git status --porcelain)"
}

.jaiph::git::rule::has_changes() {
  jaiph::run_step .jaiph::git::rule::has_changes jaiph::execute_readonly .jaiph::git::rule::has_changes::impl "$@"
}

.jaiph::git::rule::is_clean::impl() {
  set -eo pipefail
  set +u
  .jaiph::git::rule::in_git_repo
  .jaiph::git::rule::branch_clean
}

.jaiph::git::rule::is_clean() {
  jaiph::run_step .jaiph::git::rule::is_clean jaiph::execute_readonly .jaiph::git::rule::is_clean::impl "$@"
}

.jaiph::git::workflow::commit::impl() {
  set -eo pipefail
  set +u
  if ! .jaiph::git::rule::has_changes; then
    echo "No changes to commit."
    exit 0
  fi
  jaiph::prompt "$@" <<__JAIPH_PROMPT_29__

    Commit the current repository changes now.

    Requirements:
    1. Review current git changes and generate a concise commit message.
    2. Stage all relevant changes with git add.
    3. Create exactly one commit.
    4. Do not push.
    5. Print the created commit hash.
  
__JAIPH_PROMPT_29__
}

.jaiph::git::workflow::commit() {
  jaiph::run_step .jaiph::git::workflow::commit .jaiph::git::workflow::commit::impl "$@"
}