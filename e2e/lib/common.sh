#!/usr/bin/env bash

set -euo pipefail

if [[ -n "${JAIPH_E2E_COMMON_SH_LOADED:-}" ]]; then
  return 0
fi
JAIPH_E2E_COMMON_SH_LOADED=1

E2E_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_HOST="${JAIPH_E2E_HOST:-127.0.0.1}"
E2E_PORT="${JAIPH_E2E_PORT:-8123}"
E2E_SERVER_URL="http://${E2E_HOST}:${E2E_PORT}"
E2E_SERVER_PID=""
E2E_OWNS_TMP_DIR=0
E2E_OWNS_TEST_DIR=0

e2e::section() {
  printf "\n== %s ==\n" "$1"
}

e2e::pass() {
  printf "  [PASS] %s\n" "$1"
}

e2e::skip() {
  printf "  [SKIP] %s\n" "$1"
}

e2e::fail() {
  printf "  [FAIL] %s\n" "$1" >&2
  exit 1
}

e2e::assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf "Expected output to contain: %s\n" "${needle}" >&2
    printf "Output was:\n%s\n" "${haystack}" >&2
    e2e::fail "${label}"
  fi
  e2e::pass "${label}"
}

e2e::assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf "Expected:\n%s\n" "${expected}" >&2
    printf "Actual:\n%s\n" "${actual}" >&2
    e2e::fail "${label}"
  fi
  e2e::pass "${label}"
}

e2e::normalize_output() {
  local input="$1"
  # Strip ANSI and normalize timing values for stable assertions.
  printf "%s" "${input}" \
    | sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g' \
    | sed -E 's/\(([0-9]+(\.[0-9]+)?s|[0-9]+m [0-9]+s)\)/(<time>)/g' \
    | sed -E 's/\(([0-9]+(\.[0-9]+)?s|[0-9]+m [0-9]+s) failed\)/(<time> failed)/g' \
    | sed -E 's/✓ ([0-9]+)(\.[0-9]+)?s/✓ <time>/g' \
    | sed -E 's/✗ ([0-9]+)(\.[0-9]+)?s/✗ <time>/g' \
    | sed -E 's/✗ (.*) ([0-9]+)(\.[0-9]+)?s$/✗ \1 <time>/g' \
    | sed -E 's/^( *)(cursor-agent|printf %s) .*$/\1<agent-command>/g' \
    | sed -E 's/[[:space:]]+$//g'
}

e2e::assert_output_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  local normalized_actual
  normalized_actual="$(e2e::normalize_output "${actual}")"
  e2e::assert_equals "${normalized_actual}" "${expected}" "${label}"
}

e2e::assert_file_exists() {
  local path="$1"
  local label="$2"
  [[ -f "${path}" ]] || e2e::fail "${label} (missing file: ${path})"
  e2e::pass "${label}"
}

e2e::assert_file_executable() {
  local path="$1"
  local label="$2"
  [[ -x "${path}" ]] || e2e::fail "${label} (not executable: ${path})"
  e2e::pass "${label}"
}

e2e::readonly_sandbox_available() {
  command -v unshare >/dev/null 2>&1 &&
    command -v sudo >/dev/null 2>&1 &&
    sudo -n true >/dev/null 2>&1 &&
    unshare -m true >/dev/null 2>&1
}

e2e::cleanup() {
  if [[ -n "${E2E_SERVER_PID}" ]]; then
    kill "${E2E_SERVER_PID}" >/dev/null 2>&1 || true
    wait "${E2E_SERVER_PID}" 2>/dev/null || true
    E2E_SERVER_PID=""
  fi

  if [[ "${E2E_OWNS_TEST_DIR}" == "1" && -n "${JAIPH_E2E_TEST_DIR:-}" ]]; then
    rm -rf "${JAIPH_E2E_TEST_DIR}"
  fi
  if [[ "${E2E_OWNS_TMP_DIR}" == "1" && -n "${JAIPH_E2E_TMP_DIR:-}" ]]; then
    rm -rf "${JAIPH_E2E_TMP_DIR}"
  fi
}

