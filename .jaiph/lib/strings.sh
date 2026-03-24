#!/usr/bin/env bash
# Newline-delimited list helpers (source via "$JAIPH_LIB/strings.sh").

first_line() {
  printf '%s\n' "$1" | head -n 1
}

rest_lines() {
  printf '%s\n' "$1" | tail -n +2
}
