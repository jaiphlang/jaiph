#!/usr/bin/env bash
# Guard: fail when e2e/ contains .jh or .sh fixture files not referenced by any test.
# Run: bash e2e/check_orphan_samples.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${ROOT_DIR}/e2e"

orphans=()

for f in "${E2E_DIR}"/*.jh "${E2E_DIR}"/*.test.jh; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  if ! grep -rq "$base" "${E2E_DIR}/tests/" "${E2E_DIR}/test_all.sh" "${E2E_DIR}/lib/" 2>/dev/null; then
    # Check if referenced by another .jh file that IS referenced
    indirect=false
    for parent in "${E2E_DIR}"/*.jh "${E2E_DIR}"/*.test.jh; do
      [[ -f "$parent" ]] || continue
      [[ "$parent" == "$f" ]] && continue
      parent_base="$(basename "$parent")"
      if grep -q "$base" "$parent" 2>/dev/null; then
        if grep -rq "$parent_base" "${E2E_DIR}/tests/" "${E2E_DIR}/test_all.sh" "${E2E_DIR}/lib/" 2>/dev/null; then
          indirect=true
          break
        fi
      fi
    done
    if [[ "$indirect" == false ]]; then
      orphans+=("$base")
    fi
  fi
done

if [[ ${#orphans[@]} -gt 0 ]]; then
  printf "ERROR: unreferenced e2e samples found:\n" >&2
  for o in "${orphans[@]}"; do
    printf "  %s\n" "$o" >&2
  done
  printf "Either wire them into a test, move to examples/, or delete them.\n" >&2
  exit 1
fi

printf "OK: no orphan e2e samples detected.\n"
