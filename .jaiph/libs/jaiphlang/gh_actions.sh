#!/usr/bin/env bash
# GitHub Actions helpers for Jaiph orchestration workflows.
# Requires: gh, jq, git, and GH_TOKEN or GITHUB_TOKEN in the environment.
set -euo pipefail

GH_ACTIONS_WORKFLOW="${GH_ACTIONS_WORKFLOW:-CI}"
GH_ACTIONS_POLL_INTERVAL="${GH_ACTIONS_POLL_INTERVAL:-30}"
GH_ACTIONS_POLL_MAX="${GH_ACTIONS_POLL_MAX:-120}"
GH_ACTIONS_LOG_TAIL="${GH_ACTIONS_LOG_TAIL:-10}"
GH_ACTIONS_REPO_ARGS=()

usage() {
  cat <<'EOF'
Usage: gh_actions.sh <command> [options]

Commands:
  resolve-run   Print the latest matching workflow run id (databaseId).
  wait-run      Wait until a run completes; print "conclusion<TAB>url<TAB>run_id".
  pull-logs     Write workflow logs to a file or stdout.
  check-ci      Wait for CI on a ref; exit 0 on success, 1 on failure (logs on stdout).

Shared options:
  -b, --branch BRANCH     Branch filter (default: current git branch)
  -c, --commit SHA        Commit filter (default: HEAD when branch is implicit)
  -w, --workflow NAME     Workflow name (default: CI, or GH_ACTIONS_WORKFLOW)
  -R, --repo OWNER/REPO   Pass through to gh -R
  -h, --help              Show help

resolve-run options:
  --any-status            Pick the newest run even when still in progress

wait-run options:
  --run-id ID             Wait for this run instead of resolving by ref

pull-logs options:
  --run-id ID             Run to fetch (otherwise resolve by ref)
  -o, --out FILE          Output path (default: stdout)
  -f, --failed-only       Fetch only failed job/step logs

check-ci options:
  -o, --out FILE          Write full --log-failed output to FILE (default:
                          ${JAIPH_WORKSPACE:-.}/.jaiph/tmp/gh_actions.check_ci.log)
                          Stdout gets only a short summary plus the last
                          GH_ACTIONS_LOG_TAIL lines (default: 10).

require-token:
  Exit 0 when GH_TOKEN or GITHUB_TOKEN is set; otherwise fail with an explicit error.

Environment:
  GH_TOKEN / GITHUB_TOKEN  Required GitHub API token (GITHUB_TOKEN is copied to GH_TOKEN)
  GH_ACTIONS_POLL_INTERVAL Seconds between polls (default: 30)
  GH_ACTIONS_POLL_MAX      Max poll attempts (default: 120)
  GH_ACTIONS_LOG_TAIL      Lines of failed-log tail on stdout (default: 10)
EOF
}

die() {
  printf 'gh_actions: %s\n' "$*" >&2
  exit 1
}

require_tools() {
  command -v gh >/dev/null 2>&1 || die "gh not found; install GitHub CLI"
  command -v jq >/dev/null 2>&1 || die "jq not found"
}

require_gh_token() {
  if [ -n "${GH_TOKEN:-}" ]; then
    return 0
  fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
    return 0
  fi
  die "GH_TOKEN or GITHUB_TOKEN is required; pass a token explicitly (e.g. jaiph run --unsafe --env GITHUB_TOKEN .jaiph/gh_ci_passes.jh)"
}

mark_git_workspace_safe() {
  command -v git >/dev/null 2>&1 || return 0
  local root="${JAIPH_WORKSPACE:-$(pwd)}"
  git config --global --add safe.directory "$root" 2>/dev/null || true
  if [ "$(pwd)" != "$root" ]; then
    git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
  fi
}

gh_cmd() {
  if [ "${#GH_ACTIONS_REPO_ARGS[@]}" -gt 0 ]; then
    gh "${GH_ACTIONS_REPO_ARGS[@]}" "$@"
  else
    gh "$@"
  fi
}

