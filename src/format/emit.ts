import type {
  jaiphModule,
  WorkflowDef,
  RuleDef,
  ScriptDef,
  ChannelDef,
  EnvDeclDef,
  WorkflowMetadata,
  TopLevelEmitOrder,
} from "../types";
import { createTrivia, type Trivia } from "../parser";
import {
  emitComments,
  emitCommentBlock,
  emitFencedScriptBodyLines,
  tn,
} from "./emit-shared";
import { emitSteps } from "./emit-steps";
import { emitTestBlock } from "./emit-test";

// Module + declaration emitters: the `emitModule` entry point and the top-level
// declaration/config formatters. The step-tree and expression emitters live in
// `emit-steps.ts`, and the small shared helpers in `emit-shared.ts`, so this
// file stays under the analyzability line cap.

export interface EmitOptions {
  indent: number;
}

const DEFAULT_OPTIONS: EmitOptions = { indent: 2 };

function legacyTopLevelOrder(mod: jaiphModule): TopLevelEmitOrder[] {
  const o: TopLevelEmitOrder[] = [];
  if (mod.envDecls) {
    for (let i = 0; i < mod.envDecls.length; i++) o.push({ kind: "env", index: i });
  }
  for (let i = 0; i < mod.rules.length; i++) o.push({ kind: "rule", index: i });
  for (let i = 0; i < mod.scripts.length; i++) o.push({ kind: "script", index: i });
  for (let i = 0; i < mod.workflows.length; i++) o.push({ kind: "workflow", index: i });
  if (mod.tests) {
    for (let i = 0; i < mod.tests.length; i++) o.push({ kind: "test", index: i });
  }
  return o;
}

function topLevelOrderForEmit(mod: jaiphModule, trivia: Trivia): TopLevelEmitOrder[] {
  const order = trivia.getModule().topLevelOrder;
  if (order && order.length > 0) return order;
  return legacyTopLevelOrder(mod);
}

export function emitModule(
  mod: jaiphModule,
  triviaOrOpts: Trivia | EmitOptions = createTrivia(),
  optsArg?: EmitOptions,
): string {
  let trivia: Trivia;
  let opts: EmitOptions;
  if (triviaOrOpts instanceof Object && "indent" in triviaOrOpts && !("getModule" in triviaOrOpts)) {
    trivia = createTrivia();
    opts = triviaOrOpts as EmitOptions;
  } else {
    trivia = triviaOrOpts as Trivia;
    opts = optsArg ?? DEFAULT_OPTIONS;
  }
  const sections: string[] = [];
  const pad = " ".repeat(opts.indent);
  const modTrivia = trivia.getModule();

  const importLines: string[] = [];
  if (mod.scriptImports) {
    for (const si of mod.scriptImports) {
      const lc = tn(trivia, si).leadingComments;
      if (lc?.length) importLines.push(emitCommentBlock(lc));
      importLines.push(`import script "${si.path}" as ${si.alias}`);
    }
  }
  for (const imp of mod.imports) {
    const lc = tn(trivia, imp).leadingComments;
    if (lc?.length) importLines.push(emitCommentBlock(lc));
    importLines.push(`import "${imp.path}" as ${imp.alias}`);
  }
  if (importLines.length > 0) {
    sections.push(importLines.join("\n"));
  }

  if (mod.metadata) {
    if (modTrivia.configLeadingComments?.length) {
      sections.push(emitCommentBlock(modTrivia.configLeadingComments));
    }
    sections.push(emitConfig(mod.metadata, pad, trivia));
  }

  const channelLines: string[] = [];
  for (const ch of mod.channels) {
    const lc = tn(trivia, ch).leadingComments;
    if (lc?.length) channelLines.push(emitCommentBlock(lc));
    channelLines.push(emitChannel(ch));
  }
  if (channelLines.length > 0) {
    sections.push(channelLines.join("\n"));
  }

  const exportedNames = new Set(mod.exports);

  for (const item of topLevelOrderForEmit(mod, trivia)) {
    if (item.kind === "env") {
      const env = mod.envDecls![item.index];
      const envLines: string[] = [];
      if (env.comments?.length) {
        envLines.push(...emitComments(env.comments));
      }
      envLines.push(...emitEnvDecl(env));
      sections.push(envLines.join("\n"));
      continue;
    }
    if (item.kind === "rule") {
      sections.push(emitRule(mod.rules[item.index], pad, exportedNames.has(mod.rules[item.index].name), trivia));
      continue;
    }
    if (item.kind === "script") {
      sections.push(
        emitScript(mod.scripts[item.index], pad, exportedNames.has(mod.scripts[item.index].name), trivia),
      );
      continue;
    }
    if (item.kind === "workflow") {
      sections.push(
        emitWorkflow(
          mod.workflows[item.index],
          pad,
          exportedNames.has(mod.workflows[item.index].name),
          trivia,
        ),
      );
      continue;
    }
    sections.push(emitTestBlock(mod.tests![item.index], pad, trivia));
  }

  if (modTrivia.trailingTopLevelComments?.length) {
    sections.push(emitCommentBlock(modTrivia.trailingTopLevelComments));
  }

  return sections.join("\n\n") + "\n";
}

