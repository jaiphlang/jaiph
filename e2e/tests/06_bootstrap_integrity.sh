#!/usr/bin/env bash
#
# Acceptance for the bootstrap-script integrity check (finding M-11, AC4). The
# docs/run bootstrap must verify the install script against its published
# sha256 before executing it, instead of piping `curl … | bash`. This test
# drives docs/run against a local file:// "site" with jaiph absent from PATH so
# the install branch runs, and asserts:
#   - a tampered install script is rejected (integrity check fails closed)
#   - a missing install.sha256 is rejected (no unverified execution)
#   - a matching install script is accepted and executed
# It also pins the committed docs/install.sha256 to the current docs/install so
# the published checksum cannot drift out of sync.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "bootstrap_integrity"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
RUN_SCRIPT="${ROOT_DIR}/docs/run"

if command -v sha256sum >/dev/null 2>&1; then
  host_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  host_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  e2e::skip "no sha256sum/shasum on host — skipping bootstrap integrity acceptance"
  exit 0
fi

# ── Committed docs/install.sha256 matches docs/install ────────────────────────

e2e::section "committed docs/install.sha256 matches docs/install"

if [ ! -f "${ROOT_DIR}/docs/install.sha256" ]; then
  e2e::fail "docs/install.sha256 is missing — bootstrap scripts cannot verify the installer"
fi
committed_sum="$(awk '{print $1; exit}' "${ROOT_DIR}/docs/install.sha256")"
real_sum="$(host_sha256 "${ROOT_DIR}/docs/install")"
e2e::assert_equals "${committed_sum}" "${real_sum}" "docs/install.sha256 is in sync with docs/install"

# ── Local-source install path uses `npm ci` under a lockfile guard ────────────
#
# Clean-room lockfile enforcement (finding L-4): the local-source build must run
# `npm ci` when a package-lock.json is present rather than a bare `npm install`.

e2e::section "local-source install path prefers npm ci when a lockfile is present"

install_body="$(cat "${ROOT_DIR}/docs/install")"
# assert_contains: matching the exact guarded command line, not full file bytes
e2e::assert_contains "${install_body}" 'if [ -f "${tmp_dir}/src/package-lock.json" ]; then' \
  "install script guards on a present package-lock.json"
e2e::assert_contains "${install_body}" 'cd "${tmp_dir}/src" && npm ci' \
  "install script runs npm ci in the lockfile branch"

# ── Runtime dependency `jose` is exact-pinned (no range operator) ─────────────

e2e::section "package.json pins jose to an exact version"

jose_version="$(node -e 'process.stdout.write(require("'"${ROOT_DIR}"'/package.json").dependencies.jose)')"
case "${jose_version}" in
  *[\^\~\*\ \|xX]* | ">"* | "<"* | "="* )
    e2e::fail "jose must be exact-pinned in package.json (got '${jose_version}')"
    ;;
esac
e2e::assert_equals "${jose_version}" "5.10.0" "jose is exact-pinned in package.json"

# ── Build a fake PATH with the tools docs/run needs, but no jaiph ─────────────
#
# docs/run's preflight requires node; install_jaiph_verified needs curl, awk,
# mktemp, bash, rm and a sha tool. Symlinking exactly these guarantees jaiph is
# absent (so the install branch runs) while the script can still function.

FAKE_BIN="${TEST_DIR}/fakebin"
mkdir -p "${FAKE_BIN}"
for t in node curl mktemp awk bash rm mkdir chmod cat cp ln uname sed grep dirname sha256sum shasum; do
  p="$(command -v "${t}" 2>/dev/null || true)"
  [ -n "${p}" ] && ln -sf "${p}" "${FAKE_BIN}/${t}"
done
if PATH="${FAKE_BIN}" command -v jaiph >/dev/null 2>&1; then
  e2e::skip "jaiph resolvable on the fake PATH — cannot exercise the install branch"
  exit 0
fi
if ! PATH="${FAKE_BIN}" command -v node >/dev/null 2>&1; then
  e2e::skip "node not available for the fake PATH — skipping bootstrap install-branch checks"
  exit 0
