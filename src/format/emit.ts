import type {
  Arg,
  Expr,
  jaiphModule,
  WorkflowStepDef,
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

function tn(trivia: Trivia, node: object): NodeTrivia {
  return trivia.getNode(node) ?? {};
}

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

/** Bare-identifier form for `log <ident>` / `logerr <ident>`. */
function emitLogLiteralRhs(message: string): string {
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

function formatArgs(args: Arg[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.map((a) => (a.kind === "var" ? a.name : a.raw)).join(", ");
}

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
  return `${ref.value}(${formatArgs(args)})`;
}

function emitMatchPattern(p: import("../types").MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  return "_";
}

function emitMatchArm(arm: import("../types").MatchArmDef, armIndent: string, bodyIndent: string): string[] {
  const patStr = emitMatchPattern(arm.pattern);
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

/**
 * Emit an `Expr` as it would appear after a `=` / `<-` / `return` / `log` etc.
 * Multi-line value forms (inline-script fenced bodies, triple-quoted literals,
 * match arm blocks, triple-quoted prompts) return additional lines via the
 * `tail` array so the caller can append them at the right indent level.
 */
function emitExprFirstLine(
  expr: Expr,
  trivia: Trivia,
  ci: string,
  pad: string,
): { head: string; tail: string[] } {
  const valueTrivia = tn(trivia, expr);
  if (expr.kind === "literal") {
    if (valueTrivia.tripleQuoted) {
      const inner = valueTrivia.rawBody ?? expr.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const tail: string[] = [];
      for (const bl of inner.split("\n")) tail.push(bl);
      tail.push(`${ci}"""`);
      return { head: '"""', tail };
    }
    if (valueTrivia.bareSource) {
      return { head: valueTrivia.bareSource, tail: [] };
    }
    return { head: expr.raw, tail: [] };
  }
  if (expr.kind === "call") {
    const asyncMod = expr.async ? "async " : "";
    return { head: `run ${asyncMod}${emitRef(expr.callee, expr.args)}`, tail: [] };
  }
  if (expr.kind === "ensure_call") {
    return { head: `ensure ${emitRef(expr.callee, expr.args)}`, tail: [] };
  }
  if (expr.kind === "inline_script") {
    if (expr.lang || expr.body.includes("\n")) {
      const langTag = expr.lang ?? "";
      const tail: string[] = [];
      for (const bl of expr.body.split("\n")) tail.push(bl);
      tail.push(`${ci}\`\`\`(${formatArgs(expr.args)})`);
      return { head: `run \`\`\`${langTag}`, tail };
    }
    return { head: `run \`${expr.body}\`(${formatArgs(expr.args)})`, tail: [] };
  }
  if (expr.kind === "prompt") {
    const returns = expr.returns ? ` returns "${expr.returns}"` : "";
    if (valueTrivia.bodyKind === "identifier" && valueTrivia.bodyIdentifier) {
      return { head: `prompt ${valueTrivia.bodyIdentifier}${returns}`, tail: [] };
    }
    if (valueTrivia.bodyKind === "triple_quoted") {
      const inner = valueTrivia.rawBody ?? expr.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const tail: string[] = [];
      for (const bl of inner.split("\n")) tail.push(bl);
      tail.push(`${ci}"""`);
      if (expr.returns) {
        tail.push(`${ci}returns "${expr.returns}"`);
      }
      return { head: 'prompt """', tail };
    }
    return { head: `prompt ${expr.raw}${returns}`, tail: [] };
  }
  if (expr.kind === "match") {
    const tail: string[] = [];
    for (const arm of expr.match.arms) {
      tail.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
    }
    tail.push(`${ci}}`);
    return { head: `match ${expr.match.subject} {`, tail };
  }
  if (expr.kind === "shell") {
    return { head: expr.command, tail: [] };
  }
  // bare_ref
  return { head: expr.ref.value, tail: [] };
}

function emitStep(step: WorkflowStepDef, pad: string, currentIndent: string, trivia: Trivia): string[] {
  const lines: string[] = [];
  const ci = currentIndent;

  if (step.type === "trivia") {
    if (step.kind === "blank_line") {
      lines.push("");
    } else {
      lines.push(`${ci}${step.text ?? ""}`);
    }
    return lines;
  }

  if (step.type === "say") {
    const message = step.message;
    if (step.level === "fail") {
      // fail always takes a literal message; preserve triple-quoted form when present.
      const msgTrivia = tn(trivia, message);
      if (message.kind === "literal" && msgTrivia.tripleQuoted) {
        const inner = msgTrivia.rawBody ?? message.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}fail """`);
        for (const bl of inner.split("\n")) lines.push(bl);
        lines.push(`${ci}"""`);
      } else if (message.kind === "literal") {
        lines.push(`${ci}fail ${message.raw}`);
      } else {
        const { head, tail } = emitExprFirstLine(message, trivia, ci, pad);
        lines.push(`${ci}fail ${head}`);
        lines.push(...tail);
      }
      return lines;
    }
    const verb = step.level;
    if (message.kind === "inline_script") {
      lines.push(...emitInlineScriptLines(`${ci}${verb} run`, message.body, message.lang, message.args, ci));
      return lines;
    }
    if (message.kind === "literal") {
      const msgTrivia = tn(trivia, message);
      if (msgTrivia.tripleQuoted) {
        const inner = msgTrivia.rawBody ?? message.raw;
        lines.push(`${ci}${verb} """`);
        for (const bl of inner.split("\n")) lines.push(bl);
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}${verb} ${emitLogLiteralRhs(message.raw)}`);
      }
      return lines;
    }
    // Fallback for any other Expr kind (shouldn't occur per validator).
    const { head, tail } = emitExprFirstLine(message, trivia, ci, pad);
    lines.push(`${ci}${verb} ${head}`);
    lines.push(...tail);
    return lines;
  }

  if (step.type === "shell" as never) {
    // Defensive: should never appear in the new AST (shell is an exec body kind).
    return lines;
  }

  if (step.type === "exec") {
    const body = step.body;
    if (body.kind === "shell") {
      if (step.captureName) {
        lines.push(`${ci}${step.captureName} = ${body.command}`);
      } else {
        lines.push(`${ci}${body.command}`);
      }
      return lines;
    }
    const capture = step.captureName ? `${step.captureName} = ` : "";
    if (body.kind === "call") {
      const ref = emitRef(body.callee, body.args);
      const asyncPrefix = body.async ? "async " : "";
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
      return lines;
    }
    if (body.kind === "ensure_call") {
      const ref = emitRef(body.callee, body.args);
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
      return lines;
    }
    if (body.kind === "inline_script") {
      const argsStr = formatArgs(body.args);
      if (body.lang || body.body.includes("\n")) {
        const langTag = body.lang ?? "";
        lines.push(`${ci}${capture}run \`\`\`${langTag}`);
        for (const bl of body.body.split("\n")) lines.push(bl);
        lines.push(`${ci}\`\`\`(${argsStr})`);
      } else {
        lines.push(`${ci}${capture}run \`${body.body}\`(${argsStr})`);
      }
      return lines;
    }
    if (body.kind === "prompt") {
      const bodyTrivia = tn(trivia, body);
      const returns = body.returns ? ` returns "${body.returns}"` : "";
      if (bodyTrivia.bodyKind === "identifier" && bodyTrivia.bodyIdentifier) {
        lines.push(`${ci}${capture}prompt ${bodyTrivia.bodyIdentifier}${returns}`);
      } else if (bodyTrivia.bodyKind === "triple_quoted") {
        const inner = bodyTrivia.rawBody ?? body.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        lines.push(`${ci}${capture}prompt """`);
        for (const bl of inner.split("\n")) lines.push(bl);
        lines.push(`${ci}"""`);
        if (body.returns) lines.push(`${ci}returns "${body.returns}"`);
      } else {
        lines.push(`${ci}${capture}prompt ${body.raw}${returns}`);
      }
      return lines;
    }
    if (body.kind === "match") {
      lines.push(`${ci}${capture}match ${body.match.subject} {`);
      for (const arm of body.match.arms) {
        lines.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
      }
      lines.push(`${ci}}`);
      return lines;
    }
    // bare_ref / literal — not valid as exec body, but handle defensively.
    const { head, tail } = emitExprFirstLine(body, trivia, ci, pad);
    lines.push(`${ci}${capture}${head}`);
    lines.push(...tail);
    return lines;
  }

  if (step.type === "const") {
    const { head, tail } = emitExprFirstLine(step.value, trivia, ci, pad);
    lines.push(`${ci}const ${step.name} = ${head}`);
    lines.push(...tail);
    return lines;
  }

  if (step.type === "return") {
    const { head, tail } = emitExprFirstLine(step.value, trivia, ci, pad);
    lines.push(`${ci}return ${head}`);
    lines.push(...tail);
    return lines;
  }

  if (step.type === "send") {
    const { head, tail } = emitExprFirstLine(step.value, trivia, ci, pad);
    lines.push(`${ci}${step.channel} <- ${head}`);
    lines.push(...tail);
    return lines;
  }

  if (step.type === "if") {
    const operandStr = step.operand.kind === "string_literal"
      ? `"${step.operand.value}"`
      : `/${step.operand.source}/`;
    lines.push(`${ci}if ${step.subject} ${step.operator} ${operandStr} {`);
    lines.push(...emitSteps(step.body, pad, ci + pad, trivia));
    if (step.elseBody) {
      lines.push(`${ci}} else {`);
      lines.push(...emitSteps(step.elseBody, pad, ci + pad, trivia));
    }
    lines.push(`${ci}}`);
    return lines;
  }

  if (step.type === "for_lines") {
    lines.push(`${ci}for ${step.iterVar} in ${step.sourceVar} {`);
    lines.push(...emitSteps(step.body, pad, ci + pad, trivia));
    lines.push(`${ci}}`);
    return lines;
  }

  return lines;
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