/** Emit a config string RHS, preserving bare-identifier sugar for a single `${name}` reference. */
function emitConfigStringRhs(value: string): string {
  const singleRef = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (singleRef) return singleRef[1]!;
  return JSON.stringify(value);
}

/**
 * Config keys in canonical emit order, used for the fallback when no original
 * `configBodySequence` is recorded.
 */
const DEFAULT_CONFIG_KEY_ORDER = [
  "agent.model",
  "agent.command",
  "agent.backend",
  "agent.trusted_workspace",
  "agent.cursor_flags",
  "agent.claude_flags",
  "run.debug",
  "run.logs_dir",
  "run.recover_limit",
  "module.name",
  "module.version",
  "module.description",
  "trusted_envs",
];

function emitConfigKeyLines(meta: WorkflowMetadata, key: string, pad: string): string[] {
  switch (key) {
    case "agent.model":
      if (meta.agent?.model === undefined) return [];
      return [`${pad}agent.model = ${emitConfigStringRhs(meta.agent.model)}`];
    case "agent.command":
      if (meta.agent?.command === undefined) return [];
      return [`${pad}agent.command = ${emitConfigStringRhs(meta.agent.command)}`];
    case "agent.backend":
      if (meta.agent?.backend === undefined) return [];
      return [`${pad}agent.backend = ${emitConfigStringRhs(meta.agent.backend)}`];
    case "agent.trusted_workspace":
      if (meta.agent?.trustedWorkspace === undefined) return [];
      return [`${pad}agent.trusted_workspace = ${emitConfigStringRhs(meta.agent.trustedWorkspace)}`];
    case "agent.cursor_flags":
      if (meta.agent?.cursorFlags === undefined) return [];
      return [`${pad}agent.cursor_flags = ${emitConfigStringRhs(meta.agent.cursorFlags)}`];
    case "agent.claude_flags":
      if (meta.agent?.claudeFlags === undefined) return [];
      return [`${pad}agent.claude_flags = ${emitConfigStringRhs(meta.agent.claudeFlags)}`];
    case "run.debug":
      if (meta.run?.debug === undefined) return [];
      return [`${pad}run.debug = ${meta.run.debug}`];
    case "run.logs_dir":
      if (meta.run?.logsDir === undefined) return [];
      return [`${pad}run.logs_dir = ${emitConfigStringRhs(meta.run.logsDir)}`];
    case "run.recover_limit":
      if (meta.run?.recoverLimit === undefined) return [];
      return [`${pad}run.recover_limit = ${meta.run.recoverLimit}`];
    case "module.name":
      if (meta.module?.name === undefined) return [];
      return [`${pad}module.name = ${emitConfigStringRhs(meta.module.name)}`];
    case "module.version":
      if (meta.module?.version === undefined) return [];
      return [`${pad}module.version = ${emitConfigStringRhs(meta.module.version)}`];
    case "module.description":
      if (meta.module?.description === undefined) return [];
      return [`${pad}module.description = ${emitConfigStringRhs(meta.module.description)}`];
    case "trusted_envs":
      if (meta.trustedEnvs === undefined) return [];
      return [`${pad}trusted_envs = ${emitConfigStringRhs(meta.trustedEnvs.join(" "))}`];
    default:
      return [];
  }
}

