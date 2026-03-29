set -euo pipefail
export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/scripts" && pwd)}"

bootstrap_project::nodejs::impl() {
  echo "Sorry, I cannot setup nodejs yet"
  exit 1
}

bootstrap_project::nodejs() {
  jaiph::run_step bootstrap_project::nodejs workflow bootstrap_project::nodejs::impl "$@"
}
