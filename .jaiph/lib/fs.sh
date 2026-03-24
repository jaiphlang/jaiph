#!/usr/bin/env bash
# Minimal filesystem helpers for Jaiph functions.

mkdir_p() {
  mkdir -p "$1"
}

rm_file() {
  rm -f "$1"
}