function emitConfig(meta: WorkflowMetadata, pad: string, trivia: Trivia): string {
  const lines: string[] = ["config {"];
  const seq = trivia.getNode(meta)?.configBodySequence;
  if (seq?.length) {
    for (const part of seq) {
      if (part.kind === "comment") {
        lines.push(`${pad}${part.text}`);
      } else {
        lines.push(...emitConfigKeyLines(meta, part.key, pad));
      }
    }
    lines.push("}");
    return lines.join("\n");
  }
  // No recorded body sequence: emit every set key in canonical order. This
  // mirrors emitConfigKeyLines exactly, so the two paths never diverge.
  for (const key of DEFAULT_CONFIG_KEY_ORDER) {
    lines.push(...emitConfigKeyLines(meta, key, pad));
  }
  lines.push("}");
  return lines.join("\n");
}

function emitEnvDecl(env: EnvDeclDef): string[] {
  if (env.value.includes("\n")) {
    const lines = [`const ${env.name} = """`];
    for (const bl of env.value.split("\n")) {
      lines.push(bl);
    }
    lines.push('"""');
    return lines;
  }
  if (env.wasQuoted) {
    // Author wrote a double-quoted string. Preserve the quoted form regardless
    // of value content (the formatter must not toggle delimiters based on
    // whether the value happens to contain a space).
    if (/["\\]/.test(env.value)) {
      return [`const ${env.name} = """`, env.value, '"""'];
    }
    return [`const ${env.name} = ${JSON.stringify(env.value)}`];
  }
  if (/^[A-Za-z0-9_./@+#%^&=*:~?-]+$/.test(env.value)) {
    return [`const ${env.name} = ${env.value}`];
  }
  if (/["\\]/.test(env.value)) {
    return [`const ${env.name} = """`, env.value, '"""'];
  }
  return [`const ${env.name} = ${JSON.stringify(env.value)}`];
}

function emitRule(rule: RuleDef, pad: string, exported: boolean, trivia: Trivia): string {
  const lines: string[] = [];
  lines.push(...emitComments(rule.comments));
  const paramStr = `(${rule.params.join(", ")})`;
  const prefix = exported ? "export " : "";
  lines.push(`${prefix}rule ${rule.name}${paramStr} {`);
  lines.push(...emitSteps(rule.steps, pad, pad, trivia));
  lines.push("}");
  return lines.join("\n");
}

function emitScript(script: ScriptDef, pad: string, exported: boolean, trivia: Trivia): string {
  const lines: string[] = [];
  lines.push(...emitComments(script.comments));
  const prefix = exported ? "export " : "";
  const bodyKind = tn(trivia, script).scriptBodyKind;
  if (bodyKind === "fenced" || script.lang || script.body.includes("\n")) {
    const langTag = script.lang ?? "";
    lines.push(`${prefix}script ${script.name} = \`\`\`${langTag}`);
    lines.push(...emitFencedScriptBodyLines(script.body, pad));
    lines.push("```");
  } else {
    lines.push(`${prefix}script ${script.name} = \`${script.body}\``);
  }
  return lines.join("\n");
}

function emitWorkflow(wf: WorkflowDef, pad: string, exported: boolean, trivia: Trivia): string {
  const lines: string[] = [];
  lines.push(...emitComments(wf.comments));

  const paramStr = `(${wf.params.join(", ")})`;
  const prefix = exported ? "export " : "";
  lines.push(`${prefix}workflow ${wf.name}${paramStr} {`);

  if (wf.metadata) {
    const configLines = emitConfig(wf.metadata, pad, trivia);
    for (const cl of configLines.split("\n")) {
      lines.push(`${pad}${cl}`);
    }
  }

  lines.push(...emitSteps(wf.steps, pad, pad, trivia));

  lines.push("}");
  return lines.join("\n");
}

function emitChannel(ch: ChannelDef): string {
  if (ch.routes && ch.routes.length > 0) {
    const targets = ch.routes.map((r) => r.value).join(", ");
    return `channel ${ch.name} -> ${targets}`;
  }
  return `channel ${ch.name}`;
}
