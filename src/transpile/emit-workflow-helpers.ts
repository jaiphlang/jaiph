import { jaiphError } from "../errors";
import type { WorkflowMetadata } from "../types";

/** Embed in a bash single-quoted literal: '…' */
export function bashSingleQuotedSegment(s: string): string {
  return s.replace(/'/g, `'\"'\"'`);
}

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
  "JAIPH_INBOX_PARALLEL",
];

/** Convert WorkflowMetadata agent/run keys to { envVarName, escapedValue } pairs. */
export function metadataToAssignments(
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
  if (meta.run?.inboxParallel !== undefined) {
    out.push({ name: "JAIPH_INBOX_PARALLEL", value: meta.run.inboxParallel ? "true" : "false" });
  }
  return out;
}

/**
 * Emit a `with_metadata_scope` function that saves/sets/restores env vars.
 * When `lockOverrides` is true, the scope also sets `_LOCKED=1` for each var
 * it overrides (and restores the old lock state on exit). This prevents inner
 * module-level scopes from reverting workflow-local overrides.
 */
export function emitMetadataScopeFunction(
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
export function expandTopLevelEnvDeclReferences(
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
        `circular reference among top-level const declarations involving "${refName}"`,
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
