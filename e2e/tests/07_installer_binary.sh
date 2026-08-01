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

# ── Missing signature file (SHA256SUMS.minisig absent) ────────────────────────
#
# The installer must fail closed when the release is not accompanied by a
# detached signature file — regardless of whether minisign is installed.

e2e::section "Missing SHA256SUMS.minisig fails and installs nothing"

RELEASE_DIR_NOSIG="${TEST_DIR}/release-nosig"
BIN_DIR_NOSIG="${TEST_DIR}/bin-nosig"
mkdir -p "${RELEASE_DIR_NOSIG}" "${BIN_DIR_NOSIG}"

printf 'real-binary-bytes' > "${RELEASE_DIR_NOSIG}/${HOST_BIN_NAME}"
actual_sum="$(host_sha256 "${RELEASE_DIR_NOSIG}/${HOST_BIN_NAME}")"
printf '%s  %s\n' "${actual_sum}" "${HOST_BIN_NAME}" > "${RELEASE_DIR_NOSIG}/SHA256SUMS"
# SHA256SUMS.minisig is intentionally absent.

nosig_status=0
nosig_output="$(
  unset JAIPH_REPO_URL
  JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR_NOSIG}" \
  JAIPH_BIN_DIR="${BIN_DIR_NOSIG}" \
  bash "${INSTALL_SCRIPT}" 2>&1
)" || nosig_status=$?
e2e::assert_equals "${nosig_status}" "1" "missing SHA256SUMS.minisig exits non-zero"
# assert_contains: ANSI color codes in the output prevent full equality match
e2e::assert_contains "${nosig_output}" "SHA256SUMS.minisig" "error message names the missing signature file"
if [ -e "${BIN_DIR_NOSIG}/jaiph" ]; then
  e2e::fail "installer left ${BIN_DIR_NOSIG}/jaiph when signature file was absent"
fi
e2e::pass "missing signature file is non-recoverable and leaves no binary"

# ── Empty JAIPH_MINISIGN_PUBLIC_KEY fails closed (AC2) ────────────────────────
#
# An explicitly empty key is a misconfiguration: the installer must abort rather
# than fall back to the bundled key or skip verification. The check fires before
# the minisign-availability branch, so it holds regardless of minisign/CI.

e2e::section "empty JAIPH_MINISIGN_PUBLIC_KEY fails closed"

RELEASE_DIR_EK="${TEST_DIR}/release-emptykey"
BIN_DIR_EK="${TEST_DIR}/bin-emptykey"
mkdir -p "${RELEASE_DIR_EK}" "${BIN_DIR_EK}"
printf 'real-binary-bytes' > "${RELEASE_DIR_EK}/${HOST_BIN_NAME}"
ek_sum="$(host_sha256 "${RELEASE_DIR_EK}/${HOST_BIN_NAME}")"
printf '%s  %s\n' "${ek_sum}" "${HOST_BIN_NAME}" > "${RELEASE_DIR_EK}/SHA256SUMS"
printf 'placeholder-sig\n' > "${RELEASE_DIR_EK}/SHA256SUMS.minisig"

ek_status=0
ek_output="$(
  unset JAIPH_REPO_URL
  JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR_EK}" \
  JAIPH_BIN_DIR="${BIN_DIR_EK}" \
  JAIPH_MINISIGN_PUBLIC_KEY="" \
  bash "${INSTALL_SCRIPT}" 2>&1
)" || ek_status=$?
e2e::assert_equals "${ek_status}" "1" "empty minisign key exits non-zero"
# assert_contains: output carries ANSI color codes around the message
e2e::assert_contains "${ek_output}" "JAIPH_MINISIGN_PUBLIC_KEY is empty" "reports the empty-key misconfiguration"
if [ -e "${BIN_DIR_EK}/jaiph" ]; then
  e2e::fail "installer left a binary when the signing key was empty"
