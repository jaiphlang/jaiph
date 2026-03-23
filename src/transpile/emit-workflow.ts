import { jaiphError } from "../errors";
import type { jaiphModule, WorkflowMetadata } from "../types";
import {
  type StepEmitCtx,
  emitStep,
  transpileRuleRef,
  transpileWorkflowRef,
  resolveShellRefs,
  normalizeShellLocalExport,
} from "./emit-steps";

/** All env vars managed by metadata scope functions. */
const SCOPED_VARS = [
  "JAIPH_AGENT_MODEL",
  "JAIPH_AGENT_COMMAND",
  "JAIPH_AGENT_BACKEND",
  "JAIPH_AGENT_TRUSTED_WORKSPACE",
  "JAIPH_AGENT_CURSOR_FLAGS",
  "JAIPH_AGENT_CLAUDE_FLAGS",
  "JAIPH_RUNS_DIR",
  "JAIPH_DEBUG",
];

/** Convert WorkflowMetadata agent/run keys to { envVarName, escapedValue } pairs. */
function metadataToAssignments(
  meta: WorkflowMetadata,
): Array<{ name: string; value: string }> {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const out: Array<{ name: string; value: string }> = [];
  if (meta.agent?.defaultModel !== undefined) out.push({ name: "JAIPH_AGENT_MODEL", value: esc(meta.agent.defaultModel) });
  if (meta.agent?.command !== undefined) out.push({ name: "JAIPH_AGENT_COMMAND", value: esc(meta.agent.command) });
  if (meta.agent?.backend !== undefined) out.push({ name: "JAIPH_AGENT_BACKEND", value: esc(meta.agent.backend) });
  if (meta.agent?.trustedWorkspace !== undefined) out.push({ name: "JAIPH_AGENT_TRUSTED_WORKSPACE", value: esc(meta.agent.trustedWorkspace) });
  if (meta.agent?.cursorFlags !== undefined) out.push({ name: "JAIPH_AGENT_CURSOR_FLAGS", value: esc(meta.agent.cursorFlags) });
  if (meta.agent?.claudeFlags !== undefined) out.push({ name: "JAIPH_AGENT_CLAUDE_FLAGS", value: esc(meta.agent.claudeFlags) });
  if (meta.run?.logsDir !== undefined) out.push({ name: "JAIPH_RUNS_DIR", value: esc(meta.run.logsDir) });
  if (meta.run?.debug !== undefined) out.push({ name: "JAIPH_DEBUG", value: meta.run.debug ? "true" : "false" });
  return out;
}

/**
 * Emit a `with_metadata_scope` function that saves/sets/restores env vars.
 * When `lockOverrides` is true, the scope also sets `_LOCKED=1` for each var
 * it overrides (and restores the old lock state on exit). This prevents inner
 * module-level scopes from reverting workflow-local overrides.
 */
function emitMetadataScopeFunction(
  out: string[],
  fnName: string,
  assignments: Array<{ name: string; value: string }>,
  lockOverrides: boolean,
): void {
  out.push(`${fnName}() {`);
  for (const name of SCOPED_VARS) {
    out.push(`  local __had_${name}=0`);
    out.push(`  local __old_${name}=""`);
    out.push(`  if [[ -n "\${${name}+x}" ]]; then`);
    out.push(`    __had_${name}=1`);
    out.push(`    __old_${name}="\${${name}}"`);
    out.push("  fi");
  }
  if (lockOverrides) {
    // Save current _LOCKED state for vars this scope overrides.
    for (const a of assignments) {
      out.push(`  local __old_${a.name}_LOCKED="\${${a.name}_LOCKED:-}"`);
    }
  }
  for (const a of assignments) {
    out.push(`  if [[ "\${${a.name}_LOCKED:-}" != "1" ]]; then`);
    out.push(`    export ${a.name}="${a.value}"`);
    if (lockOverrides) {
      out.push(`    export ${a.name}_LOCKED="1"`);
    }
    out.push("  fi");
  }
  out.push("  set +e");
  out.push('  "$@"');
  out.push("  local __jaiph_scoped_status=$?");
  out.push("  set -e");
  for (const name of SCOPED_VARS) {
    out.push(`  if [[ "$__had_${name}" == "1" ]]; then`);
    out.push(`    export ${name}="$__old_${name}"`);
    out.push("  else");
    out.push(`    unset ${name}`);
    out.push("  fi");
  }
  if (lockOverrides) {
    for (const a of assignments) {
      out.push(`  if [[ -n "$__old_${a.name}_LOCKED" ]]; then`);
      out.push(`    export ${a.name}_LOCKED="$__old_${a.name}_LOCKED"`);
      out.push("  else");
      out.push(`    unset ${a.name}_LOCKED`);
      out.push("  fi");
    }
  }
  out.push("  return $__jaiph_scoped_status");
  out.push("}");
  out.push("");
}

