import { inlineScriptName } from "../inline-script-name";
import type { jaiphModule, WorkflowStepDef } from "../types";
import { scriptShebangIsBash } from "../parse/script-bash";

/**
 * Replace `alias.name` patterns in shell commands with
 * the fully-qualified symbol (`symbol::name`) used in generated script bodies.
 */
export function resolveShellRefs(
  command: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  for (const [alias, symbol] of importedWorkflowSymbols) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`,
      "g",
    );
    command = command.replace(pattern, `${symbol}::$1`);
  }
  return command;
}

/** Bash requires no space around = in local/export/readonly. */
export function normalizeShellLocalExport(command: string): string {
  return command.replace(
    /\b(local|export|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)\s+=\s+/g,
    "$1 $2=",
  );
}

function emitScriptBodyLine(cmd: string, importedWorkflowSymbols: Map<string, string>): string {
  const t = cmd.trim();
  if (/^\s*return\s*$/.test(t)) {
    return "return $?";
  }
  const ret = t.match(/^return\s+(.+)$/s);
  if (ret) {
    const arg = ret[1].trim();
    const isBashExitCode =
      /^[0-9]+$/.test(arg) ||
      arg === "$?" ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(arg);
    if (isBashExitCode) {
      return t.replace(/^\s*return\s+/, "return ");
    }
  }
  return normalizeShellLocalExport(resolveShellRefs(cmd, importedWorkflowSymbols));
}

function wrapBashStandaloneScriptBody(body: string, envPreamble: string): string {
  const preamble = envPreamble ? `${envPreamble}\n` : "";
  if (!body.trim()) {
    return ["set -euo pipefail", "__jaiph_script_entry() {", preamble, "}", '__jaiph_script_entry "$@"'].join(
      "\n",
    );
  }
  // Do not indent body lines inside the function: prefixing each line with spaces
  // corrupts multiline double-quoted strings and here-doc-style continuations.
  return [
    "set -euo pipefail",
    "__jaiph_script_entry() {",
    preamble,
    body,
    "}",
    '__jaiph_script_entry "$@"',
  ].join("\n");
}

export type ScriptArtifact = { name: string; content: string };

/** Collect all inline script steps from a step tree (handles if/else/recover nesting). */
function collectInlineScripts(
  steps: WorkflowStepDef[],
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  for (const s of steps) {
    if (s.type === "run_inline_script") {
      emitInlineScriptArtifact(s.body, s.shebang, seen, out);
    } else if (s.type === "const" && s.value.kind === "run_inline_script_capture") {
      emitInlineScriptArtifact(s.value.body, s.value.shebang, seen, out);
    } else if (s.type === "if") {
      collectInlineScripts(s.thenSteps, seen, out);
      if (s.elseIfBranches) {
        for (const br of s.elseIfBranches) collectInlineScripts(br.thenSteps, seen, out);
      }
      if (s.elseSteps) collectInlineScripts(s.elseSteps, seen, out);
    } else if (s.type === "ensure" && s.recover) {
      const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
      collectInlineScripts(recoverSteps, seen, out);
    }
  }
}

function emitInlineScriptArtifact(
  body: string,
  shebang: string | undefined,
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  const name = inlineScriptName(body, shebang);
  if (seen.has(name)) return;
  seen.add(name);
  const resolvedShebang = shebang ?? "#!/usr/bin/env bash";
  const isBash = scriptShebangIsBash(shebang);
  // Inline script body uses \n as newline escape in the DSL string
  const expandedBody = body.replace(/\\n/g, "\n");
  const wrapped = isBash ? wrapBashStandaloneScriptBody(expandedBody, "") : expandedBody;
  const content = wrapped.length > 0 ? `${resolvedShebang}\n${wrapped}\n` : `${resolvedShebang}\n`;
  out.push({ name, content });
}

export function buildScriptFiles(
  ast: jaiphModule,
  importedWorkflowSymbols: Map<string, string>,
  _workflowSymbol: string,
): ScriptArtifact[] {
  const out: ScriptArtifact[] = [];
  for (const sc of ast.scripts) {
    const shebang = sc.shebang ?? "#!/usr/bin/env bash";
    const rawBody = scriptShebangIsBash(sc.shebang)
      ? sc.commands.map((c) => emitScriptBodyLine(c, importedWorkflowSymbols)).join("\n")
      : sc.commands.join("\n");
    const body = scriptShebangIsBash(sc.shebang)
      ? wrapBashStandaloneScriptBody(rawBody, "")
      : rawBody;
    const content = body.length > 0 ? `${shebang}\n${body}\n` : `${shebang}\n`;
    out.push({ name: sc.name, content });
  }

  // Emit inline script artifacts from workflow/rule steps
  const seen = new Set<string>();
  for (const w of ast.workflows) collectInlineScripts(w.steps, seen, out);
  for (const r of ast.rules) collectInlineScripts(r.steps, seen, out);

  return out;
}