default_branch() {
  mark_git_workspace_safe
  git rev-parse --abbrev-ref HEAD
}

default_commit() {
  mark_git_workspace_safe
  git rev-parse HEAD
}

list_runs_json() {
  local workflow="$1"
  local branch="$2"
  local commit="$3"
  local limit="${4:-5}"
  local json

  if [ -n "$commit" ]; then
    json="$(gh_cmd run list --workflow "$workflow" --commit "$commit" --limit "$limit" \
      --json databaseId,status,conclusion,url,headBranch,headSha,createdAt)"
  else
    if [ -z "$branch" ]; then
      branch="$(default_branch)"
    fi
    json="$(gh_cmd run list --workflow "$workflow" --branch "$branch" --limit "$limit" \
      --json databaseId,status,conclusion,url,headBranch,headSha,createdAt)"
  fi

  if [ -z "$json" ]; then
    json='[]'
  fi
  printf '%s\n' "$json"
}

pick_run_json() {
  local workflow="$1"
  local branch="$2"
  local commit="$3"
  local any_status="$4"
  local json

  json="$(list_runs_json "$workflow" "$branch" "$commit" 5)"
  if [ "$(printf '%s' "$json" | jq 'length')" -eq 0 ]; then
    printf '\n'
    return 0
  fi

  if [ "$any_status" = "1" ]; then
    printf '%s' "$json" | jq -c '.[0]'
    return 0
  fi

  # Prefer the newest completed run; otherwise return the newest in-flight run.
  printf '%s' "$json" | jq -c '
    (map(select(.status == "completed")) | .[0])
    // .[0]
    // empty
  '
}

resolve_run_id() {
  local workflow="$1"
  local branch="$2"
  local commit="$3"
  local any_status="$4"
  local run_json run_id

  if [ -z "$commit" ] && [ -z "$branch" ]; then
    branch="$(default_branch)"
    commit="$(default_commit)"
  fi

  run_json="$(pick_run_json "$workflow" "$branch" "$commit" "$any_status")"
  if [ -z "$run_json" ]; then
    return 1
  fi
  run_id="$(printf '%s' "$run_json" | jq -r '.databaseId')"
  if [ -z "$run_id" ] || [ "$run_id" = "null" ]; then
    return 1
  fi
  printf '%s\n' "$run_id"
}

wait_for_ref() {
  local workflow="$1"
  local branch="$2"
  local commit="$3"
  local i=1
  local json count status conclusion run_id url ref_label

  if [ -z "$workflow" ]; then
    workflow="$GH_ACTIONS_WORKFLOW"
  fi

  if [ -z "$commit" ]; then
    commit="$(default_commit)"
  fi

  if [ -n "$branch" ]; then
    ref_label="${branch}@${commit:0:7}"
  else
    ref_label="${commit:0:7}"
  fi

  while [ "$i" -le "$GH_ACTIONS_POLL_MAX" ]; do
    json="$(list_runs_json "$workflow" "$branch" "$commit" 1)"
    count="$(printf '%s' "$json" | jq 'length')"
    if [ "$count" -eq 0 ]; then
      printf '[%s/%s] No "%s" workflow run yet for %s\n' \
        "$i" "$GH_ACTIONS_POLL_MAX" "$workflow" "$ref_label" >&2
      sleep "$GH_ACTIONS_POLL_INTERVAL"
      i=$((i + 1))
      continue
    fi

    status="$(printf '%s' "$json" | jq -r '.[0].status')"
    conclusion="$(printf '%s' "$json" | jq -r '.[0].conclusion')"
    run_id="$(printf '%s' "$json" | jq -r '.[0].databaseId')"
    url="$(printf '%s' "$json" | jq -r '.[0].url')"

    if [ "$status" != "completed" ]; then
      printf '[%s/%s] Run %s status=%s (%s)\n' "$i" "$GH_ACTIONS_POLL_MAX" "$run_id" "$status" "$url" >&2
      sleep "$GH_ACTIONS_POLL_INTERVAL"
      i=$((i + 1))
      continue
    fi

    printf '%s\t%s\t%s\n' "$conclusion" "$url" "$run_id"
    return 0
  done

  die "timed out waiting for ${workflow} on ${commit}"
}

