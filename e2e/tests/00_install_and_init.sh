#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "install_and_init"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Installer and smoke checks"

# When
help_output="$(jaiph --help)"

# Then
# assert_contains: help text includes dynamic command list and version info that vary across builds
e2e::assert_contains "${help_output}" "jaiph" "jaiph CLI responds to --help"

e2e::section "Project init and generated files"

# When
jaiph init "${TEST_DIR}"

# Then
if [[ -f "${TEST_DIR}/.jaiph/bootstrap.jh" ]]; then
  BOOTSTRAP_FILE="${TEST_DIR}/.jaiph/bootstrap.jh"
else
  e2e::fail "Expected .jaiph/bootstrap.jh to exist after init"
fi
e2e::assert_file_exists "${BOOTSTRAP_FILE}" "bootstrap file exists"
e2e::assert_file_executable "${BOOTSTRAP_FILE}" "bootstrap file is executable"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/SKILL.md" "SKILL.md exists"

if ! cmp -s "${BOOTSTRAP_FILE}" <(cat <<'EOF'
#!/usr/bin/env jaiph

# Bootstraps Jaiph workflows for this repository.
workflow default() {
  const bootstrap_summary = prompt """
    You are bootstrapping Jaiph for this repository.
    First, read the Jaiph agent bootstrap guide at:
    .jaiph/SKILL.md
    Follow that guide and Jaiph language rules exactly.
    Perform these tasks in order:
    1) Analyze repository structure, languages, package manager, and build/test/lint commands.
    2) Detect existing contribution conventions (branching, commit style, CI checks).
    3) Create or update Jaiph workflows under .jaiph/ for safe feature implementation, including:
       - preflight checks (clean git state, branch guards when relevant)
       - implementation workflow
       - verification workflow (tests/lint/build)
    4) Keep workflows minimal, composable, and specific to this project.
    5) Print a short usage guide with exact jaiph run commands.
    6) End your response with:
       - WHAT CHANGED: files touched and key edits
       - WHY: tie each edit to repository structure, tests, or sandbox needs
  """
  log "Bootstrap summary (what changed and why):"
  log "${bootstrap_summary}"
}
EOF
); then
  e2e::fail "Expected .jaiph/bootstrap.jh to match init template with triple-quoted prompt"
fi
e2e::pass "bootstrap template matches expected triple-quoted prompt content"

jaiph compile "${BOOTSTRAP_FILE}"
e2e::pass "generated bootstrap workflow compiles"

# Bash command substitution strips a trailing newline; compare bytes with cmp.
if ! cmp -s "${TEST_DIR}/.jaiph/.gitignore" <(printf 'runs\ntmp\n'); then
  e2e::fail "Expected .jaiph/.gitignore to list runs and tmp with a final newline"
fi
e2e::pass ".jaiph/.gitignore lists runs and tmp"
