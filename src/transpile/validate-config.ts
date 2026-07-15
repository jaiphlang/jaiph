import type { jaiphModule, WorkflowMetadata } from "../types";
import { configValueHasInterpolation } from "../parse/metadata";
import { Diagnostics } from "../diagnostics";
import { validateSimpleInterpolationIdentifiers } from "./validate-string";

type StringField = {
  key: string;
  read: (meta: WorkflowMetadata) => string | undefined;
};

const STRING_FIELDS: StringField[] = [
  { key: "agent.model", read: (m) => m.agent?.model },
  { key: "agent.command", read: (m) => m.agent?.command },
  { key: "agent.backend", read: (m) => m.agent?.backend },
  { key: "agent.trusted_workspace", read: (m) => m.agent?.trustedWorkspace },
  { key: "agent.cursor_flags", read: (m) => m.agent?.cursorFlags },
  { key: "agent.claude_flags", read: (m) => m.agent?.claudeFlags },
  { key: "run.logs_dir", read: (m) => m.run?.logsDir },
  { key: "runtime.docker_image", read: (m) => m.runtime?.dockerImage },
  { key: "runtime.docker_network", read: (m) => m.runtime?.dockerNetwork },
  { key: "module.name", read: (m) => m.module?.name },
  { key: "module.version", read: (m) => m.module?.version },
  { key: "module.description", read: (m) => m.module?.description },
];

function validateMetadataInterpolation(
  diag: Diagnostics,
  filePath: string,
  meta: WorkflowMetadata | undefined,
  knownVars: Set<string>,
  scopeLabel: "workflow" | "rule",
  line: number,
): void {
  if (!meta) return;
  for (const field of STRING_FIELDS) {
    const value = field.read(meta);
    if (value === undefined || !configValueHasInterpolation(value)) continue;
    diag.capture(() => {
      validateSimpleInterpolationIdentifiers(
        value,
        filePath,
        line,
        1,
        `config ${field.key}`,
        knownVars,
        scopeLabel,
      );
    });
  }
}

export function validateConfigInto(ast: jaiphModule, diag: Diagnostics): void {
  const moduleVars = new Set<string>();
  if (ast.envDecls) {
    for (const decl of ast.envDecls) moduleVars.add(decl.name);
  }

  diag.capture(() => {
    validateMetadataInterpolation(diag, ast.filePath, ast.metadata, moduleVars, "rule", 1);
  });

  for (const workflow of ast.workflows) {
    const wfVars = new Set(moduleVars);
    for (const param of workflow.params) wfVars.add(param);
    diag.capture(() => {
      validateMetadataInterpolation(diag, ast.filePath, workflow.metadata, wfVars, "workflow", workflow.loc.line);
    });
  }
}
