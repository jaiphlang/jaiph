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
# that answers `--version`.
#
# Signature verification (finding M-5). GitHub runners set CI=true, and CI is no
# longer a checksum-only opt-out, so the action MUST provide a minisign verifier
# or the fail-closed installer aborts. setup.sh's ensure_minisign does that; this
# test drives every case with CI=true (the runner's state) and NO
# JAIPH_ALLOW_UNSIGNED, so signature verification is always exercised on the
# action path. When minisign is on the host, SHA256SUMS is signed with a
# throwaway key whose public key is handed to the installer. When it is absent,
# setup.sh "installs" a fake verifier through the JAIPH_MINISIGN_INSTALL override
# and releases carry a marker signature the fake accepts — so verification runs
# deterministically either way. Fail-closed on a missing .minisig is covered by
# 07_installer_binary.sh; this file adds the fail-closed-when-minisign-cannot-be-
# installed case for the action path.

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

# Pick a verifier strategy once: use the host's real minisign when present, else
# a deterministic fake that setup.sh "installs" via the JAIPH_MINISIGN_INSTALL
# override. The fake accepts a signature whose body is FAKE_MARKER and rejects
# anything else, so a tampered signature still fails verification.
FAKE_MARKER="E2E-VALID-SIGNATURE"
TOOLS_DIR="${TEST_DIR}/tools"
FAKE_MINISIGN="${TEST_DIR}/fake-minisign"
USE_FAKE_MINISIGN=""
mkdir -p "${TOOLS_DIR}"
if ! command -v minisign >/dev/null 2>&1; then
  USE_FAKE_MINISIGN=1
  cat > "${FAKE_MINISIGN}" <<'FAKE'
#!/usr/bin/env bash
# Fake minisign for e2e: verify (-V) succeeds only when the detached signature
# (-x) body is the expected marker. Mirrors the args docs/install passes.
sig=""
while [ $# -gt 0 ]; do
  case "$1" in
    -x) sig="$2"; shift 2 ;;
    -P|-m) shift 2 ;;
    *) shift ;;
  esac
done
[ -n "${sig}" ] && [ -f "${sig}" ] && grep -q 'E2E-VALID-SIGNATURE' "${sig}"
FAKE
  chmod +x "${FAKE_MINISIGN}"
fi

# Sign a release's SHA256SUMS so docs/install's signature step verifies. The
# installer verifies the detached signature BEFORE the checksum, so every
# release must carry a valid signature to reach later steps. Sets REL_PUBKEY to
# the matching public key when the host has real minisign; empty for the fake.
REL_PUBKEY=""
sign_release() {
  local dir="$1"
  if [ -n "${USE_FAKE_MINISIGN}" ]; then
    printf '%s\n' "${FAKE_MARKER}" > "${dir}/SHA256SUMS.minisig"
    REL_PUBKEY=""
  else
    rm -f "${dir}/test.pub" "${dir}/test.key"
    minisign -G -W -p "${dir}/test.pub" -s "${dir}/test.key" >/dev/null 2>&1
    minisign -S -s "${dir}/test.key" -m "${dir}/SHA256SUMS" >/dev/null 2>&1
    REL_PUBKEY="$(tail -n 1 "${dir}/test.pub")"
  fi
}

