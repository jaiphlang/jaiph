#!/usr/bin/env bash
#
# Acceptance for runtime/fetch-verify.sh — the single fail-closed download+verify
# seam every toolchain fetch in runtime/Dockerfile goes through (finding M-11).
# The Dockerfile requires a non-empty SHA-256 per fetch and verifies it; this
# test exercises that contract at the helper level (fast, offline, host-only):
#   - empty checksum        -> refuses to fetch (build would fail)
#   - mismatched checksum   -> aborts and removes the download (build would fail)
#   - correct checksum      -> succeeds and leaves the verified file in place
#
# It also asserts every toolchain fetch in the Dockerfile routes through the
# helper with a non-empty pinned checksum, so a future edit that reintroduces an
# unverified or empty-default fetch fails here.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "dockerfile_fetch_verify"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

HELPER="${ROOT_DIR}/runtime/fetch-verify.sh"

if command -v sha256sum >/dev/null 2>&1; then
  host_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  host_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  e2e::skip "no sha256sum/shasum on host — skipping fetch-verify acceptance"
  exit 0
fi

SRC="${TEST_DIR}/payload"
printf 'verified-toolchain-bytes' > "${SRC}"
GOOD_SHA="$(host_sha256 "${SRC}")"
URL="file://${SRC}"

# ── Empty checksum fails closed ───────────────────────────────────────────────

e2e::section "fetch-verify refuses an empty checksum"

DEST="${TEST_DIR}/out-empty"
empty_status=0
empty_out="$(bash "${HELPER}" "${URL}" "${DEST}" "" 2>&1)" || empty_status=$?
e2e::assert_equals "${empty_status}" "1" "empty checksum exits non-zero"
e2e::assert_contains "${empty_out}" "without a pinned sha256" "reports the required-checksum policy"
if [ -e "${DEST}" ]; then
  e2e::fail "fetch-verify wrote a file for an empty checksum"
fi
e2e::pass "empty checksum is fail-closed"

# ── Mismatched checksum fails closed ──────────────────────────────────────────

e2e::section "fetch-verify rejects a mismatched checksum"

DEST="${TEST_DIR}/out-bad"
bad_status=0
bad_out="$(bash "${HELPER}" "${URL}" "${DEST}" \
  "0000000000000000000000000000000000000000000000000000000000000000" 2>&1)" || bad_status=$?
e2e::assert_equals "${bad_status}" "1" "mismatched checksum exits non-zero"
e2e::assert_contains "${bad_out}" "sha256 mismatch" "reports the mismatch"
if [ -e "${DEST}" ]; then
  e2e::fail "fetch-verify left the download after a checksum mismatch"
fi
e2e::pass "mismatched checksum is fail-closed and leaves no file"

# ── Correct checksum succeeds ─────────────────────────────────────────────────

e2e::section "fetch-verify accepts a matching checksum"

DEST="${TEST_DIR}/out-good"
ok_status=0
bash "${HELPER}" "${URL}" "${DEST}" "${GOOD_SHA}" || ok_status=$?
e2e::assert_equals "${ok_status}" "0" "matching checksum exits zero"
if [ ! -f "${DEST}" ]; then
  e2e::fail "fetch-verify did not leave the verified file in place"
fi
e2e::assert_equals "$(cat "${DEST}")" "verified-toolchain-bytes" "verified file has the expected content"
e2e::pass "matching checksum installs the verified file"

# ── Every Dockerfile toolchain fetch is pinned and verified ───────────────────

e2e::section "runtime/Dockerfile pins every toolchain fetch through fetch-verify.sh"

DOCKERFILE="${ROOT_DIR}/runtime/Dockerfile"

# No toolchain may be fetched with a bare curl download (the pattern the finding
# flagged). Every network fetch of an installer/binary goes through the helper.
stray="$(grep -nE '^\s*(curl|wget)[^|]*(astral\.sh|rustup|bun\.sh|cursor\.com|go\.dev/dl|mikefarah/yq|dl\.k8s\.io|awscli\.amazonaws\.com|go-task/task)' "${DOCKERFILE}" || true)"
if [ -n "${stray}" ]; then
  printf 'Unverified toolchain fetch(es) in Dockerfile:\n%s\n' "${stray}" >&2
  e2e::fail "every toolchain fetch must route through fetch-verify.sh"
fi
e2e::pass "no bare toolchain downloads remain"

# Each checksum ARG must ship a non-empty default (an empty default would let a
# plain `docker build` degrade to no verification).
for arg in UV_INSTALL_SHA256 RUSTUP_INIT_SHA256 BUN_INSTALL_SHA256 CURSOR_INSTALL_SHA256 \
           GO_SHA256_AMD64 GO_SHA256_ARM64 YQ_SHA256_AMD64 YQ_SHA256_ARM64 \
           KUBECTL_SHA256_AMD64 KUBECTL_SHA256_ARM64 AWSCLI_SHA256_X86_64 AWSCLI_SHA256_AARCH64 \
           TASK_SHA256_AMD64 TASK_SHA256_ARM64; do
  if ! grep -qE "^ARG ${arg}=[0-9a-f]{64}\$" "${DOCKERFILE}"; then
    e2e::fail "Dockerfile ARG ${arg} must default to a non-empty 64-hex sha256"
  fi
done
e2e::pass "all toolchain checksum ARGs carry a pinned non-empty default"
