#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="127.0.0.1"
PORT="8123"
SERVER_URL="http://${HOST}:${PORT}"
TMP_DIR="$(mktemp -d)"
BIN_DIR="${TMP_DIR}/bin"
WORK_DIR="${TMP_DIR}/workspace"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${BIN_DIR}" "${WORK_DIR}"
export PATH="${BIN_DIR}:${PATH}"
export JAIPH_BIN_DIR="${BIN_DIR}"
if [[ -z "${JAIPH_REPO_URL:-}" ]]; then
  export JAIPH_REPO_URL="file://${ROOT_DIR}"
fi
if [[ -z "${JAIPH_REPO_REF:-}" ]]; then
  detected_ref="$(git -C "${ROOT_DIR}" branch --show-current || true)"
  if [[ -n "${detected_ref}" ]]; then
    export JAIPH_REPO_REF="${detected_ref}"
  else
    export JAIPH_REPO_REF="main"
  fi
fi

python3 -m http.server "${PORT}" --bind "${HOST}" --directory "${ROOT_DIR}/docs" >/dev/null 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 30); do
  if curl -fsS "${SERVER_URL}/install" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

curl -fsSL "${SERVER_URL}/install" | bash

jaiph --help
jaiph use nightly

jaiph init "${WORK_DIR}"
test -f "${WORK_DIR}/.jaiph/bootstrap.jph"
test -f "${WORK_DIR}/.jaiph/config.toml"
test -f "${WORK_DIR}/.jaiph/jaiph-skill.md"
test -x "${WORK_DIR}/.jaiph/bootstrap.jph"

cat > "${WORK_DIR}/hello.jph" <<'EOF'
workflow default {
  echo "hello-e2e"
}
EOF

jaiph build "${WORK_DIR}/hello.jph"
run_output="$(jaiph run "${WORK_DIR}/hello.jph")"
if [[ "${run_output}" != *"PASS workflow default"* ]]; then
  echo "Expected jaiph run to report PASS for hello workflow. Output was:" >&2
  printf '%s\n' "${run_output}" >&2
  exit 1
fi

cp "${ROOT_DIR}/e2e/current_branch.jph" "${WORK_DIR}/current_branch.jph"
(
  cd "${WORK_DIR}"
  git init -b main >/dev/null 2>&1 || git init >/dev/null 2>&1
  current_branch="$(git branch --show-current)"
  [[ -n "${current_branch}" ]] || current_branch="main"

  # Should pass with the actual branch name.
  jaiph run "./current_branch.jph" "${current_branch}"

  # Should fail with a different branch name.
  wrong_branch="${current_branch}-wrong"
  if jaiph run "./current_branch.jph" "${wrong_branch}"; then
    echo "Expected current_branch.jph to fail for branch: ${wrong_branch}" >&2
    exit 1
  fi
)