fi
e2e::pass "empty minisign key is fail-closed"

# ── minisign unavailable on a non-CI host fails closed (AC1) ──────────────────
#
# With minisign absent and no CI/opt-out signal, checksum-only is not acceptable
# (the checksum ships over the same channel as the binary), so the installer
# must abort. We force "minisign unavailable" via a restricted PATH.

e2e::section "minisign unavailable on a non-CI host fails closed"

RESTRICTED_PATH="/usr/bin:/bin"
if PATH="${RESTRICTED_PATH}" command -v minisign >/dev/null 2>&1; then
  e2e::skip "minisign resolvable on the restricted PATH — cannot force it unavailable"
else
  RELEASE_DIR_NM="${TEST_DIR}/release-nominisign"
  BIN_DIR_NM="${TEST_DIR}/bin-nominisign"
  mkdir -p "${RELEASE_DIR_NM}" "${BIN_DIR_NM}"
  printf 'real-binary-bytes' > "${RELEASE_DIR_NM}/${HOST_BIN_NAME}"
  nm_sum="$(host_sha256 "${RELEASE_DIR_NM}/${HOST_BIN_NAME}")"
  printf '%s  %s\n' "${nm_sum}" "${HOST_BIN_NAME}" > "${RELEASE_DIR_NM}/SHA256SUMS"
  printf 'placeholder-sig\n' > "${RELEASE_DIR_NM}/SHA256SUMS.minisig"

  nm_status=0
  nm_output="$(
    unset JAIPH_REPO_URL
    env -u CI -u JAIPH_ALLOW_UNSIGNED \
      PATH="${RESTRICTED_PATH}" \
      JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR_NM}" \
      JAIPH_BIN_DIR="${BIN_DIR_NM}" \
      bash "${INSTALL_SCRIPT}" 2>&1
  )" || nm_status=$?
  e2e::assert_equals "${nm_status}" "1" "non-CI install without minisign exits non-zero"
  # assert_contains: output carries ANSI color codes around the message
  e2e::assert_contains "${nm_output}" "minisign is required" "reports mandatory signature verification"
  if [ -e "${BIN_DIR_NM}/jaiph" ]; then
    e2e::fail "installer left a binary when signature verification was impossible"
  fi
  e2e::pass "minisign unavailable on a non-CI host is fail-closed"

  # The same host with JAIPH_ALLOW_UNSIGNED=1 opts back into checksum-only and
  # proceeds past the signature step (reaching the checksum, which matches here).
  e2e::section "JAIPH_ALLOW_UNSIGNED=1 opts back into checksum-only"
  BIN_DIR_OPT="${TEST_DIR}/bin-optout"
  mkdir -p "${BIN_DIR_OPT}"
  opt_status=0
  opt_output="$(
    unset JAIPH_REPO_URL
    env -u CI \
      PATH="${RESTRICTED_PATH}" \
      JAIPH_ALLOW_UNSIGNED=1 \
      JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR_NM}" \
      JAIPH_BIN_DIR="${BIN_DIR_OPT}" \
      bash "${INSTALL_SCRIPT}" 2>&1
  )" || opt_status=$?
  # The staged "binary" is not a real jaiph, so `--version` fails at the very
  # end — but signature/checksum verification is passed (that is what we assert).
  # assert_contains: verifies the checksum-only warning surfaced.
  e2e::assert_contains "${opt_output}" "proceeding on checksum only" "opt-out warning is shown"
  e2e::pass "JAIPH_ALLOW_UNSIGNED=1 bypasses the mandatory-signature abort"

  # ── CI=true no longer downgrades to checksum-only (AC1, finding M-5) ─────────
  #
  # The whole point of M-5: with CI set (the state of every GitHub runner) but
  # no JAIPH_ALLOW_UNSIGNED opt-in, a missing minisign must abort — not fall back
  # to checksum-only. This is the regression test that fails if `CI` is ever
  # re-added as a silent opt-out.
  e2e::section "CI=true with no JAIPH_ALLOW_UNSIGNED fails closed (no checksum-only downgrade)"
  BIN_DIR_CI="${TEST_DIR}/bin-ci"
  mkdir -p "${BIN_DIR_CI}"
  ci_status=0
  ci_output="$(
    unset JAIPH_REPO_URL
    env -u JAIPH_ALLOW_UNSIGNED \
      CI=true \
      PATH="${RESTRICTED_PATH}" \
      JAIPH_RELEASE_BASE_URL="file://${RELEASE_DIR_NM}" \
      JAIPH_BIN_DIR="${BIN_DIR_CI}" \
      bash "${INSTALL_SCRIPT}" 2>&1
  )" || ci_status=$?
  e2e::assert_equals "${ci_status}" "1" "CI install without minisign exits non-zero"
  # assert_contains: output carries ANSI color codes around the message
  e2e::assert_contains "${ci_output}" "minisign is required" "reports mandatory signature verification under CI"
  if [ -e "${BIN_DIR_CI}/jaiph" ]; then
    e2e::fail "installer left a binary under CI when signature verification was impossible"
  fi
  e2e::pass "CI=true is not a checksum-only opt-out"