wait_for_run_id() {
  local run_id="$1"
  gh_cmd run watch "$run_id" --exit-status >/dev/null
  gh_cmd run view "$run_id" --json conclusion,url \
    | jq -r '[.conclusion, .url, '"$run_id"'] | @tsv'
}

assign_positional_ref() {
  _gh_branch="${1:-}"
  _gh_commit="${2:-}"
  _gh_workflow="${3:-$GH_ACTIONS_WORKFLOW}"
}

cmd_resolve_run() {
  local workflow="$GH_ACTIONS_WORKFLOW"
  local branch=""
  local commit=""
  local any_status="0"

  if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
    assign_positional_ref "$@"
    branch="$_gh_branch"
    commit="$_gh_commit"
    workflow="$_gh_workflow"
    resolve_run_id "$workflow" "$branch" "$commit" "$any_status" \
      || die "no ${workflow} run found for the given ref"
    return 0
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|--branch) branch="$2"; shift 2 ;;
      -c|--commit) commit="$2"; shift 2 ;;
      -w|--workflow) workflow="$2"; shift 2 ;;
      -R|--repo) GH_ACTIONS_REPO_ARGS=(-R "$2"); shift 2 ;;
      --any-status) any_status="1"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown resolve-run arg: $1" ;;
    esac
  done

  resolve_run_id "$workflow" "$branch" "$commit" "$any_status" \
    || die "no ${workflow} run found for the given ref"
}

cmd_wait_run() {
  local workflow="$GH_ACTIONS_WORKFLOW"
  local branch=""
  local commit=""
  local run_id=""

  if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
    assign_positional_ref "$@"
    branch="$_gh_branch"
    commit="$_gh_commit"
    workflow="$_gh_workflow"
    wait_for_ref "$workflow" "$branch" "$commit"
    return 0
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|--branch) branch="$2"; shift 2 ;;
      -c|--commit) commit="$2"; shift 2 ;;
      -w|--workflow) workflow="$2"; shift 2 ;;
      -R|--repo) GH_ACTIONS_REPO_ARGS=(-R "$2"); shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown wait-run arg: $1" ;;
    esac
  done

  if [ -n "$run_id" ]; then
    wait_for_run_id "$run_id"
  else
    wait_for_ref "$workflow" "$branch" "$commit"
  fi
}

cmd_pull_logs() {
  local workflow="$GH_ACTIONS_WORKFLOW"
  local branch=""
  local commit=""
  local run_id=""
  local out_file=""
  local failed_only="0"

  if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
    branch="${1:-}"
    commit="${2:-}"
    workflow="${3:-$GH_ACTIONS_WORKFLOW}"
    out_file="${4:-}"
    if [ "${5:-}" = "1" ]; then
      failed_only="1"
    fi
    if [ -z "$run_id" ]; then
      run_id="$(resolve_run_id "$workflow" "$branch" "$commit" 1)" \
        || die "no ${workflow} run found for the given ref"
    fi
    local -a log_args=(run view "$run_id" --log)
    if [ "$failed_only" = "1" ]; then
      log_args=(run view "$run_id" --log-failed)
    fi
    if [ -n "$out_file" ]; then
      gh_cmd "${log_args[@]}" >"$out_file"
      printf '%s\n' "$out_file"
    else
      gh_cmd "${log_args[@]}"
    fi
    return 0
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|--branch) branch="$2"; shift 2 ;;
      -c|--commit) commit="$2"; shift 2 ;;
      -w|--workflow) workflow="$2"; shift 2 ;;
      -R|--repo) GH_ACTIONS_REPO_ARGS=(-R "$2"); shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      -o|--out) out_file="$2"; shift 2 ;;
      -f|--failed-only) failed_only="1"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown pull-logs arg: $1" ;;
    esac
  done

  if [ -z "$run_id" ]; then
    run_id="$(resolve_run_id "$workflow" "$branch" "$commit" 1)" \
      || die "no ${workflow} run found for the given ref"
  fi

  local -a log_args=(run view "$run_id" --log)
  if [ "$failed_only" = "1" ]; then
    log_args=(run view "$run_id" --log-failed)
  fi

  if [ -n "$out_file" ]; then
    gh_cmd "${log_args[@]}" >"$out_file"
    printf '%s\n' "$out_file"
  else
    gh_cmd "${log_args[@]}"
  fi
}

