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

docs_parity::rule::docs_files_present::impl() {
  set -eo pipefail
  set +u
  test "$#" -gt 0
  EXPECTED_DOC_FILES=("$@")
  for file in "${EXPECTED_DOC_FILES[@]}"; do
  test -f "$file"
  done
}

docs_parity::rule::docs_files_present() {
  jaiph::run_step docs_parity::rule::docs_files_present jaiph::execute_readonly docs_parity::rule::docs_files_present::impl "$@"
}

docs_parity::rule::only_expected_docs_changed_after_prompt::impl() {
  set -eo pipefail
  set +u
  test "$#" -eq 2
  EXPECTED_DOC_FILES="$1"
  BEFORE_CHANGED_FILES="$2"
  AFTER_CHANGED_FILES="$(changed_files)"
  NEW_CHANGED_FILES="$(
  comm -13 \
  <(printf '%s\n' "$BEFORE_CHANGED_FILES") \
  <(printf '%s\n' "$AFTER_CHANGED_FILES") || true
  )"
  if [ -z "$NEW_CHANGED_FILES" ]; then
  exit 0
  fi
  while IFS= read -r changed_file; do
  [ -z "$changed_file" ] && continue
  if [[ $'\n'"$EXPECTED_DOC_FILES"$'\n' == *$'\n'"$changed_file"$'\n'* ]]; then
  continue
  fi
  echo "Unexpected file changed by docs prompt: $changed_file"
  exit 1
  done <<< "$NEW_CHANGED_FILES"
}

docs_parity::rule::only_expected_docs_changed_after_prompt() {
  jaiph::run_step docs_parity::rule::only_expected_docs_changed_after_prompt jaiph::execute_readonly docs_parity::rule::only_expected_docs_changed_after_prompt::impl "$@"
}

docs_parity::rule::tests_pass::impl() {
  set -eo pipefail
  set +u
  npm test
}

docs_parity::rule::tests_pass() {
  jaiph::run_step docs_parity::rule::tests_pass jaiph::execute_readonly docs_parity::rule::tests_pass::impl "$@"
}

docs_parity::rule::e2e_tests_pass::impl() {
  set -eo pipefail
  set +u
  npm run test:e2e
}

docs_parity::rule::e2e_tests_pass() {
  jaiph::run_step docs_parity::rule::e2e_tests_pass jaiph::execute_readonly docs_parity::rule::e2e_tests_pass::impl "$@"
}

docs_parity::function::changed_files::impl() {
  set -eo pipefail
  set +u
  {
  git diff --name-only
  git ls-files --others --exclude-standard
  } | sort -u
}

docs_parity::function::changed_files() {
  jaiph::run_step_passthrough docs_parity::function::changed_files docs_parity::function::changed_files::impl "$@"
}

changed_files() {
  docs_parity::function::changed_files "$@"
}

docs_parity::workflow::default::impl() {
  set -eo pipefail
  set +u
  EXPECTED_DOC_FILES=(
  "README.md"
  "CHANGELOG.md"
  "docs/index.html"
  "docs/getting-started.md"
  "docs/cli.md"
  "docs/configuration.md"
  "docs/install"
  "docs/jaiph-skill.md"
  "docs/grammar.md"
  "docs/testing.md"
  )
  docs_parity::rule::tests_pass
  docs_parity::rule::e2e_tests_pass
  docs_parity::rule::docs_files_present "${EXPECTED_DOC_FILES[@]}"
  BEFORE_CHANGED_FILES="$(changed_files)"
  cp README.md docs/getting-started.md
  perl -pi -e 's{docs/logo\.png}{logo.png}g' docs/getting-started.md
  perl -pi -e 's{\]\(docs/([a-z.-]+\.md)\)}{]($1)}g' docs/getting-started.md
  jaiph::prompt "$@" <<__JAIPH_PROMPT_79__

    Ensure implementation/docs parity for this repository.

    If behavior, command syntax, runtime semantics, or installation details
    changed, update relevant files so they remain accurate and consistent:
    ${EXPECTED_DOC_FILES[@]}

    If there is a new docs/*.md file, add it to the EXPECTED_DOC_FILES array in
    this workflow file and follow the same rules as for existing files.
    
    Keep examples executable and aligned with current CLI behavior.

    For docs markdown pages, ensure each page has a top navigation block
    immediately after its H1 with links to jaiph.org, and to documentation pages
    in docs/ directory. Use relative links to configuration.md, cli.md, not 
    repository URLs or local filesystem paths. Don't include non-markdown files
    in the navigation block. Links in markdown files to markdown files should
    end with .md ('configuration.md'). Existing links in index.html should not
    end with .md ('configuration'). Agent skill should always point to:
    https://jaiph.org/jaiph-skill.md (always with .md suffix).

    Ensure there is a CHANGELOG.md file with a list of all features that are
    supported by the current version. It should be in the following format:
    
      # VERSION
      - Feature 1
      - Feature 2

      # VERSION
      - Feature 3

    Don't modify changes from previous versions. Check for current Jaiph version
    in package.json and use git tags to find the previous version.
    Don't duplicate features from previous versions.

    Before finishing:
    - run npm test
    - run npm run test:e2e
    - if either fails, fix and retry until both pass
  
__JAIPH_PROMPT_79__
  EXPECTED_DOC_FILES_TEXT="$(printf '%s\n' "${EXPECTED_DOC_FILES[@]}")"
  docs_parity::rule::only_expected_docs_changed_after_prompt "$EXPECTED_DOC_FILES_TEXT" "$BEFORE_CHANGED_FILES"
  docs_parity::rule::tests_pass
  docs_parity::rule::e2e_tests_pass
}

docs_parity::workflow::default() {
  jaiph::run_step docs_parity::workflow::default docs_parity::workflow::default::impl "$@"
}