fi

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
# The installer verifies the detached signature BEFORE the checksum, so a bogus
# signature would fail first and never reach the checksum step. To exercise the
# checksum path, sign the (tampered) SHA256SUMS with a throwaway key and hand the
# installer its matching public key. When minisign is absent, signature
# verification is now mandatory (fail-closed), so JAIPH_ALLOW_UNSIGNED=1 opts
# into checksum-only and lets the mismatch below be the failure under test.
TEST_PUBKEY=""
if command -v minisign >/dev/null 2>&1; then
  minisign -G -W -p "${RELEASE_DIR}/test.pub" -s "${RELEASE_DIR}/test.key" >/dev/null 2>&1
  minisign -S -s "${RELEASE_DIR}/test.key" -m "${RELEASE_DIR}/SHA256SUMS" >/dev/null 2>&1
  TEST_PUBKEY="$(tail -n 1 "${RELEASE_DIR}/test.pub")"
else
  printf 'placeholder-sig\n' > "${RELEASE_DIR}/SHA256SUMS.minisig"
fi

bad_status=0
# Unset JAIPH_REPO_URL: the shared e2e context points it at this repo root,
# which would otherwise trigger the local-source branch instead of download.
# JAIPH_ALLOW_UNSIGNED=1: harmless when minisign is present (the real signature
# is verified regardless); required when absent so the run reaches the checksum.
# JAIPH_MINISIGN_PUBLIC_KEY: only overridden when minisign produced a real
# throwaway key above. When minisign is absent, TEST_PUBKEY is empty — passing
# that explicitly would trip the installer's empty-key fail-closed guard (AC2)
# before the checksum step is ever reached, so leave the variable unset and let
# JAIPH_ALLOW_UNSIGNED=1 carry the run past the (skipped) signature step instead.
bad_output="$(
  unset JAIPH_REPO_URL
  if [ -n "${TEST_PUBKEY}" ]; then
    export JAIPH_MINISIGN_PUBLIC_KEY="${TEST_PUBKEY}"
  else
    unset JAIPH_MINISIGN_PUBLIC_KEY
  fi
  JAIPH_ALLOW_UNSIGNED=1 \
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
  JAIPH_SKIP_DOCKER_BUILD=1 \
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

# Unsafe host-only runs now require consent; JAIPH_INPLACE_YES auto-confirms non-interactively.
run_out="$(cd "${WORK_DIR}" && env -i PATH="${CLEAN_PATH}" HOME="${WORK_DIR}" JAIPH_UNSAFE=true JAIPH_INPLACE_YES=1 "${PARITY_BIN_DIR}/jaiph" run sample.jh)"
case "${run_out}" in
  *"hello-from-local"*) e2e::pass "locally-built binary runs a workflow without node/npm/bun" ;;
  *) printf "%s\n" "${run_out}" >&2; e2e::fail "locally-built jaiph did not run sample.jh as expected" ;;
