#!/usr/bin/env bash
# Install Jaiph from a local clone (no network clone). Uses the same logic as
# docs/install with JAIPH_REPO_URL set to the local repo root.
#
# Usage:
#   ./docs/install-from-local.sh           # install from repo containing this script
#   ./docs/install-from-local.sh /path/to/jaiph

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
# Resolve to absolute path so install script sees a consistent path
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"

if [ ! -d "${REPO_ROOT}" ]; then
  echo "Error: not a directory: ${REPO_ROOT}" >&2
  exit 1
fi
if [ ! -f "${REPO_ROOT}/package.json" ]; then
  echo "Error: ${REPO_ROOT} does not look like the Jaiph repo (no package.json)" >&2
  exit 1
fi

export JAIPH_REPO_URL="${REPO_ROOT}"
echo "Installing from local source: ${JAIPH_REPO_URL}"
exec "${SCRIPT_DIR}/install"