/**
 * Top-level env values are emitted as `export PREFIX__name="..."`. Bash expands
 * `$other` inside those double quotes while the script loads, but sibling locals
 * only exist as shims inside workflow/rule bodies — so `$sibling` must be inlined
 * at compile time.
 */
function expandTopLevelEnvDeclReferences(
  filePath: string,
  rawByName: Map<string, string>,
  value: string,
  expanding: Set<string>,
): string {
  const refRe = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  return value.replace(refRe, (full, braced?: string, plain?: string) => {
    const refName = braced ?? plain;
    if (refName === undefined) return full;
    if (!rawByName.has(refName)) return full;
    if (expanding.has(refName)) {
      throw jaiphError(
        filePath, 1, 1, "E_PARSE",
        `circular reference among top-level local declarations involving "${refName}"`,
      );
    }
    expanding.add(refName);
    try {
      const raw = rawByName.get(refName)!;
      return expandTopLevelEnvDeclReferences(filePath, rawByName, raw, expanding);
    } finally {
      expanding.delete(refName);
    }
  });
}

export function emitWorkflow(
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
  importedModuleHasMetadata: Map<string, boolean>,
): string {
  const scopedMetadataAssignments = ast.metadata ? metadataToAssignments(ast.metadata) : [];
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
  // Emit top-level env declarations as prefixed variables.
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

  /** Emit `local name="$prefix__name"` shims for all env declarations. */
  const emitEnvShims = (indent: string): void => {
    for (const env of envDecls) {
      out.push(`${indent}local ${env.name}="\$${envPrefix}__${env.name}"`);
    }
  };

  for (const rule of ast.rules) {
    const ruleSymbol = `${workflowSymbol}::${rule.name}`;
    for (const comment of rule.comments) {
      out.push(comment);
    }
    out.push(`${ruleSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    emitEnvShims("  ");
    if (rule.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of rule.commands) {
        if (cmd.startsWith("run ")) {
          throw jaiphError(
            ast.filePath,
            rule.loc.line,
            rule.loc.col,
            "E_PARSE",
            "`run` is not allowed inside a `rule` block.\nUse `ensure` to call another rule, or move this call to a `workflow`.",
          );
        }
        const ensureMatch = cmd.match(
          /^ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (ensureMatch) {
          const ref = { value: ensureMatch[1], loc: { line: 0, col: 0 } };
          const args = ensureMatch[2]?.trim();
          out.push(
            `  ${transpileRuleRef(ref, workflowSymbol, importedWorkflowSymbols)}${args ? ` ${args}` : ""}`,
          );
        } else {
          out.push(`  ${normalizeShellLocalExport(resolveShellRefs(cmd, importedWorkflowSymbols))}`);
        }
      }
    }
    out.push("}");
    out.push("");
    out.push(`${ruleSymbol}() {`);
    if (scopedMetadataAssignments.length > 0) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${ruleSymbol} rule jaiph::execute_readonly ${ruleSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${ruleSymbol} rule jaiph::execute_readonly ${ruleSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
  }

  for (const fn of ast.functions) {
    const functionSymbol = `${workflowSymbol}::${fn.name}`;
    for (const comment of fn.comments) {
      out.push(comment);
    }
    out.push(`${functionSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    emitEnvShims("  ");
    if (fn.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of fn.commands) {
        out.push(`  ${normalizeShellLocalExport(resolveShellRefs(cmd, importedWorkflowSymbols))}`);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${functionSymbol}() {`);
    if (scopedMetadataAssignments.length > 0) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step_passthrough ${functionSymbol} function ${functionSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step_passthrough ${functionSymbol} function ${functionSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
    out.push(`${fn.name}() {`);
    out.push(`  ${functionSymbol} "$@"`);
    out.push("}");
    out.push("");
  }

  for (const workflow of ast.workflows) {
    const wfSymbol = `${workflowSymbol}::${workflow.name}`;
    const ctx: StepEmitCtx = {
      workflowSymbol,
      importedWorkflowSymbols,
      importedModuleHasMetadata,
      filePath: ast.filePath,
      workflowName: workflow.name,
      inRecoverBlock: false,
    };

    // Determine which scope function this workflow uses.
    const wfMetaAssignments = workflow.metadata ? metadataToAssignments(workflow.metadata) : [];
    const hasWorkflowScope = wfMetaAssignments.length > 0;
    if (hasWorkflowScope) {
      // Workflow-level scope: locks its overrides so inner module-scope
      // calls (rule/function wrappers) do not revert workflow values.
      emitMetadataScopeFunction(out, `${wfSymbol}::with_metadata_scope`, wfMetaAssignments, true);
    }
    // Pick the most specific scope: workflow > module > none.
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

  return out.join("\n").trimEnd();
}
