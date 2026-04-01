import type {
  jaiphModule,
  WorkflowStepDef,
  ConstRhs,
  SendRhsDef,
  IfConditionDef,
  WorkflowDef,
  RuleDef,
  ScriptDef,
  WorkflowRouteDef,
  TestBlockDef,
  TestStepDef,
  EnvDeclDef,
  WorkflowMetadata,
} from "../types";

export interface EmitOptions {
  indent: number;
}

const DEFAULT_OPTIONS: EmitOptions = { indent: 2 };

export function emitModule(mod: jaiphModule, opts: EmitOptions = DEFAULT_OPTIONS): string {
  const sections: string[] = [];
  const pad = " ".repeat(opts.indent);

  // Shebang — we don't store it in the AST, so the caller must prepend it if needed.
  // (handled by the format command reading the first line of the original source)

  for (const imp of mod.imports) {
    sections.push(`import "${imp.path}" as ${imp.alias}`);
  }

  if (mod.metadata) {
    sections.push(emitConfig(mod.metadata, pad));
  }

  for (const ch of mod.channels) {
    sections.push(`channel ${ch.name}`);
  }

  if (mod.envDecls) {
    for (const env of mod.envDecls) {
      sections.push(emitEnvDecl(env));
    }
  }

  for (const r of mod.rules) {
    sections.push(emitRule(r, pad));
  }

  for (const s of mod.scripts) {
    sections.push(emitScript(s, pad));
  }

  for (const w of mod.workflows) {
    sections.push(emitWorkflow(w, pad));
  }

  if (mod.tests) {
    for (const t of mod.tests) {
      sections.push(emitTestBlock(t, pad));
    }
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

function emitEnvDecl(env: EnvDeclDef): string {
  return `const ${env.name} = ${env.value}`;
}

function emitComments(comments: string[]): string[] {
  return comments.map((c) => (c.startsWith("#") ? c : `# ${c}`));
}

function emitRule(rule: RuleDef, pad: string): string {
  const lines: string[] = [];
  lines.push(...emitComments(rule.comments));
  lines.push(`rule ${rule.name} {`);
  lines.push(...emitSteps(rule.steps, pad, pad));
  lines.push("}");
  return lines.join("\n");
}

function emitScript(script: ScriptDef, pad: string): string {
  const lines: string[] = [];
  lines.push(...emitComments(script.comments));
  lines.push(`script ${script.name} {`);
  if (script.shebang) {
    lines.push(`${pad}${script.shebang}`);
  }
  for (const cmd of script.commands) {
    lines.push(`${pad}${cmd}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function emitWorkflow(wf: WorkflowDef, pad: string): string {
  const lines: string[] = [];
  lines.push(...emitComments(wf.comments));

  const header = wf.metadata ? `workflow ${wf.name} {` : `workflow ${wf.name} {`;
  lines.push(header);

  if (wf.metadata) {
    const configLines = emitConfig(wf.metadata, pad + pad);
    // Inline the config block inside the workflow
    for (const cl of configLines.split("\n")) {
      lines.push(`${pad}${cl}`);
    }
  }

  lines.push(...emitSteps(wf.steps, pad, pad));

  if (wf.routes) {
    for (const route of wf.routes) {
      lines.push(emitRoute(route, pad));
    }
  }

  lines.push("}");
  return lines.join("\n");
}

function emitRoute(route: WorkflowRouteDef, pad: string): string {
  const targets = route.workflows.map((w) => w.value).join(", ");
  return `${pad}${route.channel} -> ${targets}`;
}

function emitSteps(steps: WorkflowStepDef[], pad: string, currentIndent: string): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(...emitStep(step, pad, currentIndent));
  }
  return lines;
}

function emitRef(ref: { value: string }, args?: string): string {
  if (args !== undefined) {
    return `${ref.value}(${args})`;
  }
  return `${ref.value}()`;
}

function emitCondition(cond: IfConditionDef, negated: boolean): string {
  const neg = negated ? "not " : "";
  if (cond.kind === "ensure") {
    return `${neg}ensure ${emitRef(cond.ref, cond.args)}`;
  }
  return `${neg}run ${emitRef(cond.ref, cond.args)}`;
}

function emitMatchPattern(p: import("../types").MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  return "_";
}

function emitStep(step: WorkflowStepDef, pad: string, currentIndent: string): string[] {
  const lines: string[] = [];
  const ci = currentIndent;

  switch (step.type) {
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
      if (step.recover) {
        if ("single" in step.recover) {
          const recoverLines = emitStep(step.recover.single, pad, "");
          const recoverText = recoverLines.map((l) => l.trim()).join("\n");
          lines.push(`${ci}${capture}ensure ${ref} recover ${recoverText}`);
        } else {
          lines.push(`${ci}${capture}ensure ${ref} recover {`);
          lines.push(...emitSteps(step.recover.block, pad, ci + pad));
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
      lines.push(`${ci}${capture}run ${asyncPrefix}${ref}`);
      break;
    }

    case "run_inline_script": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const args = step.args ? `, ${step.args.split(" ").map((a) => `"${a}"`).join(", ")}` : "";
      const body = step.shebang ? `${step.shebang}\\n${step.body}` : step.body;
      lines.push(`${ci}${capture}run script("${body}"${args})`);
      break;
    }

    case "prompt": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const returns = step.returns ? ` returns "${step.returns}"` : "";
      lines.push(`${ci}${capture}prompt ${step.raw}${returns}`);
      break;
    }

    case "const": {
      lines.push(`${ci}${emitConstStep(step.name, step.value)}`);
      break;
    }

    case "fail":
      lines.push(`${ci}fail ${step.message}`);
      break;

    case "wait":
      lines.push(`${ci}wait`);
      break;

    case "log":
      lines.push(`${ci}log "${step.message}"`);
      break;

    case "logerr":
      lines.push(`${ci}logerr "${step.message}"`);
      break;

    case "return": {
      if (step.managed) {
        if (step.managed.kind === "run") {
          lines.push(`${ci}return run ${emitRef(step.managed.ref, step.managed.args)}`);
        } else if (step.managed.kind === "ensure") {
          lines.push(`${ci}return ensure ${emitRef(step.managed.ref, step.managed.args)}`);
        } else if (step.managed.kind === "match") {
          lines.push(`${ci}return ${step.managed.match.subject} match {`);
          for (const arm of step.managed.match.arms) {
            lines.push(`${ci}${pad}${emitMatchPattern(arm.pattern)} => ${arm.body}`);
          }
          lines.push(`${ci}}`);
        }
      } else {
        lines.push(`${ci}return ${step.value}`);
      }
      break;
    }

    case "send": {
      const rhs = emitSendRhs(step.rhs);
      lines.push(`${ci}${step.channel} <- ${rhs}`);
      break;
    }

    case "if": {
      const cond = emitCondition(step.condition, step.negated);
      lines.push(`${ci}if ${cond} {`);
      lines.push(...emitSteps(step.thenSteps, pad, ci + pad));
      lines.push(`${ci}}`);

      if (step.elseIfBranches) {
        for (const branch of step.elseIfBranches) {
          const branchCond = emitCondition(branch.condition, branch.negated);
          lines.push(`${ci}else if ${branchCond} {`);
          lines.push(...emitSteps(branch.thenSteps, pad, ci + pad));
          lines.push(`${ci}}`);
        }
      }

      if (step.elseSteps && step.elseSteps.length > 0) {
        lines.push(`${ci}else {`);
        lines.push(...emitSteps(step.elseSteps, pad, ci + pad));
        lines.push(`${ci}}`);
      }
      break;
    }

    case "match": {
      lines.push(`${ci}match ${step.expr.subject} {`);
      for (const arm of step.expr.arms) {
        lines.push(`${ci}${pad}${emitMatchPattern(arm.pattern)} => ${arm.body}`);
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
      return `const ${name} = ${value.bashRhs}`;
    case "run_capture":
      return `const ${name} = run ${emitRef(value.ref, value.args)}`;
    case "ensure_capture":
      return `const ${name} = ensure ${emitRef(value.ref, value.args)}`;
    case "prompt_capture": {
      const returns = value.returns ? ` returns "${value.returns}"` : "";
      return `const ${name} = prompt "${value.raw}"${returns}`;
    }
    case "match_expr": {
      // Multi-line format; return first line (const assignment opens the block)
      return `const ${name} = ${value.match.subject} match {`;
    }
    case "run_inline_script_capture": {
      const args = value.args ? `, ${value.args.split(" ").map((a) => `"${a}"`).join(", ")}` : "";
      const body = value.shebang ? `${value.shebang}\\n${value.body}` : value.body;
      return `const ${name} = run script("${body}"${args})`;
    }
  }
}

function emitSendRhs(rhs: SendRhsDef): string {
  switch (rhs.kind) {
    case "forward":
      return "forward";
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

function emitTestBlock(test: TestBlockDef, pad: string): string {
  const lines: string[] = [];
  lines.push(`test "${test.description}" {`);
  for (const step of test.steps) {
    lines.push(...emitTestStep(step, pad));
  }
  lines.push("}");
  return lines.join("\n");
}

function emitTestStep(step: TestStepDef, pad: string): string[] {
  switch (step.type) {
    case "test_shell":
      return [`${pad}${step.command}`];
    case "test_mock_prompt":
      return [`${pad}mock_prompt "${step.response}"`];
    case "test_mock_prompt_block": {
      const lines = [`${pad}mock prompt {`];
      for (const arm of step.arms) {
        lines.push(`${pad}${pad}${emitMatchPattern(arm.pattern)} => ${arm.body}`);
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_run_workflow": {
      const capture = step.captureName ? `${step.captureName} = ` : "";
      const args = step.args && step.args.length > 0 ? ` ${step.args.map((a) => `"${a}"`).join(" ")}` : "";
      const allow = step.allowFailure ? " allow_failure" : "";
      return [`${pad}${capture}${step.workflowRef}${args}${allow}`];
    }
    case "test_expect_contain":
      return [`${pad}expectContain ${step.variable} "${step.substring}"`];
    case "test_expect_not_contain":
      return [`${pad}expectNotContain ${step.variable} "${step.substring}"`];
    case "test_expect_equal":
      return [`${pad}expectEqual ${step.variable} "${step.expected}"`];
    case "test_mock_workflow":
      return [`${pad}mock_workflow ${step.ref} {`, `${pad}${pad}${step.body}`, `${pad}}`];
    case "test_mock_rule":
      return [`${pad}mock_rule ${step.ref} {`, `${pad}${pad}${step.body}`, `${pad}}`];
    case "test_mock_script":
      return [`${pad}mock_script ${step.ref} {`, `${pad}${pad}${step.body}`, `${pad}}`];
  }
}