# Write a release whose signature does NOT verify (tampered): a marker mismatch
# for the fake, corrupted bytes for real minisign.
tamper_signature() {
  local dir="$1"
  printf 'not-a-valid-signature\n' > "${dir}/SHA256SUMS.minisig"
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

# Run the action entrypoint against a mock release under CI=true (the runner's
# state) and no JAIPH_ALLOW_UNSIGNED, so signature verification is always on the
# path. Args: version, bin_dir, release_dir, github_path, github_output.
# Echoes combined output; returns the entrypoint's exit status.
# When the host lacks minisign, setup.sh installs the fake through
# JAIPH_MINISIGN_INSTALL; TOOLS_DIR is prepended to PATH so both setup.sh and the
# installer subprocess resolve it. REL_PUBKEY is only set for real throwaway keys.
run_setup() {
  local version="$1" bin_dir="$2" release_dir="$3" gh_path="$4" gh_out="$5"
  local install_hook=""
  if [ -n "${USE_FAKE_MINISIGN}" ]; then
    install_hook="cp '${FAKE_MINISIGN}' '${TOOLS_DIR}/minisign' && chmod +x '${TOOLS_DIR}/minisign'"
    unset JAIPH_MINISIGN_PUBLIC_KEY
  elif [ -n "${REL_PUBKEY}" ]; then
    export JAIPH_MINISIGN_PUBLIC_KEY="${REL_PUBKEY}"
  else
    unset JAIPH_MINISIGN_PUBLIC_KEY
  fi
  INPUT_VERSION="${version}" \
  CI=true \
  JAIPH_ALLOW_UNSIGNED="" \
  JAIPH_BIN_DIR="${bin_dir}" \
  JAIPH_RELEASE_BASE_URL="file://${release_dir}" \
  JAIPH_MINISIGN_INSTALL="${install_hook}" \
  GITHUB_PATH="${gh_path}" \
  GITHUB_OUTPUT="${gh_out}" \
  PATH="${TOOLS_DIR}:${PATH}" \
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
# AC3: the action path performs signature verification (CI=true, no opt-out).
# assert_contains: full output includes the installer's ANSI-colored progress.
e2e::assert_contains "${ok_output}" "Release signature verified" \
  "action path verifies the release signature under CI"

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

# ── Fail closed: tampered signature (AC3) ─────────────────────────────────────

e2e::section "a tampered release signature fails the action path"

RELEASE_TAMPER="${TEST_DIR}/release-tamper"
BIN_TAMPER="${TEST_DIR}/bin-tamper"
GH_PATH_TAMPER="${TEST_DIR}/github_path_tamper"
: > "${GH_PATH_TAMPER}"
make_release "${RELEASE_TAMPER}"
tamper_signature "${RELEASE_TAMPER}"

tamper_status=0
tamper_output="$(run_setup "0.11.0" "${BIN_TAMPER}" "${RELEASE_TAMPER}" "${GH_PATH_TAMPER}" "${TEST_DIR}/gh_out_tamper")" || tamper_status=$?
e2e::assert_equals "${tamper_status}" "1" "tampered signature exits non-zero"
# assert_contains: full message includes ANSI colors.
e2e::assert_contains "${tamper_output}" "signature verification failed" \
  "signature verification failure is reported"
if [ -e "${BIN_TAMPER}/jaiph" ]; then
  e2e::fail "tampered signature left a binary in ${BIN_TAMPER}"
fi
e2e::assert_equals "$(<"${GH_PATH_TAMPER}")" "" "GITHUB_PATH is untouched on signature failure"
e2e::pass "tampered signature is non-recoverable and touches nothing"

# ── Fail closed: minisign cannot be provided under CI (AC3, finding M-5) ───────
#
# Proves the action does not silently downgrade to checksum-only under CI: when
# ensure_minisign cannot install a verifier and none is on PATH, the fail-closed
# installer aborts. Only meaningful when the host itself lacks minisign (so it
# can be forced unavailable); skipped otherwise.

e2e::section "action fails closed under CI when minisign cannot be provided"

if [ -z "${USE_FAKE_MINISIGN}" ]; then
  e2e::skip "host has minisign — cannot force it unavailable for the fail-closed case"
else
  RELEASE_FC="${TEST_DIR}/release-failclosed"
  BIN_FC="${TEST_DIR}/bin-failclosed"
  GH_PATH_FC="${TEST_DIR}/github_path_failclosed"
  : > "${GH_PATH_FC}"
  make_release "${RELEASE_FC}"

  fc_status=0
  fc_output="$(
    INPUT_VERSION="0.11.0" \
    CI=true \
    JAIPH_BIN_DIR="${BIN_FC}" \
    JAIPH_RELEASE_BASE_URL="file://${RELEASE_FC}" \
    JAIPH_MINISIGN_INSTALL=":" \
    GITHUB_PATH="${GH_PATH_FC}" \
    GITHUB_OUTPUT="${TEST_DIR}/gh_out_failclosed" \
    env -u JAIPH_ALLOW_UNSIGNED -u JAIPH_MINISIGN_PUBLIC_KEY \
      PATH="/usr/bin:/bin" \
      bash "${SETUP_SCRIPT}" 2>&1
  )" || fc_status=$?
  e2e::assert_equals "${fc_status}" "1" "action fails when minisign cannot be installed under CI"
  # assert_contains: full message includes ANSI colors.
  e2e::assert_contains "${fc_output}" "minisign is required" "reports mandatory signature verification"
  if [ -e "${BIN_FC}/jaiph" ]; then
    e2e::fail "action left a binary when signature verification was impossible"
  fi
  e2e::assert_equals "$(<"${GH_PATH_FC}")" "" "GITHUB_PATH is untouched when fail-closed"
  e2e::pass "action path enforces signature verification under CI (no checksum-only downgrade)"
fi

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
