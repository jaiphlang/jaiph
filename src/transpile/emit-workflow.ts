import type { jaiphModule } from "../types";
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

export type EmittedModule = {
  module: string;
  scripts: Array<{ name: string; content: string }>;
};

export function emitWorkflow(
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
  importedModuleHasMetadata: Map<string, boolean>,
  importedScriptNames: Map<string, Set<string>>,
  jaiphScriptsRelFromModuleDir: string,
): EmittedModule {
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

  const scripts = buildScriptFiles(ast, importedWorkflowSymbols, workflowSymbol);
  return { module: out.join("\n").trimEnd(), scripts };
}
