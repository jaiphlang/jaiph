import type {
  Arg,
  jaiphModule,
  WorkflowStepDef,
  ConstRhs,
  SendRhsDef,
  WorkflowDef,
  RuleDef,
  ScriptDef,
  ChannelDef,
  TestBlockDef,
  TestStepDef,
  EnvDeclDef,
  WorkflowMetadata,
  TopLevelEmitOrder,
} from "../types";
import { createTrivia, type NodeTrivia, type Trivia } from "../parse/trivia";

export interface EmitOptions {
  indent: number;
}

const DEFAULT_OPTIONS: EmitOptions = { indent: 2 };

/** Lookup helper: trivia entry for a node, with safe empty default. */
function tn(trivia: Trivia, node: object): NodeTrivia {
  return trivia.getNode(node) ?? {};
}

/** When `topLevelOrder` is missing (hand-built AST), match pre–source-order emit behavior. */
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
  // Backwards-compatible: callers may pass (mod, opts) when they don't care about trivia.
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

  // Shebang — we don't store it in the AST, so the caller must prepend it if needed.
  // (handled by the format command reading the first line of the original source)

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

/** Emit lines for one `key = value` inside `config { }` (matches canonical value formatting). */
function emitConfigKeyLines(meta: WorkflowMetadata, key: string, pad: string): string[] {
  switch (key) {
    case "agent.default_model":
      if (meta.agent?.defaultModel === undefined) return [];
      return [`${pad}agent.default_model = "${meta.agent.defaultModel}"`];
    case "agent.command":
      if (meta.agent?.command === undefined) return [];
      return [`${pad}agent.command = "${meta.agent.command}"`];
    case "agent.backend":
      if (meta.agent?.backend === undefined) return [];
      return [`${pad}agent.backend = "${meta.agent.backend}"`];
    case "agent.trusted_workspace":
      if (meta.agent?.trustedWorkspace === undefined) return [];
      return [`${pad}agent.trusted_workspace = "${meta.agent.trustedWorkspace}"`];
    case "agent.cursor_flags":
      if (meta.agent?.cursorFlags === undefined) return [];
      return [`${pad}agent.cursor_flags = "${meta.agent.cursorFlags}"`];
    case "agent.claude_flags":
      if (meta.agent?.claudeFlags === undefined) return [];
      return [`${pad}agent.claude_flags = "${meta.agent.claudeFlags}"`];
    case "run.debug":
      if (meta.run?.debug === undefined) return [];
      return [`${pad}run.debug = ${meta.run.debug}`];
    case "run.logs_dir":
      if (meta.run?.logsDir === undefined) return [];
      return [`${pad}run.logs_dir = "${meta.run.logsDir}"`];
    case "run.recover_limit":
      if (meta.run?.recoverLimit === undefined) return [];
      return [`${pad}run.recover_limit = ${meta.run.recoverLimit}`];
    case "runtime.docker_enabled":
      // runtime.docker_enabled was removed; skip silently for back-compat with
      // any cached AST that still carries the key in configBodySequence.
      return [];
    case "runtime.docker_image":
      if (meta.runtime?.dockerImage === undefined) return [];
      return [`${pad}runtime.docker_image = "${meta.runtime.dockerImage}"`];
    case "runtime.docker_network":
      if (meta.runtime?.dockerNetwork === undefined) return [];
      return [`${pad}runtime.docker_network = "${meta.runtime.dockerNetwork}"`];
    case "runtime.docker_timeout_seconds":
      if (meta.runtime?.dockerTimeoutSeconds === undefined) return [];
      return [`${pad}runtime.docker_timeout_seconds = ${meta.runtime.dockerTimeoutSeconds}`];
    case "module.name":
      if (meta.module?.name === undefined) return [];
      return [`${pad}module.name = "${meta.module.name}"`];
    case "module.version":
      if (meta.module?.version === undefined) return [];
      return [`${pad}module.version = "${meta.module.version}"`];
    case "module.description":
      if (meta.module?.description === undefined) return [];
      return [`${pad}module.description = "${meta.module.description}"`];
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
  if (meta.agent) {
    if (meta.agent.defaultModel !== undefined) lines.push(`${pad}agent.default_model = "${meta.agent.defaultModel}"`);
    if (meta.agent.command !== undefined) lines.push(`${pad}agent.command = "${meta.agent.command}"`);
    if (meta.agent.backend !== undefined) lines.push(`${pad}agent.backend = "${meta.agent.backend}"`);
    if (meta.agent.trustedWorkspace !== undefined) lines.push(`${pad}agent.trusted_workspace = "${meta.agent.trustedWorkspace}"`);
    if (meta.agent.cursorFlags !== undefined) lines.push(`${pad}agent.cursor_flags = "${meta.agent.cursorFlags}"`);
    if (meta.agent.claudeFlags !== undefined) lines.push(`${pad}agent.claude_flags = "${meta.agent.claudeFlags}"`);
  }
  if (meta.run) {
    if (meta.run.debug !== undefined) lines.push(`${pad}run.debug = ${meta.run.debug}`);
    if (meta.run.logsDir !== undefined) lines.push(`${pad}run.logs_dir = "${meta.run.logsDir}"`);
    if (meta.run.recoverLimit !== undefined) lines.push(`${pad}run.recover_limit = ${meta.run.recoverLimit}`);
  }
  if (meta.runtime) {
    if (meta.runtime.dockerImage !== undefined) lines.push(`${pad}runtime.docker_image = "${meta.runtime.dockerImage}"`);
    if (meta.runtime.dockerNetwork !== undefined) lines.push(`${pad}runtime.docker_network = "${meta.runtime.dockerNetwork}"`);
    if (meta.runtime.dockerTimeoutSeconds !== undefined) {
      lines.push(`${pad}runtime.docker_timeout_seconds = ${meta.runtime.dockerTimeoutSeconds}`);
    }
  }
  if (meta.module) {
    if (meta.module.name !== undefined) lines.push(`${pad}module.name = "${meta.module.name}"`);
    if (meta.module.version !== undefined) lines.push(`${pad}module.version = "${meta.module.version}"`);
    if (meta.module.description !== undefined) lines.push(`${pad}module.description = "${meta.module.description}"`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Top-level `const` RHS: bare slugs, JSON string, or triple-quoted when `"` / `\\` would break double-quote round-trip. */
function emitEnvDecl(env: EnvDeclDef): string[] {
  if (env.value.includes("\n")) {
    const lines = [`const ${env.name} = """`];
    for (const bl of env.value.split("\n")) {
      lines.push(bl);
    }
    lines.push('"""');
    return lines;
  }
  if (/^[A-Za-z0-9_./@+#%^&=*:~?-]+$/.test(env.value)) {
    return [`const ${env.name} = ${env.value}`];
  }
  if (/["\\]/.test(env.value)) {
    return [`const ${env.name} = """`, env.value, '"""'];
  }
  return [`const ${env.name} = ${JSON.stringify(env.value)}`];
}

function emitComments(comments: string[]): string[] {
  return comments.map((c) => (c.startsWith("#") ? c : `# ${c}`));
}

/** One section string: consecutive `#` lines stay single-spaced (module sections join with blank lines). */
function emitCommentBlock(comments: string[]): string {
  return emitComments(comments).join("\n");
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

function emitScript(script: ScriptDef, _pad: string, exported: boolean, trivia: Trivia): string {
  const lines: string[] = [];
  lines.push(...emitComments(script.comments));
  const prefix = exported ? "export " : "";
  const bodyKind = tn(trivia, script).scriptBodyKind;
  if (bodyKind === "fenced" || script.lang || script.body.includes("\n")) {
    const langTag = script.lang ?? "";
    lines.push(`${prefix}script ${script.name} = \`\`\`${langTag}`);
    for (const bl of script.body.split("\n")) {
      lines.push(bl);
    }
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

/** `log` / `logerr` message: bare identifier form vs JSON-string form (matches parse storage). */
function emitLogMessageRhs(message: string): string {
  // Parser stores bare `log name` as the literal string `${name}` (interpolation sentinel).
  if (
    message.length >= 3 &&
    message[0] === "$" &&
    message[1] === "{" &&
    message[message.length - 1] === "}"
  ) {
    const inner = message.slice(2, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
      return inner;
    }
  }
  return JSON.stringify(message);
}

function emitSteps(steps: WorkflowStepDef[], pad: string, currentIndent: string, trivia: Trivia): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(...emitStep(step, pad, currentIndent, trivia));
  }
  return lines;
}

/**
 * Render `Arg[]` back as comma-separated source form. Each `var` becomes the bare name
 * and each `literal` is emitted as authored (already in source form, including nested
 * `run …` / `ensure …` calls and inline-script bodies).
 */
function formatArgs(args: Arg[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.map((a) => (a.kind === "var" ? a.name : a.raw)).join(", ");
}

/** Emit inline script form: `prefix \`body\`(args)` or fenced block. */
function emitInlineScriptLines(
  prefix: string,
  body: string,
  lang: string | undefined,
  args: Arg[] | undefined,
  ci?: string,
): string[] {
  const argsStr = formatArgs(args);
  if (lang || body.includes("\n")) {
    const langTag = lang ?? "";
    const result = [`${prefix} \`\`\`${langTag}`];
    for (const bl of body.split("\n")) {
      result.push(bl);
    }
    result.push(`${ci ?? ""}\`\`\`(${argsStr})`);
    return result;
  }
  return [`${prefix} \`${body}\`(${argsStr})`];
}

function emitRef(ref: { value: string }, args: Arg[] | undefined): string {
  if (args !== undefined) {
    return `${ref.value}(${formatArgs(args)})`;
  }
  return `${ref.value}()`;
}

function emitMatchPattern(p: import("../types").MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  return "_";
}

function emitMatchArm(arm: import("../types").MatchArmDef, armIndent: string, bodyIndent: string): string[] {
  const patStr = emitMatchPattern(arm.pattern);
  // Multiline body (triple-quoted): body stored as "line1\nline2" with outer quotes and actual newlines.
  if (arm.body.startsWith('"') && arm.body.endsWith('"') && arm.body.includes("\n")) {
    const inner = arm.body.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const lines: string[] = [`${armIndent}${patStr} => """`];
    for (const bl of inner.split("\n")) {
      lines.push(bl);
    }
    lines.push(`${bodyIndent}"""`);
    return lines;
  }
  return [`${armIndent}${patStr} => ${arm.body}`];
}

function emitStep(step: WorkflowStepDef, pad: string, currentIndent: string, trivia: Trivia): string[] {
  const lines: string[] = [];
  const ci = currentIndent;
  const stepTrivia = tn(trivia, step);

  switch (step.type) {
    case "blank_line":
      lines.push("");
      break;

    case "comment":
      lines.push(`${ci}${step.text}`);
      break;

    case "shell": {
      if (step.captureName) {
        lines.push(`${ci}${step.captureName} = ${step.command}`);
      } else {
        lines.push(`${ci}${step.command}`);
      }
      break;
    }

    case "ensure": {
      const ref = emitRef(step.ref, step.args);
      const capture = step.captureName ? `${step.captureName} = ` : "";
      if (step.catch) {
        const b = step.catch.bindings;
        const bindStr = `(${b.failure})`;
        if ("single" in step.catch) {
          const recoverLines = emitStep(step.catch.single, pad, "", trivia);
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}ensure ${ref} catch ${bindStr} ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}ensure ${ref} catch ${bindStr} {`);
          lines.push(...emitSteps(step.catch.block, pad, ci + pad, trivia));
          lines.push(`${ci}}`);
        }
      } else {
        lines.push(`${ci}${capture}ensure ${ref}`);
      }
      break;
    }

    case "run": {
      const ref = emitRef(step.workflow, step.args);
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const asyncPrefix = step.async ? "async " : "";
      if (step.recover) {
        const b = step.recover.bindings;
        const bindStr = `(${b.failure})`;
        if ("single" in step.recover) {
          const recoverLines = emitStep(step.recover.single, pad, "", trivia);
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} recover ${bindStr} ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} recover ${bindStr} {`);
          lines.push(...emitSteps(step.recover.block, pad, ci + pad, trivia));
          lines.push(`${ci}}`);
        }
      } else if (step.catch) {
        const b = step.catch.bindings;
        const bindStr = `(${b.failure})`;
        if ("single" in step.catch) {
          const recoverLines = emitStep(step.catch.single, pad, "", trivia);
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} catch ${bindStr} ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} catch ${bindStr} {`);
          lines.push(...emitSteps(step.catch.block, pad, ci + pad, trivia));
          lines.push(`${ci}}`);
        }
      } else {
        lines.push(`${ci}${capture}run ${asyncPrefix}${ref}`);
      }
      break;
    }

    case "run_inline_script": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const argsStr = formatArgs(step.args);
      if (step.lang || step.body.includes("\n")) {
        const langTag = step.lang ?? "";
        lines.push(`${ci}${capture}run \`\`\`${langTag}`);
        for (const bl of step.body.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}\`\`\`(${argsStr})`);
      } else {
        lines.push(`${ci}${capture}run \`${step.body}\`(${argsStr})`);
      }
      break;
    }

    case "prompt": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const returns = step.returns ? ` returns "${step.returns}"` : "";
      const bodyKind = stepTrivia.bodyKind;
      const bodyIdentifier = stepTrivia.bodyIdentifier;
      if (bodyKind === "identifier" && bodyIdentifier) {
        lines.push(`${ci}${capture}prompt ${bodyIdentifier}${returns}`);
      } else if (bodyKind === "triple_quoted") {
        const inner = stepTrivia.rawBody ?? step.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}${capture}prompt """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
        if (step.returns) {
          lines.push(`${ci}returns "${step.returns}"`);
        }
      } else {
        lines.push(`${ci}${capture}prompt ${step.raw}${returns}`);
      }
      break;
    }

    case "const": {
      const valueTrivia = tn(trivia, step.value);
      lines.push(`${ci}${emitConstStep(step.name, step.value, valueTrivia)}`);
      // Handle multi-line inline script capture body
      if (step.value.kind === "run_inline_script_capture" &&
          (step.value.lang || step.value.body.includes("\n"))) {
        for (const bl of step.value.body.split("\n")) {
          lines.push(bl);
        }
        const argsStr = formatArgs(step.value.args);
        lines.push(`${ci}\`\`\`(${argsStr})`);
      }
      // Handle multi-line triple-quoted prompt capture body
      if (step.value.kind === "prompt_capture" && valueTrivia.bodyKind === "triple_quoted") {
        const inner = valueTrivia.rawBody ?? step.value.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
        if (step.value.returns) {
          lines.push(`${ci}returns "${step.value.returns}"`);
        }
      }
      // Handle match expression arms and closing brace
      if (step.value.kind === "match_expr") {
        for (const arm of step.value.match.arms) {
          lines.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
        }
        lines.push(`${ci}}`);
      }
      // Handle multi-line triple-quoted expr (const name = """...""")
      if (step.value.kind === "expr" && valueTrivia.tripleQuoted) {
        const inner = valueTrivia.rawBody ?? step.value.bashRhs.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      }
      break;
    }

    case "fail": {
      if (stepTrivia.tripleQuoted) {
        const inner = stepTrivia.rawBody ?? step.message.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}fail """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}fail ${step.message}`);
      }
      break;
    }

    case "log":
      if (step.managed?.kind === "run_inline_script") {
        lines.push(...emitInlineScriptLines(`${ci}log run`, step.managed.body, step.managed.lang, step.managed.args, ci));
      } else if (stepTrivia.tripleQuoted) {
        const inner = stepTrivia.rawBody ?? step.message;
        lines.push(`${ci}log """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}log ${emitLogMessageRhs(step.message)}`);
      }
      break;

    case "logerr":
      if (step.managed?.kind === "run_inline_script") {
        lines.push(...emitInlineScriptLines(`${ci}logerr run`, step.managed.body, step.managed.lang, step.managed.args, ci));
      } else if (stepTrivia.tripleQuoted) {
        const inner = stepTrivia.rawBody ?? step.message;
        lines.push(`${ci}logerr """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}logerr ${emitLogMessageRhs(step.message)}`);
      }
      break;

    case "return": {
      if (step.managed) {
        if (step.managed.kind === "run") {
          lines.push(`${ci}return run ${emitRef(step.managed.ref, step.managed.args)}`);
        } else if (step.managed.kind === "ensure") {
          lines.push(`${ci}return ensure ${emitRef(step.managed.ref, step.managed.args)}`);
        } else if (step.managed.kind === "match") {
          lines.push(`${ci}return match ${step.managed.match.subject} {`);
          for (const arm of step.managed.match.arms) {
            lines.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
          }
          lines.push(`${ci}}`);
        } else if (step.managed.kind === "run_inline_script") {
          lines.push(...emitInlineScriptLines(`${ci}return run`, step.managed.body, step.managed.lang, step.managed.args, ci));
        }
      } else if (stepTrivia.bareSource) {
        lines.push(`${ci}return ${stepTrivia.bareSource}`);
      } else if (stepTrivia.tripleQuoted) {
        const inner = stepTrivia.rawBody ?? step.value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}return """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}return ${step.value}`);
      }
      break;
    }

    case "send": {
      const rhsTrivia = tn(trivia, step.rhs);
      if (step.rhs.kind === "literal" && rhsTrivia.tripleQuoted) {
        const inner = rhsTrivia.rawBody ?? step.rhs.token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}${step.channel} <- """`);
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        const rhs = emitSendRhs(step.rhs);
        lines.push(`${ci}${step.channel} <- ${rhs}`);
      }
      break;
    }


    case "match": {
      lines.push(`${ci}match ${step.expr.subject} {`);
      for (const arm of step.expr.arms) {
        lines.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
      }
      lines.push(`${ci}}`);
      break;
    }

    case "if": {
      const operandStr = step.operand.kind === "string_literal"
        ? `"${step.operand.value}"`
        : `/${step.operand.source}/`;
      lines.push(`${ci}if ${step.subject} ${step.operator} ${operandStr} {`);
      lines.push(...emitSteps(step.body, pad, ci + pad, trivia));
      lines.push(`${ci}}`);
      break;
    }

    case "for_lines": {
      lines.push(`${ci}for ${step.iterVar} in ${step.sourceVar} {`);
      lines.push(...emitSteps(step.body, pad, ci + pad, trivia));
      lines.push(`${ci}}`);
      break;
    }
  }

  return lines;
}

function emitConstStep(name: string, value: ConstRhs, valueTrivia: NodeTrivia): string {
  switch (value.kind) {
    case "expr":
      if (valueTrivia.tripleQuoted) {
        // Multi-line: caller handles remaining lines
        return `const ${name} = """`;
      }
      return `const ${name} = ${value.bashRhs}`;
    case "run_capture": {
      const asyncMod = value.async ? "async " : "";
      return `const ${name} = run ${asyncMod}${emitRef(value.ref, value.args)}`;
    }
    case "ensure_capture":
      return `const ${name} = ensure ${emitRef(value.ref, value.args)}`;
    case "prompt_capture": {
      const returns = value.returns ? ` returns "${value.returns}"` : "";
      if (valueTrivia.bodyKind === "identifier" && valueTrivia.bodyIdentifier) {
        return `const ${name} = prompt ${valueTrivia.bodyIdentifier}${returns}`;
      }
      if (valueTrivia.bodyKind === "triple_quoted") {
        // Multi-line: caller handles remaining lines
        return `const ${name} = prompt """`;
      }
      return `const ${name} = prompt ${value.raw}${returns}`;
    }
    case "match_expr": {
      // Multi-line format; return first line (const assignment opens the block)
      return `const ${name} = match ${value.match.subject} {`;
    }
    case "run_inline_script_capture": {
      const argsStr = formatArgs(value.args);
      if (value.lang || value.body.includes("\n")) {
        const langTag = value.lang ?? "";
        return `const ${name} = run \`\`\`${langTag}`;
      }
      return `const ${name} = run \`${value.body}\`(${argsStr})`;
    }
  }
}

function emitSendRhs(rhs: SendRhsDef): string {
  switch (rhs.kind) {
    case "literal":
      return rhs.token;
    case "var":
      return rhs.bash;
    case "run":
      return `run ${emitRef(rhs.ref, rhs.args)}`;
    case "bare_ref":
      return rhs.ref.value;
    case "shell":
      return rhs.command;
  }
}

function emitTestBlock(test: TestBlockDef, pad: string, trivia: Trivia): string {
  const lines: string[] = [];
  const lc = tn(trivia, test).leadingComments;
  if (lc?.length) {
    lines.push(...emitComments(lc));
  }
  lines.push(`test "${test.description}" {`);
  for (const step of test.steps) {
    lines.push(...emitTestStep(step, pad, trivia));
  }
  lines.push("}");
  return lines.join("\n");
}

function emitTestStep(step: TestStepDef, pad: string, trivia: Trivia): string[] {
  switch (step.type) {
    case "comment":
      return [`${pad}${step.text}`];
    case "blank_line":
      return [""];
    case "test_const":
      return [`${pad}const ${step.name} = "${step.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`];
    case "test_mock_prompt":
      return step.responseVar
        ? [`${pad}mock prompt ${step.responseVar}`]
        : [`${pad}mock prompt "${step.response}"`];
    case "test_mock_prompt_block": {
      const lines = [`${pad}mock prompt {`];
      for (const arm of step.arms) {
        lines.push(...emitMatchArm(arm, `${pad}${pad}`, pad));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_run_workflow": {
      const capture = step.captureName ? `const ${step.captureName} = ` : "";
      const args = step.args && step.args.length > 0 ? step.args.map((a) => `"${a}"`).join(", ") : "";
      const allow = step.allowFailure ? " allow_failure" : "";
      return [`${pad}${capture}run ${step.workflowRef}(${args})${allow}`];
    }
    case "test_expect_contain":
      return step.substringVar
        ? [`${pad}expect_contain ${step.variable} ${step.substringVar}`]
        : [`${pad}expect_contain ${step.variable} "${step.substring}"`];
    case "test_expect_not_contain":
      return step.substringVar
        ? [`${pad}expect_not_contain ${step.variable} ${step.substringVar}`]
        : [`${pad}expect_not_contain ${step.variable} "${step.substring}"`];
    case "test_expect_equal":
      return step.expectedVar
        ? [`${pad}expect_equal ${step.variable} ${step.expectedVar}`]
        : [`${pad}expect_equal ${step.variable} "${step.expected}"`];
    case "test_mock_workflow": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock workflow ${step.ref}${paramStr} {`];
      lines.push(...emitSteps(step.steps, pad, pad + pad, trivia));
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_mock_rule": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock rule ${step.ref}${paramStr} {`];
      lines.push(...emitSteps(step.steps, pad, pad + pad, trivia));
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_mock_script": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock script ${step.ref}${paramStr} {`];
      for (const bodyLine of step.body.split("\n")) {
        lines.push(bodyLine);
      }
      lines.push(`${pad}}`);
      return lines;
    }
  }
}
