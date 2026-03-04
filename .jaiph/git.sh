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
git::rule::in_git_repo::impl() {
  set -eo pipefail
  set +u
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

git::rule::in_git_repo() {
  jaiph::run_step git::rule::in_git_repo jaiph::execute_readonly git::rule::in_git_repo::impl "$@"
}

# Verifies there are no tracked or untracked changes.
git::rule::branch_clean::impl() {
  set -eo pipefail
  set +u
  test -z "$(git status --porcelain)"
}

git::rule::branch_clean() {
  jaiph::run_step git::rule::branch_clean jaiph::execute_readonly git::rule::branch_clean::impl "$@"
}

# Verifies there is at least one change to commit.
git::rule::has_changes::impl() {
  set -eo pipefail
  set +u
  test -n "$(git status --porcelain)"
}

git::rule::has_changes() {
  jaiph::run_step git::rule::has_changes jaiph::execute_readonly git::rule::has_changes::impl "$@"
}

git::rule::is_clean::impl() {
  set -eo pipefail
  set +u
  git::rule::in_git_repo
  git::rule::branch_clean
}

git::rule::is_clean() {
  jaiph::run_step git::rule::is_clean jaiph::execute_readonly git::rule::is_clean::impl "$@"
}

git::workflow::commit::impl() {
  set -eo pipefail
  set +u
  if ! git::rule::has_changes; then
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

git::workflow::commit() {
  jaiph::run_step git::workflow::commit git::workflow::commit::impl "$@"
}