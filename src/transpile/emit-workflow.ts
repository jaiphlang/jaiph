import type { jaiphModule, SourceLoc } from "../types";
import {
  type StepEmitCtx,
  emitStep,
  transpileWorkflowRef,
} from "./emit-steps";
import { emitRuleFunctions } from "./emit-rule";
import { buildScriptFiles, emitScriptFunctions } from "./emit-script";
import {
  bashSingleQuotedSegment,
  emitMetadataScopeFunction,
  expandTopLevelEnvDeclReferences,
  metadataToAssignments,
} from "./emit-workflow-helpers";

/** Maps generated `.sh` line numbers back to `.jh` locations (sidecar `.jaiph.map`). */
export type JaiphSourceLineMapEntry = {
  bashLine: number;
  source: string;
  line: number;
  col: number;
};

export type EmittedModule = {
  module: string;
  scripts: Array<{ name: string; content: string }>;
  sourceLineMap?: JaiphSourceLineMapEntry[];
};

function hasManagedAsyncRun(steps: jaiphModule["workflows"][number]["steps"]): boolean {
  for (const step of steps) {
    if (step.type === "run" && step.args && /&\s*$/.test(step.args.trim()) && !step.captureName) {
      return true;
    }
    if (step.type === "if") {
      if (hasManagedAsyncRun(step.thenSteps)) return true;
      if (step.elseSteps && hasManagedAsyncRun(step.elseSteps)) return true;
      if (step.elseIfBranches) {
        for (const br of step.elseIfBranches) {
          if (hasManagedAsyncRun(br.thenSteps)) return true;
        }
      }
    }
  }
  return false;
}

