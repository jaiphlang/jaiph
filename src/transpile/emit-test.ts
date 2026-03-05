import type { jaiphModule, TestStepDef } from "../types";

function escapeBashSingleQuoted(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Sanitize symbol for mock script filename (matches jaiph::sanitize_name in steps.sh). */
function sanitizeSymbolForFile(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function refToWorkflowSymbol(ref: string, importedWorkflowSymbols: Map<string, string>): string {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const sym = Array.from(importedWorkflowSymbols.values())[0];
    return `${sym ?? ref}::workflow::${parts[0]}`;
  }
  const alias = parts[0];
  const name = parts[1];
  const sym = importedWorkflowSymbols.get(alias) ?? alias;
  return `${sym}::workflow::${name}`;
}

function refToRuleSymbol(ref: string, importedWorkflowSymbols: Map<string, string>): string {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const sym = Array.from(importedWorkflowSymbols.values())[0];
    return `${sym ?? ref}::rule::${parts[0]}`;
  }
  const alias = parts[0];
  const name = parts[1];
  const sym = importedWorkflowSymbols.get(alias) ?? alias;
  return `${sym}::rule::${name}`;
}

function refToFunctionSymbol(ref: string, importedWorkflowSymbols: Map<string, string>): string {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const sym = Array.from(importedWorkflowSymbols.values())[0];
    return `${sym ?? ref}::function::${parts[0]}`;
  }
  const alias = parts[0];
  const name = parts[1];
  const sym = importedWorkflowSymbols.get(alias) ?? alias;
  return `${sym}::function::${name}`;
}

