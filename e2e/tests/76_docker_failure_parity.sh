#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_failure_parity"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker failure parity (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker failure parity tests"
  exit 0
fi

# Build a local test image with jaiph installed from current source.
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker failure parity (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# Normalize a failure footer for full-output equality between docker and
# no-sandbox modes. Strips ANSI, collapses timing values, and rewrites the
# mode-specific runs root + sandbox tmpdir to a stable token so paths align.
e2e::norm_footer() {
  local input="$1"
  local nosandbox_runs="$2"
  local docker_runs="$3"
  printf "%s" "${input}" \
    | sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g' \
    | sed -E 's/^(Jaiph: Running [^ ]+) \(.+\)$/\1/' \
    | sed -E 's/\(([0-9]+(\.[0-9]+)?s|[0-9]+m [0-9]+s)\)/(<time>)/g' \
    | sed -E 's/\(([0-9]+(\.[0-9]+)?s|[0-9]+m [0-9]+s) failed\)/(<time> failed)/g' \
    | sed -E 's/✓ ([0-9]+)(\.[0-9]+)?s/✓ <time>/g' \
    | sed -E 's/✗ ([0-9]+)(\.[0-9]+)?s/✗ <time>/g' \
    | sed -E "s|${nosandbox_runs}|<RUNS>|g" \
    | sed -E "s|${docker_runs}|<RUNS>|g" \
    | sed -E 's|<RUNS>/[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{2}-[0-9]{2}-[0-9]{2}-|<RUNS>/<DATE>/<TIME>-|g' \
    | sed -E 's/[[:space:]]+$//g'
}

e2e::expect_parity() {
  local label="$1"
  local nosandbox_err="$2"
  local docker_err="$3"
  local nosandbox_runs="$4"
  local docker_runs="$5"

  local norm_nosandbox norm_docker
  norm_nosandbox="$(e2e::norm_footer "${nosandbox_err}" "${nosandbox_runs}" "${docker_runs}")"
  norm_docker="$(e2e::norm_footer "${docker_err}" "${nosandbox_runs}" "${docker_runs}")"

  if [[ "${norm_nosandbox}" != "${norm_docker}" ]]; then
    {
      printf 'docker vs no-sandbox stderr differ for %s\n' "${label}"
      printf '─── no-sandbox (normalized) ───\n%s\n' "${norm_nosandbox}"
      printf '─── docker (normalized) ───\n%s\n' "${norm_docker}"
      printf '─── diff ───\n'
      diff <(printf '%s\n' "${norm_nosandbox}") <(printf '%s\n' "${norm_docker}") || true
    } >&2
    e2e::fail "${label}: full output parity"
  fi
  e2e::pass "${label}: full output parity (docker == no-sandbox after normalization)"
}

run_workflow_capture() {
  local mode="$1"   # "nosandbox" or "docker"
  local file="$2"
  local runs_dir="$3"
  shift 3
  local err
  err="$(mktemp)"
  rm -rf "${runs_dir}"
  if [[ "${mode}" == "nosandbox" ]]; then
    if JAIPH_UNSAFE=true JAIPH_RUNS_DIR="${runs_dir}" jaiph run "${file}" "$@" 2>"${err}" >/dev/null; then
      cat "${err}" >&2
      rm -f "${err}"
      e2e::fail "no-sandbox: ${file} should have failed"
    fi
  else
    if JAIPH_DOCKER_ENABLED=true \
       JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
       JAIPH_RUNS_DIR="${runs_dir}" \
       jaiph run "${file}" "$@" 2>"${err}" >/dev/null; then
      cat "${err}" >&2
      rm -f "${err}"
      e2e::fail "docker: ${file} should have failed"
    fi
  fi
  cat "${err}"
  rm -f "${err}"
}

# ─────────────────────────────────────────────────────────────────────────
# Scenario A: script-step failure (validate_name exits 1)
# ─────────────────────────────────────────────────────────────────────────

e2e::section "docker vs no-sandbox: script-step failure produces identical footer"

e2e::file "fail_script.jh" <<'EOF'
script validate_name = ```
if [ -z "$1" ]; then
  echo "You didn't provide your name :(" >&2
  exit 1
fi
```

rule name_was_provided(name) {
  run validate_name(name)
}

workflow default(name) {
  ensure name_was_provided(name)
}
EOF

NS_RUNS_A="${TEST_DIR}/runs_nosandbox_a"
DK_RUNS_A="${TEST_DIR}/runs_docker_a"
ns_err_a="$(run_workflow_capture nosandbox "${TEST_DIR}/fail_script.jh" "${NS_RUNS_A}")"
dk_err_a="$(run_workflow_capture docker    "${TEST_DIR}/fail_script.jh" "${DK_RUNS_A}")"

e2e::expect_parity "script-step failure" "${ns_err_a}" "${dk_err_a}" "${NS_RUNS_A}" "${DK_RUNS_A}"

# Verify Docker paths point at the host filesystem (no container path leak)
if echo "${dk_err_a}" | grep -q '/jaiph/run/'; then
  printf 'docker stderr contains container path /jaiph/run/:\n%s\n' "${dk_err_a}" >&2
  e2e::fail "docker (script): footer must not contain container-internal paths"
fi
e2e::pass "docker (script): no container-internal /jaiph/run/ paths leaked"

# Verify artifact files exist at the paths shown in the Docker footer
docker_run_dir_a="$(e2e::run_dir_at "${DK_RUNS_A}" "fail_script.jh")"
e2e::assert_file_exists "${docker_run_dir_a}run_summary.jsonl" "docker (script): run_summary.jsonl exists on host"

# ─────────────────────────────────────────────────────────────────────────
# Scenario B: rule-fail via match `fail "..."` (no script step at all)
# This is the path the user actually hit (validate via match arm).
# ─────────────────────────────────────────────────────────────────────────

e2e::section "docker vs no-sandbox: match-fail in rule produces identical footer"

e2e::file "fail_rule.jh" <<'EOF'
rule name_was_provided(name) {
  match name {
    "" => fail "You didn't provide your name :("
    _  => name
  }
}

workflow default(name) {
  ensure name_was_provided(name)
}
EOF

NS_RUNS_B="${TEST_DIR}/runs_nosandbox_b"
DK_RUNS_B="${TEST_DIR}/runs_docker_b"
ns_err_b="$(run_workflow_capture nosandbox "${TEST_DIR}/fail_rule.jh" "${NS_RUNS_B}")"
dk_err_b="$(run_workflow_capture docker    "${TEST_DIR}/fail_rule.jh" "${DK_RUNS_B}")"

e2e::expect_parity "rule match-fail" "${ns_err_b}" "${dk_err_b}" "${NS_RUNS_B}" "${DK_RUNS_B}"

if echo "${dk_err_b}" | grep -q '/jaiph/run/'; then
  printf 'docker stderr contains container path /jaiph/run/:\n%s\n' "${dk_err_b}" >&2
  e2e::fail "docker (rule): footer must not contain container-internal paths"
fi
e2e::pass "docker (rule): no container-internal /jaiph/run/ paths leaked"

# Sanity: footer must surface artifacts (the empty-footer regression we are
# guarding against would skip these entirely).
e2e::assert_contains "${dk_err_b}" "Logs: " "docker (rule): footer has Logs: line"
e2e::assert_contains "${dk_err_b}" "Summary: " "docker (rule): footer has Summary: line"
e2e::assert_contains "${dk_err_b}" "err: " "docker (rule): footer has err: path"
e2e::assert_contains "${dk_err_b}" "You didn't provide your name :(" \
  "docker (rule): failed-step output is rendered"

docker_run_dir_b="$(e2e::run_dir_at "${DK_RUNS_B}" "fail_rule.jh")"
e2e::assert_file_exists "${docker_run_dir_b}run_summary.jsonl" "docker (rule): run_summary.jsonl exists on host"
