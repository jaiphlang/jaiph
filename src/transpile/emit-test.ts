import type { jaiphModule } from "../types";

function escapeBashSingleQuoted(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function emitTest(
  ast: jaiphModule,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
): string {
  const out: string[] = [];
  out.push("#!/usr/bin/env bash");
  out.push("");
  out.push("set -euo pipefail");
  out.push('jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"');
  out.push('if [[ ! -f "$jaiph_stdlib_path" ]]; then');
  out.push('  echo "jai: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2');
  out.push("  exit 1");
  out.push("fi");
  out.push('source "$jaiph_stdlib_path"');
  out.push('if [[ "$(jaiph__runtime_api)" != "1" ]]; then');
  out.push('  echo "jai: incompatible jaiph stdlib runtime (required api=1)" >&2');
  out.push("  exit 1");
  out.push("fi");
  const scriptDir = '$(dirname "${BASH_SOURCE[0]}")';
  for (const rel of importSourcePaths) {
    out.push(`source "${scriptDir}/${rel}"`);
  }
  out.push("");
  out.push('jaiph__test_display_name="${JAIPH_TEST_FILE:-$(basename "${BASH_SOURCE[0]}" .test.sh).test.jh}"');
  out.push("");

  const descsVar = "jaiph__test_descs";
  out.push(`${descsVar}=(`);
  for (const block of ast.tests!) {
    out.push(`  ${escapeBashSingleQuoted(block.description)}`);
  }
  out.push(")");
  out.push("");

  let testIndex = 0;
  for (const block of ast.tests!) {
    const funcName = `jaiph__test_${testIndex}`;
    out.push(`${funcName}() {`);
    out.push(`  jaiph__test_name=${escapeBashSingleQuoted(block.description)}`);
    out.push(`  jaiph__mock_file=$(mktemp)`);
    out.push(`  trap 'rm -f "$jaiph__mock_file"' RETURN`);
    for (const step of block.steps) {
      if (step.type === "test_shell") {
        out.push(`  ${step.command}`);
        continue;
      }
      if (step.type === "test_mock_prompt") {
        out.push(`  printf '%s\\n' ${escapeBashSingleQuoted(step.response)} >> "$jaiph__mock_file"`);
        continue;
      }
      if (step.type === "test_run_workflow") {
        const workflowSymbol = (() => {
          const parts = step.workflowRef.split(".");
          const alias = parts[0];
          const wfName = parts[1];
          const sym = importedWorkflowSymbols.get(alias) ?? alias;
          return `${sym}::workflow::${wfName}`;
        })();
        out.push(`  export JAIPH_MOCK_RESPONSES_FILE="$jaiph__mock_file"`);
        out.push("  set +e");
        out.push(`  ${step.captureName}=$(${workflowSymbol} 2>&1)`);
        out.push("  jaiph__test_exit=$?");
        out.push("  set -e");
        continue;
      }
      if (step.type === "test_expect_contain") {
        out.push(`  jaiph__expect_contain "$${step.variable}" ${escapeBashSingleQuoted(step.substring)}`);
        continue;
      }
    }
    out.push("}");
    out.push("");
    testIndex += 1;
  }

  out.push("jaiph__run_tests() {");
  out.push("  local bold=$'\\e[1m' reset=$'\\e[0m'");
  out.push('  echo -e "${bold}testing${reset} $jaiph__test_display_name"');
  const n = ast.tests!.length;
  const lastIdx = n - 1;
  out.push("  local total=0 failed=0 i start elapsed branch desc desc_show");
  out.push("  local -a failed_names=()");
  out.push(`  for ((i=0; i<${n}; i++)); do`);
  out.push(`    desc="\${${descsVar}[${"$"}i]}"`);
  out.push('    desc_show="${desc/runs/${bold}test${reset}}"');
  out.push("    start=$SECONDS");
  out.push(`    if jaiph__test_${"$"}i; then`);
  out.push("      elapsed=$((SECONDS - start))");
  out.push(`      [[ $i -eq ${lastIdx} ]] && branch="└──" || branch="├──"`);
  out.push('      echo -e "  $branch $desc_show (${elapsed}s)"');
  out.push("    else");
  out.push("      failed=$((failed + 1))");
  out.push('      failed_names+=("$desc")');
  out.push("      elapsed=$((SECONDS - start))");
  out.push(`      [[ $i -eq ${lastIdx} ]] && branch="└──" || branch="├──"`);
  out.push('      echo -e "  $branch $desc_show (${elapsed}s failed)" >&2');
  out.push("    fi");
  out.push("    total=$((total + 1))");
  out.push("  done");
  out.push("  if [[ $failed -gt 0 ]]; then");
  out.push('    echo "" >&2');
  out.push('    echo "✗ $failed / $total test(s) failed" >&2');
  out.push('    for name in "${failed_names[@]}"; do echo "  - $name" >&2; done');
  out.push("    return 1");
  out.push("  fi");
  out.push('  echo "✓ $total test(s) passed"');
  out.push("  return 0");
  out.push("}");
  out.push("");
  out.push("jaiph__run_tests");

  return out.join("\n").trimEnd();
}
