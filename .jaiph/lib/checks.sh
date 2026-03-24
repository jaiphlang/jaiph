#!/usr/bin/env bash
# Shared predicates for Jaiph workflows (source from functions via "$JAIPH_LIB/checks.sh").

has_value() {
  [ -n "${1:-}" ]
}

matches() {
  [ "$1" = "$2" ]
}

is_zero() {
  [ "${1:-0}" -eq 0 ]
}
