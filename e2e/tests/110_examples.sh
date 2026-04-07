#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "examples"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
EXAMPLES_DIR="${ROOT_DIR}/examples"

# ── Example matrix ─────────────────────────────────────────────────────────
#
# Every *.jh and *.test.jh file in examples/ must have a test section below
# or be listed in EXCLUDED. The orphan guard at the bottom enforces this.
#
# To add a new example:
#   1. Place the .jh file in examples/.
#   2. Add it to COVERED (or EXCLUDED with a comment).
#   3. Add a test section with strict e2e::expect_stdout assertions.
#
# Covered via `jaiph run`:
COVERED_RUN=(
  "agent_inbox.jh"
  "say_hello.jh"       # failure path only; success needs a real agent
)
# Covered via `jaiph test`:
COVERED_TEST=(
  "say_hello.test.jh"
  "ensure_ci_passes.test.jh"
)
# Excluded (not runnable in e2e):
EXCLUDED=(
  "ensure_ci_passes.jh" # requires real `npm run test:ci`; CI/env-specific
  "async.jh"            # requires real agent backends (cursor, claude) for prompt steps
)

# Copy all example files into the test directory.
cp "${EXAMPLES_DIR}"/*.jh "${TEST_DIR}/"
cp "${EXAMPLES_DIR}"/*.test.jh "${TEST_DIR}/"

# ── agent_inbox.jh ──────────────────────────────────────────────────────────

e2e::section "examples/agent_inbox.jh — full run (no prompts)"

# When
inbox_out="$(e2e::run "agent_inbox.jh")"

# Then
e2e::expect_stdout "${inbox_out}" <<'EOF'

Jaiph: Running agent_inbox.jh

workflow default
  ▸ workflow scanner
  ·   ℹ Scanning for issues...
  ✓ workflow scanner (<time>)
  ▸ workflow analyst
  ·   ℹ Analyzing message from scanner on channel findings...
  ✓ workflow analyst (<time>)
  ▸ workflow reviewer
  ·   ℹ Reviewing message from analyst on channel report...
  ·   ! Critical issue: "Summary: "Found 3 issues in auth module""
  ✓ workflow reviewer (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "agent_inbox.jh" "scanner" "Scanning for issues..."
e2e::expect_out "agent_inbox.jh" "analyst" "Analyzing message from scanner on channel findings..."
e2e::expect_out "agent_inbox.jh" "reviewer" "Reviewing message from analyst on channel report..."

# ── say_hello.jh — failure path ─────────────────────────────────────────────
# Success path requires a real agent for the prompt step; covered by
# say_hello.test.jh below.

e2e::section "examples/say_hello.jh — failure without name argument"

# When
set +e
say_hello_out="$(e2e::run "say_hello.jh" 2>/dev/null)"
say_hello_exit=$?
set -e

# Then
if [[ ${say_hello_exit} -eq 0 ]]; then
  e2e::fail "say_hello.jh without args should fail"
fi

e2e::expect_stdout "${say_hello_out}" <<'EOF'

Jaiph: Running say_hello.jh

workflow default
  ▸ rule name_was_provided
  ·   ▸ script validate_name
  ·   ✗ script validate_name (<time>)
  ✗ rule name_was_provided (<time>)
EOF

e2e::expect_file "*script__validate_name.err" <<'EOF'
You didn't provide your name :(
EOF

# ── say_hello.test.jh ───────────────────────────────────────────────────────

e2e::section "examples/say_hello.test.jh — native test execution"

# When — examples/say_hello.test.jh intentionally fails the first test
# (expectEqual mismatch vs say_hello.jh stderr) to demonstrate failure output;
# the second test passes with a mocked prompt.
set +e
test_out="$(jaiph test "${TEST_DIR}/say_hello.test.jh" 2>&1)"
test_exit=$?
set -e

# Then
if [[ ${test_exit} -eq 0 ]]; then
  printf "%s\n" "${test_out}" >&2
  e2e::fail "say_hello.test.jh should exit non-zero (first test fails on purpose)"
fi

e2e::expect_stdout "${test_out}" <<'EOF'
testing say_hello.test.jh
  ▸ without name, workflow fails with validation message
  ✗ expect_equal failed: <time>
    - You didn't provide your name
    + You didn't provide your name :(

  ▸ with name, returns greeting and logs response
  ✓ <time>

✗ 1 / 2 test(s) failed
  - without name, workflow fails with validation message
EOF

# ── ensure_ci_passes.test.jh ────────────────────────────────────────────────

e2e::section "examples/ensure_ci_passes.test.jh — native test with mocked script"

# When
ci_test_out="$(jaiph test "${TEST_DIR}/ensure_ci_passes.test.jh" 2>&1)"

# Then
e2e::expect_stdout "${ci_test_out}" <<'EOF'
testing ensure_ci_passes.test.jh
  ▸ ci passes on first attempt skips recover
  ✓ <time>
✓ 1 test(s) passed
EOF

# ── Orphan guard ─────────────────────────────────────────────────────────────
# Fail if an example file exists that is not covered or explicitly excluded.

e2e::section "orphan guard — every example is accounted for"

all_known=( "${COVERED_RUN[@]}" "${COVERED_TEST[@]}" "${EXCLUDED[@]}" )

orphans=()
for f in "${EXAMPLES_DIR}"/*.jh "${EXAMPLES_DIR}"/*.test.jh; do
  name="$(basename "$f")"
  found=0
  for known in "${all_known[@]}"; do
    if [[ "$name" == "$known" ]]; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    orphans+=("$name")
  fi
done

if [[ ${#orphans[@]} -gt 0 ]]; then
  printf "Orphan example files not covered by 110_examples.sh:\n" >&2
  printf "  %s\n" "${orphans[@]}" >&2
  e2e::fail "add orphan files to COVERED_RUN, COVERED_TEST, or EXCLUDED in e2e/tests/110_examples.sh"
fi
e2e::pass "all example files accounted for"