export function emitWorkflow(
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
  importedModuleHasMetadata: Map<string, boolean>,
  importedScriptNames: Map<string, Set<string>>,
  jaiphScriptsRelFromModuleDir: string,
): EmittedModule {
  const sourceLineMap: JaiphSourceLineMapEntry[] = [];
  const recordSourceLine = (bashLine: number, loc: SourceLoc): void => {
    sourceLineMap.push({ bashLine, source: ast.filePath, line: loc.line, col: loc.col });
  };

  const scopedMetadataAssignments = ast.metadata ? metadataToAssignments(ast.metadata) : [];
  const hasModuleMetadataScope = scopedMetadataAssignments.length > 0;
  const out: string[] = [];
  out.push("#!/usr/bin/env bash");
  out.push("");
  out.push("set -euo pipefail");
  out.push('jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"');
  out.push('if [[ ! -f "$jaiph_stdlib_path" ]]; then');
  out.push('  echo "jaiph: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2');
  out.push("  exit 1");
  out.push("fi");
  out.push('source "$jaiph_stdlib_path"');
  out.push('if [[ -z "${JAIPH_RUN_STEP_MODULE:-}" ]]; then');
  out.push(
    '  export JAIPH_RUN_STEP_MODULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"',
  );
  out.push("fi");
  out.push(
    'export JAIPH_LIB="${JAIPH_LIB:-${JAIPH_WORKSPACE:-.}/.jaiph/lib}"',
  );
  const scriptsPathExpr = `$(cd "$(dirname "\${BASH_SOURCE[0]}")/${jaiphScriptsRelFromModuleDir}" && pwd)`;
  out.push(`export JAIPH_SCRIPTS="\${JAIPH_SCRIPTS:-${scriptsPathExpr}}"`);
  out.push('if [[ "$(jaiph__runtime_api)" != "1" ]]; then');
  out.push('  echo "jaiph: incompatible jaiph stdlib runtime (required api=1)" >&2');
  out.push("  exit 1");
  out.push("fi");
  out.push("exec 7>&1");
  out.push("export JAIPH_STDOUT_SAVED=1");
  if (ast.metadata) {
    if (ast.metadata.agent?.defaultModel !== undefined) {
      const v = ast.metadata.agent.defaultModel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_MODEL="\${JAIPH_AGENT_MODEL:-${v}}"`);
    }
    if (ast.metadata.agent?.command !== undefined) {
      const v = ast.metadata.agent.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_COMMAND="\${JAIPH_AGENT_COMMAND:-${v}}"`);
    }
    if (ast.metadata.agent?.backend !== undefined) {
      const v = ast.metadata.agent.backend.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_BACKEND="\${JAIPH_AGENT_BACKEND:-${v}}"`);
    }
    if (ast.metadata.agent?.trustedWorkspace !== undefined) {
      const v = ast.metadata.agent.trustedWorkspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_TRUSTED_WORKSPACE="\${JAIPH_AGENT_TRUSTED_WORKSPACE:-${v}}"`);
    }
    if (ast.metadata.agent?.cursorFlags !== undefined) {
      const v = ast.metadata.agent.cursorFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_CURSOR_FLAGS="\${JAIPH_AGENT_CURSOR_FLAGS:-${v}}"`);
    }
    if (ast.metadata.agent?.claudeFlags !== undefined) {
      const v = ast.metadata.agent.claudeFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_CLAUDE_FLAGS="\${JAIPH_AGENT_CLAUDE_FLAGS:-${v}}"`);
    }
    if (ast.metadata.run?.logsDir !== undefined) {
      const v = ast.metadata.run.logsDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_RUNS_DIR="\${JAIPH_RUNS_DIR:-${v}}"`);
    }
    if (ast.metadata.run?.debug === true) {
      out.push('export JAIPH_DEBUG="${JAIPH_DEBUG:-true}"');
    }
    if (ast.metadata.run?.inboxParallel === true) {
      out.push('export JAIPH_INBOX_PARALLEL="${JAIPH_INBOX_PARALLEL:-true}"');
    }
    if (ast.metadata.agent || ast.metadata.run) {
      out.push("");
    }
  }
  for (const rel of importSourcePaths) {
    out.push(`source "$(dirname "\${BASH_SOURCE[0]}")/${rel}"`);
  }
  out.push("");
  const envPrefix = workflowSymbol.replace(/::/g, "__");
  const envDecls = ast.envDecls ?? [];
  if (envDecls.length > 0) {
    const rawByName = new Map(envDecls.map((e) => [e.name, e.value]));
    for (const env of envDecls) {
      const expanded = expandTopLevelEnvDeclReferences(ast.filePath, rawByName, env.value, new Set());
      const escaped = expanded.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export ${envPrefix}__${env.name}="${escaped}"`);
    }
    out.push("");
  }
  if (scopedMetadataAssignments.length > 0) {
    emitMetadataScopeFunction(out, `${workflowSymbol}::with_metadata_scope`, scopedMetadataAssignments, false);
  }

  const emitEnvShims = (indent: string): void => {
    for (const env of envDecls) {
      out.push(`${indent}local ${env.name}="\$${envPrefix}__${env.name}"`);
    }
  };

  emitRuleFunctions(
    out,
    ast,
    workflowSymbol,
    importedWorkflowSymbols,
    importedModuleHasMetadata,
    importedScriptNames,
    hasModuleMetadataScope,
    emitEnvShims,
    recordSourceLine,
  );
  emitScriptFunctions(out, ast, workflowSymbol, hasModuleMetadataScope);

  const localScriptNames = new Set(ast.scripts.map((s) => s.name));
  for (const workflow of ast.workflows) {
    const wfSymbol = `${workflowSymbol}::${workflow.name}`;
    const ctx: StepEmitCtx = {
      workflowSymbol,
      importedWorkflowSymbols,
      importedModuleHasMetadata,
      localScriptNames,
      importedScriptNames,
      filePath: ast.filePath,
      workflowName: workflow.name,
      inRecoverBlock: false,
      recordSourceLine,
      managedAsyncTracking: hasManagedAsyncRun(workflow.steps),
    };

    const wfMetaAssignments = workflow.metadata ? metadataToAssignments(workflow.metadata) : [];
    const hasWorkflowScope = wfMetaAssignments.length > 0;
    if (hasWorkflowScope) {
      emitMetadataScopeFunction(out, `${wfSymbol}::with_metadata_scope`, wfMetaAssignments, true);
    }
    const scopePrefix = hasWorkflowScope
      ? `${wfSymbol}::with_metadata_scope `
      : scopedMetadataAssignments.length > 0
        ? `${workflowSymbol}::with_metadata_scope `
        : "";

    for (const comment of workflow.comments) {
      out.push(comment);
    }
    const hasRoutes = workflow.routes && workflow.routes.length > 0;
    out.push(`${wfSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    if (ctx.managedAsyncTracking) {
      out.push("  local -a _jaiph_async_run_pids=()");
    }
    emitEnvShims("  ");
    out.push(
      `  jaiph::emit_workflow_summary_event WORKFLOW_START '${bashSingleQuotedSegment(workflow.name)}'`,
    );
    if (hasRoutes) {
      out.push("  jaiph::inbox_init");
      for (const route of workflow.routes!) {
        const targetFuncs = route.workflows.map((wfRef) =>
          transpileWorkflowRef(wfRef, workflowSymbol, importedWorkflowSymbols),
        );
        out.push(`  jaiph::register_route '${route.channel}' ${targetFuncs.map((f) => `'${f}'`).join(" ")}`);
      }
    }
    if (workflow.steps.length === 0 && !hasRoutes) {
      out.push("  :");
    } else {
      for (const step of workflow.steps) {
        emitStep(out, "  ", step, ctx);
      }
    }
    if (hasRoutes) {
      out.push("  jaiph::drain_queue");
    }
    out.push(
      `  jaiph::emit_workflow_summary_event WORKFLOW_END '${bashSingleQuotedSegment(workflow.name)}'`,
    );
    out.push("}");
    out.push("");
    out.push(`${wfSymbol}() {`);
    if (scopePrefix) {
      out.push(
        `  ${scopePrefix}jaiph::run_step ${wfSymbol} workflow ${wfSymbol}::impl "$@"`,
      );
    } else {
      out.push(
        `  jaiph::run_step ${wfSymbol} workflow ${wfSymbol}::impl "$@"`,
      );
    }
    out.push("}");
    out.push("");
  }

  out.push('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then');
  out.push("  __jaiph_status=0");
  out.push("  __jaiph_write_meta() {");
  out.push('    local status_value="$1"');
  out.push('    if [[ -n "${JAIPH_META_FILE:-}" ]]; then');
  out.push('      printf "status=%s\\n" "$status_value" > "$JAIPH_META_FILE"');
  out.push('      printf "run_dir=%s\\n" "${JAIPH_RUN_DIR:-}" >> "$JAIPH_META_FILE"');
  out.push('      printf "summary_file=%s\\n" "${JAIPH_RUN_SUMMARY_FILE:-}" >> "$JAIPH_META_FILE"');
  out.push("    fi");
  out.push("  }");
  out.push('  trap \'__jaiph_status=$?; __jaiph_write_meta "$__jaiph_status"\' EXIT');
  out.push('  if [[ "${JAIPH_DEBUG:-}" == "true" ]]; then');
  out.push("    set -x");
  out.push("  fi");
  out.push('  __jaiph_mode="${1:-__jaiph_workflow}"');
  out.push("  case \"$__jaiph_mode\" in");
  out.push("    __jaiph_dispatch)");
  out.push("      shift");
  out.push('      __jaiph_target="${1:-}"');
  out.push("      shift");
  out.push('      if [[ -z "$__jaiph_target" ]]; then');
  out.push('        echo "jaiph inbox: missing dispatch target" >&2');
  out.push("        exit 1");
  out.push("      fi");
  out.push('      if ! declare -F "$__jaiph_target" >/dev/null; then');
  out.push('        echo "jaiph inbox: unknown dispatch target: $__jaiph_target" >&2');
  out.push("        exit 1");
  out.push("      fi");
  out.push('      "$__jaiph_target" "$@"');
  out.push("      ;;");
  out.push("    __jaiph_workflow)");
  out.push("      shift");
  out.push('      __jaiph_workflow_name="${1:-default}"');
  out.push("      shift");
  out.push(`      __jaiph_entrypoint="${workflowSymbol}::\$__jaiph_workflow_name"`);
  out.push('      if ! declare -F "$__jaiph_entrypoint" >/dev/null; then');
  out.push('        if [[ "$__jaiph_workflow_name" == "default" ]]; then');
  out.push('          echo "jaiph run requires workflow \'default\' in the input file" >&2');
  out.push("        else");
  out.push('          echo "jaiph run requires workflow \'$__jaiph_workflow_name\' in the input file" >&2');
  out.push("        fi");
  out.push("        exit 1");
  out.push("      fi");
  out.push('      "$__jaiph_entrypoint" "$@"');
  out.push("      ;;");
  out.push("    *)");
  out.push(`      __jaiph_entrypoint="${workflowSymbol}::default"`);
  out.push('      if ! declare -F "$__jaiph_entrypoint" >/dev/null; then');
  out.push('        echo "jaiph run requires workflow \'default\' in the input file" >&2');
  out.push("        exit 1");
  out.push("      fi");
  out.push('      "$__jaiph_entrypoint" "$@"');
  out.push("      ;;");
  out.push("  esac");
  out.push("fi");

  const scripts = buildScriptFiles(ast, importedWorkflowSymbols, workflowSymbol);
  return {
    module: out.join("\n").trimEnd(),
    scripts,
    sourceLineMap: sourceLineMap.length > 0 ? sourceLineMap : undefined,
  };
}