esac

# ── Reinstall over an in-use binary (macOS inode overwrite regression) ────────

e2e::section "reinstall over existing jaiph while a child holds the old mapping"

REINSTALL_BIN_DIR="${TEST_DIR}/bin-reinstall"
mkdir -p "${REINSTALL_BIN_DIR}"

JAIPH_BIN_DIR="${REINSTALL_BIN_DIR}" \
  JAIPH_SKIP_DOCKER_BUILD=1 \
  bash "${ROOT_DIR}/docs/install-from-local.sh" "${ROOT_DIR}" >/dev/null

[ -x "${REINSTALL_BIN_DIR}/jaiph" ] || e2e::fail "initial install did not produce ${REINSTALL_BIN_DIR}/jaiph"

# Hold the old binary mapped while we reinstall on top of the same path.
"${REINSTALL_BIN_DIR}/jaiph" --version >/dev/null &
held_pid=$!
sleep 0.2

JAIPH_BIN_DIR="${REINSTALL_BIN_DIR}" \
  JAIPH_SKIP_DOCKER_BUILD=1 \
  bash "${ROOT_DIR}/docs/install-from-local.sh" "${ROOT_DIR}" >/dev/null

wait "${held_pid}" 2>/dev/null || true

reinstall_version="$("${REINSTALL_BIN_DIR}/jaiph" --version 2>&1)" || reinstall_status=$?
reinstall_status="${reinstall_status:-0}"
if [ "${reinstall_status}" -ne 0 ]; then
  printf 'reinstall left jaiph unexecutable (exit %s): %s\n' "${reinstall_status}" "${reinstall_version}" >&2
  e2e::fail "reinstall over in-use jaiph must leave a runnable binary at the same path"
fi
e2e::pass "reinstall over in-use jaiph leaves a runnable binary"

# ── Install path guards ───────────────────────────────────────────────────────

if ! command -v bun >/dev/null 2>&1; then
  e2e::skip "bun not installed — skipping install path guard checks"
else

e2e::section "installer refuses system bin directories"

system_status=0
system_output="$(
  JAIPH_BIN_DIR="/usr/bin" \
  JAIPH_SKIP_DOCKER_BUILD=1 \
  bash "${ROOT_DIR}/docs/install-from-local.sh" "${ROOT_DIR}" 2>&1
)" || system_status=$?
e2e::assert_equals "${system_status}" "1" "system bin dir exits non-zero"
e2e::assert_contains "${system_output}" "Refusing to install into system directory /usr/bin" \
  "reports blocked system directory"
if [ -e "/usr/bin/jaiph" ]; then
  e2e::fail "installer must not create /usr/bin/jaiph"
fi
e2e::pass "system bin directory is rejected"

e2e::section "installer refuses when target path is a directory"

DIR_TARGET_BIN="${TEST_DIR}/bin-dir-target"
mkdir -p "${DIR_TARGET_BIN}/jaiph"

dir_status=0
dir_output="$(
  JAIPH_BIN_DIR="${DIR_TARGET_BIN}" \
  JAIPH_SKIP_DOCKER_BUILD=1 \
  bash "${ROOT_DIR}/docs/install-from-local.sh" "${ROOT_DIR}" 2>&1
)" || dir_status=$?
e2e::assert_equals "${dir_status}" "1" "directory target exits non-zero"
e2e::assert_contains "${dir_output}" "Refusing to replace directory" \
  "reports blocked directory target"
[ -d "${DIR_TARGET_BIN}/jaiph" ] || e2e::fail "directory target must remain a directory"
e2e::pass "directory target is not removed"

fi
