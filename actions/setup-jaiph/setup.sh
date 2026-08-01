#!/usr/bin/env bash
#
# setup-jaiph GitHub Action entrypoint.
#
# Install a pinned jaiph CLI in CI and expose it on PATH for later steps. This
# is thin glue over the canonical release installer (docs/install): it resolves
# the `version` input to a release ref, runs the installer into a runner-owned
# bin dir, then appends that dir to $GITHUB_PATH. All download / checksum /
# signature fail-closed policy lives in docs/install and MUST NOT be duplicated
# here — this script only decides the ref and wires PATH for the runner.
#
# GitHub-hosted runners set CI=true. As of finding M-5 the installer no longer
# downgrades to a checksum-only install when CI is set, so the action must make
# minisign available or the fail-closed installer aborts. This script installs
# minisign before invoking docs/install; it never sets JAIPH_ALLOW_UNSIGNED, so
# signature verification is always performed on the action path.
#
# Consumed from action.yml via INPUT_VERSION. Test/override hooks:
#   JAIPH_INSTALLER          path to the installer script (default: repo docs/install)
#   JAIPH_BIN_DIR            install dir (default: $RUNNER_TEMP/jaiph-bin)
#   JAIPH_RELEASE_BASE_URL   release asset base URL (see docs/install)
#   JAIPH_MINISIGN_INSTALL   override command that installs minisign (test hook;
#                            default: the platform package manager)
#   GITHUB_PATH/GITHUB_OUTPUT  Actions files; skipped when unset (local runs)

set -euo pipefail

# Ensure a minisign verifier is on PATH so docs/install can verify the release
# signature. A no-op when minisign is already available. On a runner without it,
# install through the platform package manager (or the JAIPH_MINISIGN_INSTALL
# override). This never forces success: if minisign still cannot be provided the
# installer fails closed loudly, which is the intended M-5 behaviour — better a
# hard failure than a silent checksum-only install for the whole CI population.
ensure_minisign() {
  if command -v minisign >/dev/null 2>&1; then
    echo "setup-jaiph: minisign already available for signature verification" >&2
    return 0
  fi

  echo "setup-jaiph: installing minisign for release signature verification" >&2
  if [ -n "${JAIPH_MINISIGN_INSTALL:-}" ]; then
    bash -c "${JAIPH_MINISIGN_INSTALL}" || true
  elif command -v brew >/dev/null 2>&1; then
    brew install minisign || true
  elif command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then
      apt-get update -qq && apt-get install -y -qq minisign || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo apt-get update -qq && sudo apt-get install -y -qq minisign || true
    fi
  fi

  if command -v minisign >/dev/null 2>&1; then
    echo "setup-jaiph: minisign installed" >&2
  else
    echo "setup-jaiph: minisign could not be installed; the installer will fail" >&2
    echo "setup-jaiph: closed unless the release can be signature-verified" >&2
  fi
}

# Resolve the requested version to a GitHub Release ref.
version="${INPUT_VERSION:-${1:-nightly}}"
# Trim surrounding whitespace (YAML folding can introduce it).
version="${version#"${version%%[![:space:]]*}"}"
version="${version%"${version##*[![:space:]]}"}"
[ -n "${version}" ] || version="nightly"

case "${version}" in
  nightly)  ref="nightly" ;;      # rolling prerelease tag
  v[0-9]*)  ref="${version}" ;;   # already a release tag (v0.11.0)
  [0-9]*)   ref="v${version}" ;;  # bare semver (0.11.0 -> v0.11.0)
  *)        ref="${version}" ;;   # any other explicit tag
esac

bin_dir="${JAIPH_BIN_DIR:-${RUNNER_TEMP:-/tmp}/jaiph-bin}"
mkdir -p "${bin_dir}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="${JAIPH_INSTALLER:-${script_dir}/../../docs/install}"
if [ ! -f "${installer}" ]; then
  echo "setup-jaiph: installer not found at ${installer}" >&2
  exit 1
fi

echo "setup-jaiph: resolved version '${version}' to release ref '${ref}'" >&2

# Make minisign available so docs/install performs signature verification. The
# runner sets CI=true, and CI is no longer a checksum-only opt-out (finding M-5).
ensure_minisign

# Force the release-download path: unset JAIPH_REPO_URL so a stray value can
# never flip docs/install into local-source build mode.
(
  unset JAIPH_REPO_URL
  JAIPH_BIN_DIR="${bin_dir}" JAIPH_REPO_REF="${ref}" bash "${installer}"
)

# Expose the install dir on PATH for subsequent workflow steps and this one.
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "${bin_dir}" >> "${GITHUB_PATH}"
fi
export PATH="${bin_dir}:${PATH}"

resolved="$("${bin_dir}/jaiph" --version)"
echo "setup-jaiph: installed ${resolved}" >&2
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'version=%s\n' "${resolved}" >> "${GITHUB_OUTPUT}"
fi