fi

# A fake install script that "installs" a jaiph stub into $HOME/.local/bin,
# which docs/run puts on PATH after install.
write_site() {
  local dir="$1"
  mkdir -p "${dir}"
  cat > "${dir}/install" <<'INSTALL'
#!/usr/bin/env bash
mkdir -p "${HOME}/.local/bin"
cat > "${HOME}/.local/bin/jaiph" <<'STUB'
#!/usr/bin/env bash
echo "STUB-JAIPH $*"
STUB
chmod +x "${HOME}/.local/bin/jaiph"
INSTALL
  printf '%s  install\n' "$(host_sha256 "${dir}/install")" > "${dir}/install.sha256"
}

# ── Matching install script is accepted and executed ──────────────────────────

e2e::section "verified install script is accepted and run"

SITE_GOOD="${TEST_DIR}/site-good"
HOME_GOOD="${TEST_DIR}/home-good"
mkdir -p "${HOME_GOOD}"
write_site "${SITE_GOOD}"

good_status=0
good_out="$(
  env -i PATH="${FAKE_BIN}" HOME="${HOME_GOOD}" TMPDIR="${TEST_DIR}" \
    JAIPH_SITE="file://${SITE_GOOD}" \
    bash "${RUN_SCRIPT}" 'export def main() { }' 2>&1
)" || good_status=$?
e2e::assert_equals "${good_status}" "0" "verified install + run exits zero"
e2e::assert_contains "${good_out}" "STUB-JAIPH run" "the installed jaiph stub ran the workflow"
if [ ! -x "${HOME_GOOD}/.local/bin/jaiph" ]; then
  e2e::fail "verified install did not place the jaiph stub"
fi
e2e::pass "matching install script is verified and executed"

# ── Tampered install script is rejected ───────────────────────────────────────

e2e::section "tampered install script is rejected"

SITE_BAD="${TEST_DIR}/site-bad"
HOME_BAD="${TEST_DIR}/home-bad"
mkdir -p "${HOME_BAD}"
write_site "${SITE_BAD}"
# Tamper the script AFTER publishing its checksum — the hash no longer matches.
printf '\necho "tampered-payload"\n' >> "${SITE_BAD}/install"

bad_status=0
bad_out="$(
  env -i PATH="${FAKE_BIN}" HOME="${HOME_BAD}" TMPDIR="${TEST_DIR}" \
    JAIPH_SITE="file://${SITE_BAD}" \
    bash "${RUN_SCRIPT}" 'export def main() { }' 2>&1
)" || bad_status=$?
e2e::assert_equals "${bad_status}" "1" "tampered install script exits non-zero"
e2e::assert_contains "${bad_out}" "integrity check failed" "reports the integrity failure"
if [ -e "${HOME_BAD}/.local/bin/jaiph" ]; then
  e2e::fail "tampered install script was executed (jaiph stub was created)"
fi
e2e::pass "tampered install script is fail-closed and never executed"

# ── Missing install.sha256 is rejected ────────────────────────────────────────

e2e::section "missing install.sha256 fails closed"

SITE_NOSHA="${TEST_DIR}/site-nosha"
HOME_NOSHA="${TEST_DIR}/home-nosha"
mkdir -p "${HOME_NOSHA}"
write_site "${SITE_NOSHA}"
rm -f "${SITE_NOSHA}/install.sha256"

nosha_status=0
nosha_out="$(
  env -i PATH="${FAKE_BIN}" HOME="${HOME_NOSHA}" TMPDIR="${TEST_DIR}" \
    JAIPH_SITE="file://${SITE_NOSHA}" \
    bash "${RUN_SCRIPT}" 'export def main() { }' 2>&1
)" || nosha_status=$?
e2e::assert_equals "${nosha_status}" "1" "missing checksum exits non-zero"
e2e::assert_contains "${nosha_out}" "unverified install script" "refuses to run without a published checksum"
if [ -e "${HOME_NOSHA}/.local/bin/jaiph" ]; then
  e2e::fail "install ran despite a missing published checksum"
fi
e2e::pass "missing published checksum is fail-closed"
