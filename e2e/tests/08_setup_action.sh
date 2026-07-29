#!/usr/bin/env bash
#
# Acceptance for the setup-jaiph GitHub Action (actions/setup-jaiph):
#   - Installs the requested version onto a runner bin dir and leaves `jaiph`
#     runnable there; appends that dir to $GITHUB_PATH for later steps.
#   - Resolves the `version` input to a release ref: bare semver -> v<semver>,
#     an explicit tag (v0.11.0) is kept as-is, and 'nightly' stays 'nightly'.
#   - Fails closed (non-zero, nothing installed, $GITHUB_PATH untouched) on a
#     checksum mismatch or a missing release artifact — inheriting docs/install.
#
# Network-free: the action's entrypoint runs the real docs/install pointed at a
# `file://` mock release via JAIPH_RELEASE_BASE_URL, with a fake `jaiph` binary
# that answers `--version`. When minisign is on the host, SHA256SUMS is signed
# with a throwaway key whose public key is handed to the installer (docs/install
# resolves an empty key back to the real project key, so it cannot be blanked);
# without minisign a placeholder signature is enough. Fail-closed on a missing
# .minisig is already covered by 07_installer_binary.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "setup_action"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
SETUP_SCRIPT="${ROOT_DIR}/actions/setup-jaiph/setup.sh"

if command -v sha256sum >/dev/null 2>&1; then
  host_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  host_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  e2e::skip "no sha256sum/shasum on host — skipping setup-action acceptance"
  exit 0
fi

case "$(uname -s)" in
  Darwin) HOST_OS="darwin" ;;
  Linux)  HOST_OS="linux" ;;
  *) e2e::skip "host platform not supported by installer — skipping"; exit 0 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|x64)    HOST_ARCH="x64" ;;
  *) e2e::skip "host arch not supported by installer — skipping"; exit 0 ;;
esac
HOST_BIN_NAME="jaiph-${HOST_OS}-${HOST_ARCH}"

FAKE_VERSION="jaiph 9.9.9-e2e"

# Sign a release's SHA256SUMS so docs/install's signature step passes. The
# installer verifies the detached signature BEFORE the checksum, so both the
# valid and tampered-checksum releases must be signed to reach later steps.
# Sets REL_PUBKEY to the matching public key (empty when minisign is absent,
# in which case the installer skips verification against a placeholder sig).
REL_PUBKEY=""
sign_release() {
  local dir="$1"
  if command -v minisign >/dev/null 2>&1; then
    rm -f "${dir}/test.pub" "${dir}/test.key"
    minisign -G -W -p "${dir}/test.pub" -s "${dir}/test.key" >/dev/null 2>&1
    minisign -S -s "${dir}/test.key" -m "${dir}/SHA256SUMS" >/dev/null 2>&1
    REL_PUBKEY="$(tail -n 1 "${dir}/test.pub")"
  else
    printf 'placeholder-sig\n' > "${dir}/SHA256SUMS.minisig"
    REL_PUBKEY=""
  fi
}

# Build a mock release: a fake `jaiph` binary that answers --version, a correct
# SHA256SUMS, and a signature covering it.
make_release() {
  local dir="$1"
  mkdir -p "${dir}"
  cat > "${dir}/${HOST_BIN_NAME}" <<EOF
#!/usr/bin/env bash
echo "${FAKE_VERSION}"
EOF
  local sum
  sum="$(host_sha256 "${dir}/${HOST_BIN_NAME}")"
  printf '%s  %s\n' "${sum}" "${HOST_BIN_NAME}" > "${dir}/SHA256SUMS"
  sign_release "${dir}"
}

# Run the action entrypoint against a mock release, using REL_PUBKEY for the
# signature key. Args: version, bin_dir, release_dir, github_path, github_output.
# Echoes combined output; returns the entrypoint's exit status.
run_setup() {
  local version="$1" bin_dir="$2" release_dir="$3" gh_path="$4" gh_out="$5"
  INPUT_VERSION="${version}" \
  JAIPH_BIN_DIR="${bin_dir}" \
  JAIPH_RELEASE_BASE_URL="file://${release_dir}" \
  JAIPH_MINISIGN_PUBLIC_KEY="${REL_PUBKEY}" \
  GITHUB_PATH="${gh_path}" \
  GITHUB_OUTPUT="${gh_out}" \
  bash "${SETUP_SCRIPT}" 2>&1
}

# ── Happy path: bare semver installs and lands on GITHUB_PATH ──────────────────

e2e::section "version input installs jaiph and exposes it on GITHUB_PATH"

RELEASE_OK="${TEST_DIR}/release-ok"
BIN_OK="${TEST_DIR}/bin-ok"
GH_PATH_OK="${TEST_DIR}/github_path"
GH_OUT_OK="${TEST_DIR}/github_output"
: > "${GH_PATH_OK}"
: > "${GH_OUT_OK}"
make_release "${RELEASE_OK}"

ok_status=0
ok_output="$(run_setup "0.11.0" "${BIN_OK}" "${RELEASE_OK}" "${GH_PATH_OK}" "${GH_OUT_OK}")" || ok_status=$?
e2e::assert_equals "${ok_status}" "0" "setup entrypoint succeeds for a valid release"
# assert_contains: full output includes the installer's ANSI-colored progress.
e2e::assert_contains "${ok_output}" "resolved version '0.11.0' to release ref 'v0.11.0'" \
  "bare semver resolves to a v-prefixed release tag"

