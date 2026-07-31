#!/usr/bin/env sh
# fetch-verify.sh — download a URL to a destination path and fail closed unless
# its content matches a REQUIRED sha256. This is the single seam every toolchain
# fetch in runtime/Dockerfile goes through (finding M-11): a poisoned toolchain
# CDN can no longer silently replace an installer, and an empty or mismatched
# checksum aborts the build instead of installing unverified bytes.
#
# Usage: fetch-verify.sh <url> <dest> <sha256>
#
# Exit codes: 2 = bad usage, 1 = missing checksum / download failure / mismatch.
set -eu

url="${1:-}"
dest="${2:-}"
sha="${3:-}"

if [ -z "$url" ] || [ -z "$dest" ]; then
  echo "fetch-verify: usage: fetch-verify.sh <url> <dest> <sha256>" >&2
  exit 2
fi

# A missing checksum is fail-closed: refuse to fetch rather than degrade to an
# unverified download. Every caller must pin a non-empty sha256.
if [ -z "$sha" ]; then
  echo "fetch-verify: refusing to fetch ${url} without a pinned sha256 (checksum is required)" >&2
  exit 1
fi

if ! curl -fsSL "$url" -o "$dest"; then
  echo "fetch-verify: failed to download ${url}" >&2
  exit 1
fi

# sha256sum on the Ubuntu image; shasum keeps the helper testable on macOS hosts.
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$dest" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$dest" | awk '{print $1}')"
else
  echo "fetch-verify: no sha256sum/shasum available to verify ${url}" >&2
  rm -f "$dest"
  exit 1
fi

if [ "$sha" != "$actual" ]; then
  echo "fetch-verify: sha256 mismatch for ${url}" >&2
  echo "  expected: ${sha}" >&2
  echo "  got:      ${actual}" >&2
  rm -f "$dest"
  exit 1
fi