default_ci_log_file() {
  printf '%s\n' "${JAIPH_WORKSPACE:-.}/.jaiph/tmp/gh_actions.check_ci.log"
}

emit_failed_ci_report() {
  local conclusion="$1"
  local url="$2"
  local run_id="$3"
  local log_file="$4"
  local tail_lines="$GH_ACTIONS_LOG_TAIL"

  mkdir -p "$(dirname "$log_file")"
  gh_cmd run view "$run_id" --log-failed >"$log_file"

  printf 'CI failed (%s): %s (run %s)\n' "$conclusion" "$url" "$run_id"
  printf 'Full log: %s\n\n' "$log_file"
  printf '%s\n' "--- last ${tail_lines} lines ---"
  tail -n "$tail_lines" "$log_file"
}

cmd_check_ci() {
  local workflow="$GH_ACTIONS_WORKFLOW"
  local branch=""
  local commit=""
  local log_file=""
  local result conclusion url run_id

  if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
    branch="${1:-}"
    commit="${2:-}"
    workflow="${3:-$GH_ACTIONS_WORKFLOW}"
    log_file="${4:-}"
    if [ -z "$log_file" ]; then
      log_file="$(default_ci_log_file)"
    fi
    result="$(wait_for_ref "$workflow" "$branch" "$commit")"
    IFS=$'\t' read -r conclusion url run_id <<<"$result"
    if [ "$conclusion" = "success" ]; then
      printf 'CI succeeded: %s (run %s)\n' "$url" "$run_id"
      exit 0
    fi
    emit_failed_ci_report "$conclusion" "$url" "$run_id" "$log_file" >&2
    exit 1
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|--branch) branch="$2"; shift 2 ;;
      -c|--commit) commit="$2"; shift 2 ;;
      -w|--workflow) workflow="$2"; shift 2 ;;
      -o|--out) log_file="$2"; shift 2 ;;
      -R|--repo) GH_ACTIONS_REPO_ARGS=(-R "$2"); shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown check-ci arg: $1" ;;
    esac
  done

  if [ -z "$log_file" ]; then
    log_file="$(default_ci_log_file)"
  fi

  result="$(wait_for_ref "$workflow" "$branch" "$commit")"
  IFS=$'\t' read -r conclusion url run_id <<<"$result"

  if [ "$conclusion" = "success" ]; then
    printf 'CI succeeded: %s (run %s)\n' "$url" "$run_id"
    exit 0
  fi

  emit_failed_ci_report "$conclusion" "$url" "$run_id" "$log_file" >&2
  exit 1
}

cmd_require_token() {
  require_gh_token
}

main() {
  require_tools
  require_gh_token
  mark_git_workspace_safe
  local cmd="${1:-}"
  if [ -z "$cmd" ] || [ "$cmd" = "-h" ] || [ "$cmd" = "--help" ]; then
    usage
    exit 0
  fi
  shift

  case "$cmd" in
    resolve-run) cmd_resolve_run "$@" ;;
    wait-run) cmd_wait_run "$@" ;;
    pull-logs) cmd_pull_logs "$@" ;;
    check-ci) cmd_check_ci "$@" ;;
    require-token) cmd_require_token "$@" ;;
    *) die "unknown command: ${cmd}" ;;
  esac
}

main "$@"
