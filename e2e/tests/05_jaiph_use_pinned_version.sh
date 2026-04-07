#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "jaiph_use_pinned"

VERSION="$(node -p "require('${E2E_REPO_ROOT}/package.json').version")"
USE_BIN="${JAIPH_E2E_TEST_DIR}/use_bin"
mkdir -p "${USE_BIN}"
export JAIPH_BIN_DIR="${USE_BIN}"
export JAIPH_LIB_DIR="${USE_BIN}/.jaiph"

e2e::section "jaiph use <package.json version> reinstalls via installer"

export JAIPH_INSTALL_COMMAND="bash \"${E2E_REPO_ROOT}/docs/install\" \"${E2E_REPO_ROOT}\""
use_combined="$(jaiph use "${VERSION}" 2>&1)"
# assert_contains: installer output includes dynamic paths and progress text that vary per environment
e2e::assert_contains "${use_combined}" "Reinstalling Jaiph from ref 'v${VERSION}'" \
  "jaiph use prints expected git ref for pinned version"

if [[ ! -x "${USE_BIN}/jaiph" ]]; then
  e2e::fail "installer did not place jaiph in JAIPH_BIN_DIR"
fi

ver_out="$("${USE_BIN}/jaiph" --version 2>&1)"
# assert_contains: version banner may include build metadata or git hash suffix
e2e::assert_contains "${ver_out}" "jaiph ${VERSION}" \
  "reinstalled jaiph --version matches package.json"

e2e::pass "jaiph use ${VERSION} with local docs/install"