e2e::assert_file_executable "${BIN_OK}/jaiph" "installed jaiph is executable"
installed_version="$("${BIN_OK}/jaiph" --version)"
e2e::assert_equals "${installed_version}" "${FAKE_VERSION}" "installed jaiph reports the requested version"
# The install dir is appended to GITHUB_PATH verbatim (one line, no extras).
e2e::assert_equals "$(<"${GH_PATH_OK}")" "${BIN_OK}" "install dir is appended to GITHUB_PATH"
# assert_contains: GITHUB_OUTPUT accumulates key=value lines from the step.
e2e::assert_contains "$(<"${GH_OUT_OK}")" "version=${FAKE_VERSION}" "resolved version is written to GITHUB_OUTPUT"
e2e::pass "valid version installs and is exposed for later steps"

# ── Ref resolution: explicit tag and nightly ──────────────────────────────────

e2e::section "explicit tag and nightly resolve to the matching release ref"

tag_status=0
tag_output="$(run_setup "v0.11.0" "${TEST_DIR}/bin-tag" "${RELEASE_OK}" "${TEST_DIR}/gh_path_tag" "${TEST_DIR}/gh_out_tag")" || tag_status=$?
e2e::assert_equals "${tag_status}" "0" "explicit tag input succeeds"
# assert_contains: full output includes the installer's ANSI-colored progress.
e2e::assert_contains "${tag_output}" "resolved version 'v0.11.0' to release ref 'v0.11.0'" \
  "an explicit v-tag is used as-is"

nightly_status=0
nightly_output="$(run_setup "nightly" "${TEST_DIR}/bin-nightly" "${RELEASE_OK}" "${TEST_DIR}/gh_path_nightly" "${TEST_DIR}/gh_out_nightly")" || nightly_status=$?
e2e::assert_equals "${nightly_status}" "0" "nightly input succeeds"
# assert_contains: full output includes the installer's ANSI-colored progress.
e2e::assert_contains "${nightly_output}" "resolved version 'nightly' to release ref 'nightly'" \
  "nightly stays on the nightly ref"
e2e::pass "version input maps to the expected release refs"

# ── Fail closed: checksum mismatch ────────────────────────────────────────────

e2e::section "checksum mismatch fails the step and installs nothing"

RELEASE_BAD="${TEST_DIR}/release-bad"
BIN_BAD="${TEST_DIR}/bin-bad"
GH_PATH_BAD="${TEST_DIR}/github_path_bad"
mkdir -p "${RELEASE_BAD}"
: > "${GH_PATH_BAD}"
printf 'real-binary-bytes' > "${RELEASE_BAD}/${HOST_BIN_NAME}"
# Wrong hash so the installer reaches the checksum step and fails there. Sign the
# tampered SHA256SUMS so the earlier signature step passes (verified first).
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "${HOST_BIN_NAME}" \
  > "${RELEASE_BAD}/SHA256SUMS"
sign_release "${RELEASE_BAD}"

bad_status=0
bad_output="$(run_setup "0.11.0" "${BIN_BAD}" "${RELEASE_BAD}" "${GH_PATH_BAD}" "${TEST_DIR}/gh_out_bad")" || bad_status=$?
e2e::assert_equals "${bad_status}" "1" "checksum mismatch exits non-zero"
# assert_contains: full message includes ANSI colors and per-host hashes.
e2e::assert_contains "${bad_output}" "Checksum mismatch" "checksum mismatch is reported"
if [ -e "${BIN_BAD}/jaiph" ]; then
  e2e::fail "checksum failure left a binary in ${BIN_BAD}"
fi
e2e::assert_equals "$(<"${GH_PATH_BAD}")" "" "GITHUB_PATH is untouched on failure"
e2e::pass "checksum mismatch is non-recoverable and touches nothing"

# ── Fail closed: missing release artifact ─────────────────────────────────────

e2e::section "missing release artifact fails the step and installs nothing"

RELEASE_MISSING="${TEST_DIR}/release-missing"
BIN_MISSING="${TEST_DIR}/bin-missing"
mkdir -p "${RELEASE_MISSING}"
# The binary asset is intentionally absent; SHA256SUMS points at it anyway.
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "${HOST_BIN_NAME}" \
  > "${RELEASE_MISSING}/SHA256SUMS"
printf 'placeholder-sig\n' > "${RELEASE_MISSING}/SHA256SUMS.minisig"

missing_status=0
missing_output="$(run_setup "0.11.0" "${BIN_MISSING}" "${RELEASE_MISSING}" "${TEST_DIR}/gh_path_missing" "${TEST_DIR}/gh_out_missing")" || missing_status=$?
e2e::assert_equals "${missing_status}" "1" "missing artifact exits non-zero"
# assert_contains: full message includes ANSI colors and the resolved URL.
e2e::assert_contains "${missing_output}" "Failed to download" "download failure is reported"
if [ -e "${BIN_MISSING}/jaiph" ]; then
  e2e::fail "missing artifact left a binary in ${BIN_MISSING}"
fi
e2e::pass "missing artifact is non-recoverable and leaves no binary"
