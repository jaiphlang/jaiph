# Runtime: test mode helpers (mocks, JAIPH_TEST_MODE).
# Sourced by jaiph_stdlib.sh. No runtime module deps.

jaiph::is_test_mode() {
  [[ "${JAIPH_TEST_MODE:-}" == "1" ]]
}

# Reads and consumes the first line from JAIPH_MOCK_RESPONSES_FILE.
# Outputs the line to stdout. Returns 0 if a line was read, 1 if no file or empty.
jaiph::read_next_mock_response() {
  if [[ -z "${JAIPH_MOCK_RESPONSES_FILE:-}" || ! -f "${JAIPH_MOCK_RESPONSES_FILE}" ]]; then
    echo "jai: no mock for prompt (JAIPH_MOCK_RESPONSES_FILE missing or not a file)" >&2
    return 1
  fi
  local line
  line="$(head -n 1 "${JAIPH_MOCK_RESPONSES_FILE}" 2>/dev/null)" || true
  if [[ -z "$line" ]]; then
    return 1
  fi
  if [[ -s "${JAIPH_MOCK_RESPONSES_FILE}" ]]; then
    tail -n +2 "${JAIPH_MOCK_RESPONSES_FILE}" > "${JAIPH_MOCK_RESPONSES_FILE}.tmp" 2>/dev/null && mv "${JAIPH_MOCK_RESPONSES_FILE}.tmp" "${JAIPH_MOCK_RESPONSES_FILE}" || true
  fi
  printf '%s' "$line"
  return 0
}