function emitMockDispatchScript(
  step: { branches: Array<{ pattern: string; response: string }>; elseResponse?: string },
  escape: (s: string) => string,
): string[] {
  const lines: string[] = ["#!/usr/bin/env bash", "set -euo pipefail", 'prompt="${1:-}"'];
  for (let i = 0; i < step.branches.length; i += 1) {
    const { pattern, response } = step.branches[i];
    const cond = i === 0 ? "if" : "elif";
    lines.push(`${cond} [[ "$prompt" == *${escape(pattern)}* ]]; then`);
    lines.push(`  printf '%s' ${escape(response)}`);
  }
  if (step.elseResponse !== undefined) {
    lines.push("else");
    lines.push(`  printf '%s' ${escape(step.elseResponse)}`);
  } else {
    lines.push("else");
    lines.push('  echo "jai: no mock matched prompt (no branch matched). Prompt preview: ${prompt:0:80}..." >&2');
    lines.push("  exit 1");
  }
  lines.push("fi");
  return lines;
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
    const hasMockBlock = block.steps.some((s) => s.type === "test_mock_prompt_block");
    const symbolMocks = block.steps.filter(
      (s): s is TestStepDef & { ref: string; body: string } =>
        s.type === "test_mock_workflow" || s.type === "test_mock_rule" || s.type === "test_mock_function",
    );
    const funcName = `jaiph__test_${testIndex}`;
    out.push(`${funcName}() {`);
    out.push(`  jaiph__test_name=${escapeBashSingleQuoted(block.description)}`);
    if (symbolMocks.length > 0) {
      out.push(`  jaiph__mock_dir=$(mktemp -d)`);
      out.push(`  trap 'rm -rf "$jaiph__mock_dir"' RETURN`);
      for (const mock of symbolMocks) {
        const symbol =
          mock.type === "test_mock_workflow"
            ? refToWorkflowSymbol(mock.ref, importedWorkflowSymbols)
            : mock.type === "test_mock_rule"
              ? refToRuleSymbol(mock.ref, importedWorkflowSymbols)
              : refToFunctionSymbol(mock.ref, importedWorkflowSymbols);
        const safeName = sanitizeSymbolForFile(symbol);
        out.push(`  cat > "$jaiph__mock_dir/${safeName}" << 'JAIPH_MOCK_SCRIPT_EOF'`);
        out.push("#!/usr/bin/env bash");
        out.push(mock.body);
        out.push(`JAIPH_MOCK_SCRIPT_EOF`);
        out.push(`  chmod +x "$jaiph__mock_dir/${safeName}"`);
      }
      out.push(`  export JAIPH_MOCK_SCRIPTS_DIR="$jaiph__mock_dir"`);
    } else {
      out.push(`  unset JAIPH_MOCK_SCRIPTS_DIR`);
    }
    if (hasMockBlock) {
      const mockBlockStep = block.steps.find((s) => s.type === "test_mock_prompt_block");
      if (mockBlockStep && mockBlockStep.type === "test_mock_prompt_block") {
        const dispatchScript = emitMockDispatchScript(mockBlockStep, escapeBashSingleQuoted);
        out.push(`  jaiph__mock_dispatch_script=$(mktemp)`);
        out.push(
          `  trap '${symbolMocks.length > 0 ? 'rm -rf "$jaiph__mock_dir"; ' : ""}rm -f "$jaiph__mock_dispatch_script"' RETURN`,
        );
        out.push(`  cat > "$jaiph__mock_dispatch_script" << 'JAIPH_MOCK_EOF'`);
        for (const scriptLine of dispatchScript) {
          out.push(scriptLine);
        }
        out.push(`JAIPH_MOCK_EOF`);
        out.push(`  chmod +x "$jaiph__mock_dispatch_script"`);
        out.push(`  export JAIPH_MOCK_DISPATCH_SCRIPT="$jaiph__mock_dispatch_script"`);
        out.push(`  unset JAIPH_MOCK_RESPONSES_FILE`);
      }
    } else {
      out.push(`  jaiph__mock_file=$(mktemp)`);
      out.push(
        `  trap '${symbolMocks.length > 0 ? 'rm -rf "$jaiph__mock_dir"; ' : ""}rm -f "$jaiph__mock_file"' RETURN`,
      );
      out.push(`  unset JAIPH_MOCK_DISPATCH_SCRIPT`);
    }
    for (const step of block.steps) {
      if (step.type === "test_shell") {
        out.push(`  ${step.command}`);
        continue;
      }
      if (step.type === "test_mock_prompt") {
        if (!hasMockBlock) {
          out.push(`  printf '%s\\n' ${escapeBashSingleQuoted(step.response)} >> "$jaiph__mock_file"`);
        }
        continue;
      }
      if (step.type === "test_mock_prompt_block") {
        continue;
      }
      if (step.type === "test_mock_workflow" || step.type === "test_mock_rule" || step.type === "test_mock_function") {
        continue;
      }
      if (step.type === "test_run_workflow") {
        const workflowSymbol = refToWorkflowSymbol(step.workflowRef, importedWorkflowSymbols);
        if (!hasMockBlock) {
          out.push(`  export JAIPH_MOCK_RESPONSES_FILE="$jaiph__mock_file"`);
        }
        const args = step.args?.length ? step.args.map(escapeBashSingleQuoted).join(" ") : "";
        out.push("  set +e");
        out.push(`  jaiph__test_out=$(mktemp)`);
        if (step.captureName) {
          out.push(
            `  ${workflowSymbol} ${args} 2>&1 | sed '/^__JAIPH_EVENT__/d' > "$jaiph__test_out"`,
          );
        } else {
          out.push(
            `  ${workflowSymbol} ${args} 2>&1 | sed '/^__JAIPH_EVENT__/d' > "$jaiph__test_out"`,
          );
        }
        out.push("  jaiph__test_exit=${PIPESTATUS[0]}");
        if (step.captureName) {
          out.push(`  ${step.captureName}=$(cat "$jaiph__test_out")`);
        }
        out.push(`  rm -f "$jaiph__test_out"`);
        out.push("  set -e");
        if (!step.allowFailure) {
          out.push("  if [[ $jaiph__test_exit -ne 0 ]]; then");
          out.push('    echo "jai: workflow exited with status $jaiph__test_exit" >&2');
          out.push("    return 1");
          out.push("  fi");
        }
        continue;
      }
      if (step.type === "test_expect_contain") {
        out.push(`  jaiph__expect_contain "$${step.variable}" ${escapeBashSingleQuoted(step.substring)}`);
        continue;
      }
      if (step.type === "test_expect_equal") {
        out.push(`  jaiph__expect_equal "$${step.variable}" ${escapeBashSingleQuoted(step.expected)}`);
        continue;
      }
    }
    out.push("}");
    out.push("");
    testIndex += 1;
  }

  out.push("jaiph__run_tests() {");
  out.push("  local bold=$'\\e[1m' reset=$'\\e[0m' red=$'\\e[31m' green=$'\\e[32m'");
  out.push('  echo -e "${bold}testing${reset} $jaiph__test_display_name"');
  const n = ast.tests!.length;
  const lastIdx = n - 1;
  out.push("  local total=0 failed=0 i start elapsed branch desc desc_show err_file line detail_prefix");
  out.push("  local -a failed_names=()");
  out.push(`  for ((i=0; i<${n}; i++)); do`);
  out.push(`    desc="\${${descsVar}[${"$"}i]}"`);
  out.push('    desc_show="${desc/runs/${bold}test${reset}}"');
  out.push("    start=$SECONDS");
  out.push("    err_file=$(mktemp)");
  out.push(`    if jaiph__test_${"$"}i 2>"$err_file"; then`);
  out.push("      elapsed=$((SECONDS - start))");
  out.push(`      [[ $i -eq ${lastIdx} ]] && branch="└──" || branch="├──"`);
  out.push('      echo -e "  $branch $desc_show (${elapsed}s)"');
  out.push("    else");
  out.push("      failed=$((failed + 1))");
  out.push('      failed_names+=("$desc")');
  out.push("      elapsed=$((SECONDS - start))");
  out.push(`      [[ $i -eq ${lastIdx} ]] && branch="└──" || branch="├──"`);
  out.push('      echo -e "  $branch $desc_show (${elapsed}s failed)"');
      out.push(`      [[ $i -eq ${lastIdx} ]] && detail_prefix="     " || detail_prefix="  │  "`);
  out.push('      if [[ -s "$err_file" ]]; then');
      out.push('        while IFS= read -r line || [[ -n "$line" ]]; do');
      out.push('          echo "${detail_prefix}$line"');
  out.push('        done < "$err_file"');
  out.push("      fi");
      out.push(`      if [[ $i -ne ${lastIdx} ]]; then`);
      out.push('        echo "${detail_prefix}"');
      out.push("      fi");
  out.push("    fi");
  out.push('    rm -f "$err_file"');
  out.push("    total=$((total + 1))");
  out.push("  done");
  out.push("  if [[ $failed -gt 0 ]]; then");
  out.push('    echo ""');
  out.push('    echo -e "${bold}${red}✗ $failed / $total test(s) failed${reset}"');
  out.push('    for name in "${failed_names[@]}"; do echo "  - $name"; done');
  out.push("    return 1");
  out.push("  fi");
  out.push('  echo -e "${bold}${green}✓ $total test(s) passed${reset}"');
  out.push("  return 0");
  out.push("}");
  out.push("");
  out.push("jaiph__run_tests");

  return out.join("\n").trimEnd();
}
