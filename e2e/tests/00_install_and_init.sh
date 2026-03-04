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
e2e::assert_contains "${help_output}" "jaiph" "jaiph CLI responds to --help"

e2e::section "Project init and generated files"
# When
jaiph init "${TEST_DIR}"

# Then
if [[ -f "${TEST_DIR}/.jaiph/bootstrap.jh" ]]; then
  BOOTSTRAP_FILE="${TEST_DIR}/.jaiph/bootstrap.jh"
elif [[ -f "${TEST_DIR}/.jaiph/bootstrap.jph" ]]; then
  BOOTSTRAP_FILE="${TEST_DIR}/.jaiph/bootstrap.jph"
else
  e2e::fail "Expected .jaiph/bootstrap.jh or .jaiph/bootstrap.jph to exist after init"
fi
e2e::assert_file_exists "${BOOTSTRAP_FILE}" "bootstrap file exists"
e2e::assert_file_executable "${BOOTSTRAP_FILE}" "bootstrap file is executable"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/jaiph-skill.md" "jaiph-skill.md exists"
