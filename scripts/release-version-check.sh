#!/usr/bin/env bash
#
# Sanity-check a compiled jaiph binary's `--version` output against the release
# channel/tag. Shared by the linux-x64 and windows-x64 gates in
# `.github/workflows/release.yml` so the comparison lives in one place and is
# unit-testable (see integration/release-workflow.test.ts).
#
# Usage: release-version-check.sh <channel> <tag> <version-output>
#   channel:        "stable" | "nightly"
#   tag:            release tag (e.g. "v0.10.0" for stable, "nightly" otherwise)
#   version-output: the string printed by `<binary> --version`
#
# For a stable release the output must equal "jaiph <tag-without-v>" exactly.
# For any other channel it only has to look like a jaiph version banner.
set -euo pipefail

channel="${1:?channel required}"
tag="${2:?tag required}"
got="${3?version output required}"

if [ "${channel}" = "stable" ]; then
  expected="jaiph ${tag#v}"
  if [ "${got}" != "${expected}" ]; then
    echo "Version sanity check failed: expected '${expected}', got '${got}'" >&2
    exit 1
  fi
else
  if ! printf '%s\n' "${got}" | grep -Eq '^jaiph [0-9]+\.[0-9]+\.[0-9]+'; then
    echo "Version sanity check failed: '${got}' does not look like a jaiph version" >&2
    exit 1
  fi
fi

echo "Version sanity check passed: ${got}"
