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
# Use current branch build for the rest of e2e (skip 'jaiph use nightly' to avoid main-branch CLI differences)

jaiph init "${WORK_DIR}"
# Accept either .jh or .jph (installed version may create either)
if [[ -f "${WORK_DIR}/.jaiph/bootstrap.jh" ]]; then
  BOOTSTRAP_FILE="${WORK_DIR}/.jaiph/bootstrap.jh"
elif [[ -f "${WORK_DIR}/.jaiph/bootstrap.jph" ]]; then
  BOOTSTRAP_FILE="${WORK_DIR}/.jaiph/bootstrap.jph"
else
  echo "Expected .jaiph/bootstrap.jh or .jaiph/bootstrap.jph to exist after init" >&2
  exit 1
fi
test -f "${BOOTSTRAP_FILE}"
test -f "${WORK_DIR}/.jaiph/config.toml"
test -f "${WORK_DIR}/.jaiph/jaiph-skill.md"
test -x "${BOOTSTRAP_FILE}"

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

# .jh entrypoint and run
cat > "${WORK_DIR}/hello.jh" <<'EOF'
workflow default {
  echo "hello-jh"
}
EOF
jaiph build "${WORK_DIR}/hello.jh"
run_output_jh="$(jaiph run "${WORK_DIR}/hello.jh")"
if [[ "${run_output_jh}" != *"PASS workflow default"* ]]; then
  echo "Expected jaiph run hello.jh to report PASS. Output was:" >&2
  printf '%s\n' "${run_output_jh}" >&2
  exit 1
fi
# Workflow stdout (e.g. echo) is in the run log; optional: assert run log contains hello-jh

# Mixed extension: .jh entrypoint importing .jph module
cat > "${WORK_DIR}/lib.jph" <<'EOF'
rule ready {
  echo "from-jph"
}
EOF
cat > "${WORK_DIR}/app.jh" <<'EOF'
import "lib.jph" as lib
workflow default {
  ensure lib.ready
  echo "mixed-ok"
}
EOF
jaiph build "${WORK_DIR}/app.jh"
run_mixed="$(jaiph run "${WORK_DIR}/app.jh")"
if [[ "${run_mixed}" != *"PASS workflow default"* ]]; then
  echo "Expected mixed .jh/.jph run to pass. Output was:" >&2
  printf '%s\n' "${run_mixed}" >&2
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

# --- E2E mocked commands and orchestration (deterministic, no network) ---
E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/mock_ok" "${E2E_MOCK_BIN}/mock_fail"
export PATH="${E2E_MOCK_BIN}:${PATH}"

# Rule execution: pass
cp "${ROOT_DIR}/e2e/rule_pass.jh" "${WORK_DIR}/rule_pass.jh"
jaiph build "${WORK_DIR}/rule_pass.jh"
rule_pass_out="$(jaiph run "${WORK_DIR}/rule_pass.jh")"
if [[ "${rule_pass_out}" != *"PASS workflow default"* ]]; then
  echo "Expected rule_pass.jh to PASS. Output was:" >&2
  printf '%s\n' "${rule_pass_out}" >&2
  exit 1
fi

# Rule execution: fail with asserted stderr
cp "${ROOT_DIR}/e2e/rule_fail.jh" "${WORK_DIR}/rule_fail.jh"
jaiph build "${WORK_DIR}/rule_fail.jh"
rule_fail_stderr="$(mktemp)"
if jaiph run "${WORK_DIR}/rule_fail.jh" 2>"${rule_fail_stderr}"; then
  echo "Expected rule_fail.jh to fail" >&2
  cat "${rule_fail_stderr}" >&2
  rm -f "${rule_fail_stderr}"
  exit 1
fi
if ! grep -q "e2e-rule-fail-message" "${rule_fail_stderr}"; then
  echo "Expected stderr to contain e2e-rule-fail-message. stderr was:" >&2
  cat "${rule_fail_stderr}" >&2
  rm -f "${rule_fail_stderr}"
  exit 1
fi
rm -f "${rule_fail_stderr}"

# Ensure inside workflow: fail path and stderr
cp "${ROOT_DIR}/e2e/ensure_fail.jh" "${WORK_DIR}/ensure_fail.jh"
jaiph build "${WORK_DIR}/ensure_fail.jh"
ensure_fail_stderr="$(mktemp)"
if jaiph run "${WORK_DIR}/ensure_fail.jh" 2>"${ensure_fail_stderr}"; then
  echo "Expected ensure_fail.jh to fail" >&2
  cat "${ensure_fail_stderr}" >&2
  rm -f "${ensure_fail_stderr}"
  exit 1
fi
if ! grep -q "e2e-rule-fail-message" "${ensure_fail_stderr}"; then
  echo "Expected stderr to contain e2e-rule-fail-message (ensure failure). stderr was:" >&2
  cat "${ensure_fail_stderr}" >&2
  rm -f "${ensure_fail_stderr}"
  exit 1
fi
rm -f "${ensure_fail_stderr}"

# Prompt success path: jaiph test with mock
mkdir -p "${WORK_DIR}/.jaiph/tests"
cp "${ROOT_DIR}/e2e/prompt_flow.jh" "${WORK_DIR}/prompt_flow.jh"
cat > "${WORK_DIR}/.jaiph/tests/prompt_flow.test.toml" <<'MOCK'
[[mock]]
prompt_contains = "e2e-prompt-please-return-mock"
response = "e2e-prompt-mock-response"
MOCK
prompt_ok_out="$(jaiph test "${WORK_DIR}/prompt_flow.jh")"
if [[ "${prompt_ok_out}" != *"PASS workflow default"* ]]; then
  echo "Expected jaiph test prompt_flow.jh to PASS. Output was:" >&2
  printf '%s\n' "${prompt_ok_out}" >&2
  exit 1
fi

# Prompt failure path: no matching mock -> clear stderr error
cp "${ROOT_DIR}/e2e/prompt_unmatched.jh" "${WORK_DIR}/prompt_unmatched.jh"
cat > "${WORK_DIR}/.jaiph/tests/prompt_unmatched.test.toml" <<'MOCK'
[[mock]]
prompt_contains = "something-else"
response = "never-used"
MOCK
prompt_fail_stderr="$(mktemp)"
if jaiph test "${WORK_DIR}/prompt_unmatched.jh" 2>"${prompt_fail_stderr}"; then
  echo "Expected jaiph test prompt_unmatched.jh to fail (no matching mock)" >&2
  cat "${prompt_fail_stderr}" >&2
  rm -f "${prompt_fail_stderr}"
  exit 1
fi
if ! grep -q "no mock matched" "${prompt_fail_stderr}"; then
  echo "Expected stderr to contain 'no mock matched'. stderr was:" >&2
  cat "${prompt_fail_stderr}" >&2
  rm -f "${prompt_fail_stderr}"
  exit 1
fi
rm -f "${prompt_fail_stderr}"

# Nested workflow/run: run inner.default then outer step
cp "${ROOT_DIR}/e2e/nested_inner.jh" "${WORK_DIR}/nested_inner.jh"
cp "${ROOT_DIR}/e2e/nested_run.jh" "${WORK_DIR}/nested_run.jh"
jaiph build "${WORK_DIR}/nested_run.jh"
nested_out="$(jaiph run "${WORK_DIR}/nested_run.jh")"
if [[ "${nested_out}" != *"PASS workflow default"* ]]; then
  echo "Expected nested_run.jh to PASS. Output was:" >&2
  printf '%s\n' "${nested_out}" >&2
  exit 1
fi
