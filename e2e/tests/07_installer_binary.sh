#!/usr/bin/env bash
#
# Acceptance for the binary installer rewrite (docs/install + docs/install-from-local.sh):
#   - Checksum mismatch → non-zero exit, nothing installed.
#   - Unsupported platform → non-zero exit with the documented message.
#   - Parity check: local-build install dir contains a single executable `jaiph`
#     (no shim script, no LIB_DIR/runtime tree) and works with node/npm/bun
#     absent from PATH (same self-contained installation as the release path).
#
# The download checksum/platform paths are network-free: they point the installer
# at a `file://` URL served from a local directory via JAIPH_RELEASE_BASE_URL
# and shim `uname` on a temporary PATH prefix.
#
# The parity step requires bun (the build:standalone target) and is skipped on
# CI hosts where bun is not available — same convention as 210_standalone_binary.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "installer_binary"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
INSTALL_SCRIPT="${ROOT_DIR}/docs/install"

# Pick a checksum tool that exists on the host (shasum on macOS; sha256sum on Linux).
if command -v sha256sum >/dev/null 2>&1; then
  host_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  host_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  e2e::skip "no sha256sum/shasum on host — skipping installer acceptance"
  exit 0
fi

# Resolve the target asset name from the host (matches the installer's mapping).
host_uname_s="$(uname -s)"
host_uname_m="$(uname -m)"
case "${host_uname_s}" in
  Darwin) HOST_OS="darwin" ;;
  Linux)  HOST_OS="linux" ;;
  *) e2e::skip "host platform ${host_uname_s} not supported by installer — skipping"; exit 0 ;;
esac
case "${host_uname_m}" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|x64)    HOST_ARCH="x64" ;;
  *) e2e::skip "host arch ${host_uname_m} not supported by installer — skipping"; exit 0 ;;
esac
HOST_BIN_NAME="jaiph-${HOST_OS}-${HOST_ARCH}"

# ── Checksum mismatch ────────────────────────────────────────────────────────

e2e::section "Checksum mismatch fails and installs nothing"

RELEASE_DIR="${TEST_DIR}/release-mismatch"
BIN_DIR_BAD="${TEST_DIR}/bin-mismatch"
mkdir -p "${RELEASE_DIR}" "${BIN_DIR_BAD}"

printf 'real-binary-bytes' > "${RELEASE_DIR}/${HOST_BIN_NAME}"
# Hand-craft SHA256SUMS with the wrong hash for HOST_BIN_NAME so the installer
# reaches the verify step and fails with a checksum mismatch (not an http 404).
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "${HOST_BIN_NAME}" \
  > "${RELEASE_DIR}/SHA256SUMS"

bad_status=0
# Unset JAIPH_REPO_URL: the shared e2e context points it at this repo root,
# which would otherwise trigger the local-source branch instead of download.
bad_output="$(
  unset JAIPH_REPO_URL
  JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR}" \
  JAIPH_BIN_DIR="${BIN_DIR_BAD}" \
  bash "${INSTALL_SCRIPT}" 2>&1
)" || bad_status=$?
e2e::assert_equals "${bad_status}" "1" "checksum mismatch exits non-zero"
# assert_contains: full message text includes ANSI colors and per-host hashes
e2e::assert_contains "${bad_output}" "Checksum mismatch" "checksum mismatch is reported"
if [ -e "${BIN_DIR_BAD}/jaiph" ]; then
  e2e::fail "installer left ${BIN_DIR_BAD}/jaiph on checksum failure"
fi
e2e::pass "checksum mismatch is non-recoverable and leaves no binary"

# ── Unsupported platform ──────────────────────────────────────────────────────

e2e::section "Unsupported platform exits with documented message"

FAKE_PATH_DIR="${TEST_DIR}/fake-uname"
BIN_DIR_UNSUPPORTED="${TEST_DIR}/bin-unsupported"
mkdir -p "${FAKE_PATH_DIR}" "${BIN_DIR_UNSUPPORTED}"

cat > "${FAKE_PATH_DIR}/uname" <<'FAKE_UNAME'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo "AIX" ;;
  -m) echo "powerpc" ;;
  *)  echo "AIX powerpc" ;;
esac
FAKE_UNAME
chmod +x "${FAKE_PATH_DIR}/uname"

