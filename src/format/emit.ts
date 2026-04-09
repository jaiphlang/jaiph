import type {
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

export interface EmitOptions {
  indent: number;
}

const DEFAULT_OPTIONS: EmitOptions = { indent: 2 };

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

function topLevelOrderForEmit(mod: jaiphModule): TopLevelEmitOrder[] {
  if (mod.topLevelOrder && mod.topLevelOrder.length > 0) return mod.topLevelOrder;
  return legacyTopLevelOrder(mod);
}

export function emitModule(mod: jaiphModule, opts: EmitOptions = DEFAULT_OPTIONS): string {
  const sections: string[] = [];
  const pad = " ".repeat(opts.indent);

  // Shebang — we don't store it in the AST, so the caller must prepend it if needed.
  // (handled by the format command reading the first line of the original source)

  for (const imp of mod.imports) {
    if (imp.leadingComments?.length) {
      sections.push(...emitComments(imp.leadingComments));
    }
    sections.push(`import "${imp.path}" as ${imp.alias}`);
  }

  if (mod.metadata) {
    if (mod.configLeadingComments?.length) {
      sections.push(...emitComments(mod.configLeadingComments));
    }
    sections.push(emitConfig(mod.metadata, pad));
  }

  for (const ch of mod.channels) {
    if (ch.leadingComments?.length) {
      sections.push(...emitComments(ch.leadingComments));
    }
    sections.push(emitChannel(ch));
  }

  const exportedNames = new Set(mod.exports);

  for (const item of topLevelOrderForEmit(mod)) {
    if (item.kind === "env") {
      sections.push(emitEnvDecl(mod.envDecls![item.index]).join("\n"));
      continue;
    }
    if (item.kind === "rule") {
      sections.push(emitRule(mod.rules[item.index], pad, exportedNames.has(mod.rules[item.index].name)));
      continue;
    }
    if (item.kind === "script") {
      sections.push(
        emitScript(mod.scripts[item.index], pad, exportedNames.has(mod.scripts[item.index].name)),
      );
      continue;
    }
    if (item.kind === "workflow") {
      sections.push(
        emitWorkflow(
          mod.workflows[item.index],
          pad,
          exportedNames.has(mod.workflows[item.index].name),
        ),
      );
      continue;
    }
    sections.push(emitTestBlock(mod.tests![item.index], pad));
  }

  return sections.join("\n\n") + "\n";
}

function emitConfig(meta: WorkflowMetadata, pad: string): string {
  const lines: string[] = ["config {"];
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
    if (meta.run.inboxParallel !== undefined) lines.push(`${pad}run.inbox_parallel = ${meta.run.inboxParallel}`);
  }
  if (meta.runtime) {
    if (meta.runtime.dockerEnabled !== undefined) lines.push(`${pad}runtime.docker_enabled = ${meta.runtime.dockerEnabled}`);
    if (meta.runtime.dockerImage !== undefined) lines.push(`${pad}runtime.docker_image = "${meta.runtime.dockerImage}"`);
    if (meta.runtime.dockerNetwork !== undefined) lines.push(`${pad}runtime.docker_network = "${meta.runtime.dockerNetwork}"`);
    if (meta.runtime.dockerTimeout !== undefined) lines.push(`${pad}runtime.docker_timeout = ${meta.runtime.dockerTimeout}`);
    if (meta.runtime.workspace !== undefined) {
      if (meta.runtime.workspace.length === 0) {
        lines.push(`${pad}runtime.workspace = []`);
      } else {
        lines.push(`${pad}runtime.workspace = [`);
        for (const w of meta.runtime.workspace) {
          lines.push(`${pad}${pad}"${w}",`);
        }
        lines.push(`${pad}]`);
      }
    }
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
  return [`const ${env.name} = ${env.value}`];
}

function emitComments(comments: string[]): string[] {
  return comments.map((c) => (c.startsWith("#") ? c : `# ${c}`));
}

function emitRule(rule: RuleDef, pad: string, exported: boolean): string {
  const lines: string[] = [];
  lines.push(...emitComments(rule.comments));
  const paramStr = `(${rule.params.join(", ")})`;
  const prefix = exported ? "export " : "";
  lines.push(`${prefix}rule ${rule.name}${paramStr} {`);
  lines.push(...emitSteps(rule.steps, pad, pad));
  lines.push("}");
  return lines.join("\n");
}

function emitScript(script: ScriptDef, _pad: string, exported: boolean): string {
  const lines: string[] = [];
  lines.push(...emitComments(script.comments));
  const prefix = exported ? "export " : "";
  if (script.bodyKind === "fenced" || script.lang || script.body.includes("\n")) {
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

function emitWorkflow(wf: WorkflowDef, pad: string, exported: boolean): string {
  const lines: string[] = [];
  lines.push(...emitComments(wf.comments));

  const paramStr = `(${wf.params.join(", ")})`;
  const prefix = exported ? "export " : "";
  lines.push(`${prefix}workflow ${wf.name}${paramStr} {`);

  if (wf.metadata) {
    const configLines = emitConfig(wf.metadata, pad + pad);
    // Inline the config block inside the workflow
    for (const cl of configLines.split("\n")) {
      lines.push(`${pad}${cl}`);
    }
  }

  lines.push(...emitSteps(wf.steps, pad, pad));

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

function emitSteps(steps: WorkflowStepDef[], pad: string, currentIndent: string): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(...emitStep(step, pad, currentIndent));
  }
  return lines;
}

/** Convert space-separated args back to comma-separated format with bare identifiers. */
function formatArgs(args: string, bareIdentifierArgs?: string[]): string {
  const bare = new Set(bareIdentifierArgs ?? []);
  const tokens: string[] = [];
  let i = 0;
  while (i < args.length) {
    while (i < args.length && (args[i] === " " || args[i] === "\t")) i++;
    if (i >= args.length) break;
    if (args[i] === '"') {
      let j = i + 1;
      while (j < args.length && !(args[j] === '"' && args[j - 1] !== "\\")) j++;
      tokens.push(args.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < args.length && args[j] !== " " && args[j] !== "\t") j++;
      const token = args.slice(i, j);
      const m = token.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
      if (m && bare.has(m[1])) {
        tokens.push(m[1]);
      } else {
        tokens.push(token);
      }
      i = j;
    }
  }
  return tokens.join(", ");
}

function emitRef(ref: { value: string }, args?: string, bareIdentifierArgs?: string[]): string {
  if (args !== undefined) {
    return `${ref.value}(${formatArgs(args, bareIdentifierArgs)})`;
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

function emitStep(step: WorkflowStepDef, pad: string, currentIndent: string): string[] {
  const lines: string[] = [];
  const ci = currentIndent;

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
      const ref = emitRef(step.ref, step.args, step.bareIdentifierArgs);
      const capture = step.captureName ? `${step.captureName} = ` : "";
      if (step.recover) {
        const b = step.recover.bindings;
        const bindStr = `(${b.failure})`;
        if ("single" in step.recover) {
          const recoverLines = emitStep(step.recover.single, pad, "");
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}ensure ${ref} recover ${bindStr} ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}ensure ${ref} recover ${bindStr} {`);
          lines.push(...emitSteps(step.recover.block, pad, ci + pad));
          lines.push(`${ci}}`);
        }
      } else {
        lines.push(`${ci}${capture}ensure ${ref}`);
      }
      break;
    }

    case "run": {
      const ref = emitRef(step.workflow, step.args, step.bareIdentifierArgs);
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const asyncPrefix = step.async ? "async " : "";
      if (step.recover) {
        const b = step.recover.bindings;
        const bindStr = `(${b.failure})`;
        if ("single" in step.recover) {
          const recoverLines = emitStep(step.recover.single, pad, "");
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} recover ${bindStr} ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}run ${asyncPrefix}${ref} recover ${bindStr} {`);
          lines.push(...emitSteps(step.recover.block, pad, ci + pad));
          lines.push(`${ci}}`);
        }
      } else {
        lines.push(`${ci}${capture}run ${asyncPrefix}${ref}`);
      }
      break;
    }

    case "run_inline_script": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const argsStr = formatArgs(step.args ?? "", step.bareIdentifierArgs);
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
      if (step.bodyKind === "identifier" && step.bodyIdentifier) {
        lines.push(`${ci}${capture}prompt ${step.bodyIdentifier}${returns}`);
      } else if (step.bodyKind === "triple_quoted") {
        const inner = step.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
      lines.push(`${ci}${emitConstStep(step.name, step.value)}`);
      // Handle multi-line inline script capture body
      if (step.value.kind === "run_inline_script_capture" &&
          (step.value.lang || step.value.body.includes("\n"))) {
        for (const bl of step.value.body.split("\n")) {
          lines.push(bl);
        }
        const argsStr = formatArgs(step.value.args ?? "", step.value.bareIdentifierArgs);
        lines.push(`${ci}\`\`\`(${argsStr})`);
      }
      // Handle multi-line triple-quoted prompt capture body
      if (step.value.kind === "prompt_capture" && step.value.bodyKind === "triple_quoted") {
        const inner = step.value.raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
      if (step.value.kind === "expr" && step.value.bashRhs.startsWith('"') &&
          step.value.bashRhs.endsWith('"') && step.value.bashRhs.includes("\n")) {
        const inner = step.value.bashRhs.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        for (const bl of inner.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      }
      break;
    }

    case "fail": {
      if (step.message.includes("\n")) {
        const inner = step.message.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
      if (step.message.includes("\n")) {
        lines.push(`${ci}log """`);
        for (const bl of step.message.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}log "${step.message}"`);
      }
      break;

    case "logerr":
      if (step.message.includes("\n")) {
        lines.push(`${ci}logerr """`);
        for (const bl of step.message.split("\n")) {
          lines.push(bl);
        }
        lines.push(`${ci}"""`);
      } else {
        lines.push(`${ci}logerr "${step.message}"`);
      }
      break;

    case "return": {
      if (step.managed) {
        if (step.managed.kind === "run") {
          lines.push(`${ci}return run ${emitRef(step.managed.ref, step.managed.args, step.managed.bareIdentifierArgs)}`);
        } else if (step.managed.kind === "ensure") {
          lines.push(`${ci}return ensure ${emitRef(step.managed.ref, step.managed.args, step.managed.bareIdentifierArgs)}`);
        } else if (step.managed.kind === "match") {
          lines.push(`${ci}return match ${step.managed.match.subject} {`);
          for (const arm of step.managed.match.arms) {
            lines.push(...emitMatchArm(arm, `${ci}${pad}`, ci));
          }
          lines.push(`${ci}}`);
        }
      } else if (step.value.includes("\n")) {
        const inner = step.value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
      if (step.rhs.kind === "literal" && step.rhs.token.includes("\n")) {
        const inner = step.rhs.token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
  }

  return lines;
}

function emitConstStep(name: string, value: ConstRhs): string {
  switch (value.kind) {
    case "expr":
      if (value.bashRhs.startsWith('"') && value.bashRhs.endsWith('"') && value.bashRhs.includes("\n")) {
        // Multi-line: caller handles remaining lines
        return `const ${name} = """`;
      }
      return `const ${name} = ${value.bashRhs}`;
    case "run_capture":
      return `const ${name} = run ${emitRef(value.ref, value.args, value.bareIdentifierArgs)}`;
    case "ensure_capture":
      return `const ${name} = ensure ${emitRef(value.ref, value.args, value.bareIdentifierArgs)}`;
    case "prompt_capture": {
      const returns = value.returns ? ` returns "${value.returns}"` : "";
      if (value.bodyKind === "identifier" && value.bodyIdentifier) {
        return `const ${name} = prompt ${value.bodyIdentifier}${returns}`;
      }
      if (value.bodyKind === "triple_quoted") {
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
      const argsStr = formatArgs(value.args ?? "", value.bareIdentifierArgs);
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
      return `run ${emitRef(rhs.ref, rhs.args, rhs.bareIdentifierArgs)}`;
    case "bare_ref":
      return rhs.ref.value;
    case "shell":
      return rhs.command;
  }
}

function emitTestBlock(test: TestBlockDef, pad: string): string {
  const lines: string[] = [];
  if (test.leadingComments?.length) {
    lines.push(...emitComments(test.leadingComments));
  }
  lines.push(`test "${test.description}" {`);
  for (const step of test.steps) {
    lines.push(...emitTestStep(step, pad));
  }
  lines.push("}");
  return lines.join("\n");
}

function emitTestStep(step: TestStepDef, pad: string): string[] {
  switch (step.type) {
    case "test_mock_prompt":
      return [`${pad}mock prompt "${step.response}"`];
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
      return [`${pad}expect_contain ${step.variable} "${step.substring}"`];
    case "test_expect_not_contain":
      return [`${pad}expect_not_contain ${step.variable} "${step.substring}"`];
    case "test_expect_equal":
      return [`${pad}expect_equal ${step.variable} "${step.expected}"`];
    case "test_mock_workflow": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock workflow ${step.ref}${paramStr} {`];
      lines.push(...emitSteps(step.steps, pad, pad + pad));
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_mock_rule": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock rule ${step.ref}${paramStr} {`];
      lines.push(...emitSteps(step.steps, pad, pad + pad));
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
