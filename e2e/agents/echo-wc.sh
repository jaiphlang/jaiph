#!/usr/bin/env bash
# Custom agent script: reads prompt from stdin, outputs word count.
input=$(cat)
count=$(printf '%s' "$input" | wc -w | tr -d ' ')
printf 'words: %s\n' "$count"