unsupported_status=0
unsupported_output="$(
  unset JAIPH_REPO_URL
  PATH="${FAKE_PATH_DIR}:${PATH}" \
  JAIPH_BIN_DIR="${BIN_DIR_UNSUPPORTED}" \
  bash "${INSTALL_SCRIPT}" 2>&1
)" || unsupported_status=$?
e2e::assert_equals "${unsupported_status}" "1" "unsupported platform exits non-zero"
# assert_contains: ANSI codes and uname strings vary between OSes
e2e::assert_contains "${unsupported_output}" "Unsupported platform: AIX powerpc" \
  "error names the detected platform"
e2e::assert_contains "${unsupported_output}" "contributing" \
  "error points at the from-source instructions"
if [ -e "${BIN_DIR_UNSUPPORTED}/jaiph" ]; then
  e2e::fail "installer left a binary in ${BIN_DIR_UNSUPPORTED} on unsupported platform"
fi
e2e::pass "unsupported platform is non-recoverable and leaves no binary"

# ── Parity check (local install) ──────────────────────────────────────────────

if ! command -v bun >/dev/null 2>&1; then
  e2e::skip "bun not installed — skipping local install parity check"
  exit 0
fi

e2e::section "install-from-local.sh produces a single self-contained binary"

PARITY_BIN_DIR="${TEST_DIR}/bin-parity"
mkdir -p "${PARITY_BIN_DIR}"

# install-from-local.sh execs docs/install with the repo path. Cap the bin dir
# to a test-owned directory so we never touch ~/.local/bin.
JAIPH_BIN_DIR="${PARITY_BIN_DIR}" \
  bash "${ROOT_DIR}/docs/install-from-local.sh" "${ROOT_DIR}" >/dev/null

[ -x "${PARITY_BIN_DIR}/jaiph" ] || e2e::fail "install-from-local.sh did not produce ${PARITY_BIN_DIR}/jaiph"

# Single executable, no shim, no LIB_DIR/runtime tree.
entries="$(find "${PARITY_BIN_DIR}" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null \
  || find "${PARITY_BIN_DIR}" -mindepth 1 -maxdepth 1 -exec basename {} \;)"
if [ "$(printf '%s\n' "${entries}" | sort)" != "jaiph" ]; then
  printf 'Unexpected entries in %s:\n%s\n' "${PARITY_BIN_DIR}" "${entries}" >&2
  e2e::fail "install dir should contain only the jaiph executable"
fi
# The installed jaiph must be a real binary, not a `node …` shim script.
if head -c 2 "${PARITY_BIN_DIR}/jaiph" | grep -q '^#!'; then
  e2e::fail "installed jaiph is a shebang shim, not a self-contained binary"
fi
e2e::pass "install dir contains only the self-contained jaiph binary"

# Strip node/npm/bun from PATH and confirm --version and run still work.
CLEAN_PATH="/usr/bin:/bin"
for tool in node npm bun; do
  if PATH="${CLEAN_PATH}" command -v "${tool}" >/dev/null 2>&1; then
    e2e::fail "${tool} unexpectedly visible on stripped PATH (${CLEAN_PATH})"
  fi
done

WORK_DIR="${TEST_DIR}/parity-work"
mkdir -p "${WORK_DIR}"
cat > "${WORK_DIR}/sample.jh" <<'EOF'
script say_hello = `echo hello-from-local`
workflow default() {
  const msg = run say_hello()
  return "${msg}"
}
EOF

version_out="$(env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" "${PARITY_BIN_DIR}/jaiph" --version)"
expected_version="$(node -p "require('${ROOT_DIR}/package.json').version" 2>/dev/null || echo "")"
if [ -n "${expected_version}" ]; then
  e2e::assert_equals "${version_out}" "jaiph ${expected_version}" "jaiph --version without node/npm/bun"
else
  # assert_contains: package.json version not readable in this env
  e2e::assert_contains "${version_out}" "jaiph " "jaiph --version prints a version banner"
fi

run_out="$(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" JAIPH_UNSAFE=true "${PARITY_BIN_DIR}/jaiph" run sample.jh)"
case "${run_out}" in
  *"hello-from-local"*) e2e::pass "locally-built binary runs a workflow without node/npm/bun" ;;
  *) printf "%s\n" "${run_out}" >&2; e2e::fail "locally-built jaiph did not run sample.jh as expected" ;;
esac
