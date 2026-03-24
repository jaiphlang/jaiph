#!/usr/bin/env bash
# Git path listings for Jaiph workflows.

git_changed_paths_sorted() {
  {
    git diff --name-only --cached
    git diff --name-only
    git ls-files --others --exclude-standard
  } | sort -u
}
