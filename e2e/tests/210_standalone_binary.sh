#!/usr/bin/env bash
#
# Verifies the bun --compile standalone binary is fully self-contained:
#   - works from any directory with no repo checkout,
#   - has no node/npm/bun on PATH,
#   - successfully runs `--version`, `init`, `compile`, and `run` against a
#     deterministic sample workflow.
#
# Skipped (not failed) when `bun` is unavailable on the host so the rest of
# the e2e suite still runs on CI images that ship only node.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "standalone_binary"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v bun >/dev/null 2>&1; then
  e2e::skip "bun not installed — skipping standalone binary self-contained check"
  exit 0
fi

e2e::section "Build standalone binary"
(cd "${ROOT_DIR}" && npm run build:standalone >/dev/null)
[[ -x "${ROOT_DIR}/dist/jaiph" ]] || e2e::fail "dist/jaiph missing after build:standalone"
e2e::pass "dist/jaiph built"

# Stage the binary in an isolated dir; deliberately copy only `jaiph` —
# no sibling `runtime/` or `docs/` so we prove the assets are embedded.
STAGE_DIR="${TEST_DIR}/stage"
mkdir -p "${STAGE_DIR}"
cp "${ROOT_DIR}/dist/jaiph" "${STAGE_DIR}/jaiph"
chmod +x "${STAGE_DIR}/jaiph"

# Strip node/npm/bun from PATH. /usr/bin:/bin is enough for the shell builtins
# the test relies on (bash, mkdir, cat, etc.).
CLEAN_PATH="/usr/bin:/bin"
for tool in node npm bun; do
  if PATH="${CLEAN_PATH}" command -v "${tool}" >/dev/null 2>&1; then
    e2e::fail "${tool} unexpectedly visible on stripped PATH (${CLEAN_PATH})"
  fi
done
e2e::pass "stripped PATH has no node/npm/bun"

WORK_DIR="${TEST_DIR}/work"
mkdir -p "${WORK_DIR}"
JAIPH_BIN="${STAGE_DIR}/jaiph"

# Deterministic sample workflow: no prompts, no network — runs to completion.
cat > "${WORK_DIR}/sample.jh" <<'EOF'
script say_hello = `echo hello-standalone`
workflow default() {
  const msg = run say_hello()
  return "${msg}"
}
EOF

e2e::section "jaiph --version"
version_out="$(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" "${JAIPH_BIN}" --version)"
e2e::assert_equals "${version_out}" "jaiph 0.9.4" "version output"

e2e::section "jaiph init writes SKILL.md from embedded asset"
(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" "${JAIPH_BIN}" init >/dev/null)
SKILL_PATH="${WORK_DIR}/.jaiph/SKILL.md"
[[ -s "${SKILL_PATH}" ]] || e2e::fail "SKILL.md missing or empty after init"
# Embedded copy must match docs/jaiph-skill.md byte-for-byte.
e2e::assert_equals \
  "$(cat "${SKILL_PATH}")" \
  "$(cat "${ROOT_DIR}/docs/jaiph-skill.md")" \
  "SKILL.md matches docs/jaiph-skill.md"

e2e::section "jaiph compile sample.jh"
(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" "${JAIPH_BIN}" compile sample.jh)
e2e::pass "compile sample.jh exits 0"

e2e::section "jaiph run sample.jh"
run_out="$(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" JAIPH_UNSAFE=true "${JAIPH_BIN}" run sample.jh)"
case "${run_out}" in
  *"hello-standalone"*) e2e::pass "run sample.jh prints captured echo" ;;
  *) printf "%s\n" "${run_out}" >&2; e2e::fail "run sample.jh did not produce expected output" ;;
esac