e2e::prepare_shared_context() {
  if [[ -z "${JAIPH_E2E_TMP_DIR:-}" ]] &&
     { [[ -z "${JAIPH_E2E_BIN_DIR:-}" ]] || [[ -z "${JAIPH_E2E_WORK_DIR:-}" ]]; }; then
    JAIPH_E2E_TMP_DIR="$(mktemp -d)"
    export JAIPH_E2E_TMP_DIR
    E2E_OWNS_TMP_DIR=1
  fi

  if [[ -z "${JAIPH_E2E_BIN_DIR:-}" ]]; then
    JAIPH_E2E_BIN_DIR="${JAIPH_E2E_TMP_DIR}/bin"
    export JAIPH_E2E_BIN_DIR
  fi
  if [[ -z "${JAIPH_E2E_WORK_DIR:-}" ]]; then
    JAIPH_E2E_WORK_DIR="${JAIPH_E2E_TMP_DIR}/workspace"
    export JAIPH_E2E_WORK_DIR
  fi

  mkdir -p "${JAIPH_E2E_BIN_DIR}" "${JAIPH_E2E_WORK_DIR}"
  export PATH="${JAIPH_E2E_BIN_DIR}:${PATH}"
  export JAIPH_BIN_DIR="${JAIPH_E2E_BIN_DIR}"
  # Docker is enabled by default locally; disable for e2e tests.
  export JAIPH_DOCKER_ENABLED="${JAIPH_DOCKER_ENABLED:-false}"

  if [[ -z "${JAIPH_REPO_URL:-}" ]]; then
    export JAIPH_REPO_URL="${E2E_REPO_ROOT}"
  fi
  if [[ -z "${JAIPH_REPO_REF:-}" ]]; then
    local detected_ref
    detected_ref="$(git -C "${E2E_REPO_ROOT}" branch --show-current || true)"
    if [[ -n "${detected_ref}" ]]; then
      export JAIPH_REPO_REF="${detected_ref}"
    else
      export JAIPH_REPO_REF="main"
    fi
  fi
}

e2e::ensure_local_install() {
  if [[ -x "${JAIPH_E2E_BIN_DIR}/jaiph" ]]; then
    return 0
  fi

  # Prefer local repo binary for CI/local parity. Build dist on-demand when needed.
  if command -v node >/dev/null 2>&1; then
    if [[ ! -f "${E2E_REPO_ROOT}/dist/src/cli.js" ]] && [[ -f "${E2E_REPO_ROOT}/node_modules/typescript/bin/tsc" ]]; then
      # Build only when local dev deps are installed; otherwise fall back to install script path.
      (cd "${E2E_REPO_ROOT}" && npm run build >/dev/null)
    fi
  fi

  if [[ -f "${E2E_REPO_ROOT}/dist/src/cli.js" ]] && command -v node >/dev/null 2>&1; then
    mkdir -p "${JAIPH_E2E_BIN_DIR}"
    local stdlib_dest="${JAIPH_E2E_BIN_DIR}/jaiph_stdlib.sh"
    cp "${E2E_REPO_ROOT}/src/jaiph_stdlib.sh" "${stdlib_dest}"
    mkdir -p "${JAIPH_E2E_BIN_DIR}/runtime"
    cp -R "${E2E_REPO_ROOT}/src/runtime/"* "${JAIPH_E2E_BIN_DIR}/runtime/"
    cat > "${JAIPH_E2E_BIN_DIR}/jaiph" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export JAIPH_STDLIB="\${JAIPH_STDLIB:-${JAIPH_E2E_BIN_DIR}/jaiph_stdlib.sh}"
exec node "${E2E_REPO_ROOT}/dist/src/cli.js" "\$@"
EOF
    chmod 755 "${JAIPH_E2E_BIN_DIR}/jaiph" "${stdlib_dest}"
    return 0
  fi

  python3 -m http.server "${E2E_PORT}" --bind "${E2E_HOST}" --directory "${E2E_REPO_ROOT}/docs" >/dev/null 2>&1 &
  E2E_SERVER_PID="$!"

  for _ in $(seq 1 30); do
    if curl -fsS "${E2E_SERVER_URL}/install" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  JAIPH_BIN_DIR="${JAIPH_E2E_BIN_DIR}" curl -fsSL "${E2E_SERVER_URL}/install" | bash
}

e2e::prepare_test_env() {
  local test_name="$1"
  e2e::prepare_shared_context

  if [[ "${JAIPH_E2E_SKIP_INSTALL:-0}" != "1" ]]; then
    e2e::ensure_local_install
  fi

  if [[ -z "${JAIPH_E2E_TEST_DIR:-}" ]]; then
    JAIPH_E2E_TEST_DIR="$(mktemp -d "${JAIPH_E2E_WORK_DIR}/${test_name}.XXXXXX")"
    export JAIPH_E2E_TEST_DIR
    E2E_OWNS_TEST_DIR=1
  else
    mkdir -p "${JAIPH_E2E_TEST_DIR}"
  fi
}
