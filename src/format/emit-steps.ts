import type {
  Arg,
  Expr,
  StepDef,
  MatchPatternDef,
  MatchArmDef,
} from "../types";
import type { Trivia } from "../parser";
import {
  decodeTripleQuotedInner,
  emitFencedScriptBodyLines,
  emitRef,
  formatArgs,
  tn,
} from "./emit-shared";

// Step / expression / test-block emitters. The declaration emitters in
// `emit.ts` call `emitSteps` for rule / workflow bodies; splitting the step
// tree out keeps each file under the analyzability line cap.

/** Bare-identifier form for `log <ident>` / `logerr <ident>` / `logwarn <ident>`. */
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

export function emitSteps(steps: StepDef[], pad: string, currentIndent: string, trivia: Trivia): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(...emitStep(step, pad, currentIndent, trivia));
  }
  return lines;
}

function emitInlineScriptLines(
  prefix: string,
  body: string,
  lang: string | undefined,
  args: Arg[] | undefined,
  closeIndent: string,
  bodyIndent: string,
): string[] {
  const argsStr = formatArgs(args);
  if (lang || body.includes("\n")) {
    const langTag = lang ?? "";
    const result = [`${prefix} \`\`\`${langTag}`];
    result.push(...emitFencedScriptBodyLines(body, bodyIndent));
    result.push(`${closeIndent}\`\`\`(${argsStr})`);
    return result;
  }
  return [`${prefix} \`${body}\`(${argsStr})`];
}

function emitMatchPattern(p: MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  if (p.kind === "alternation") return p.patterns.map(emitMatchPattern).join(" | ");
  return "_";
}

export function emitMatchArm(arm: MatchArmDef, armIndent: string, bodyIndent: string): string[] {
  const patStr = emitMatchPattern(arm.pattern);
  if (arm.body.startsWith('"') && arm.body.endsWith('"') && arm.body.includes("\n")) {
    const inner = decodeTripleQuotedInner(arm.body);
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
 * Emit an `Expr` as it would appear after a `=` / `send` / `return` / `log` etc.
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
      const inner = valueTrivia.rawBody ?? decodeTripleQuotedInner(expr.raw);
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
  if (expr.kind === "inline_script") {
    if (expr.lang || expr.body.includes("\n")) {
      const langTag = expr.lang ?? "";
      const bodyIndent = `${ci}${pad}`;
      const tail = emitFencedScriptBodyLines(expr.body, bodyIndent);
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
      const inner = valueTrivia.rawBody ?? decodeTripleQuotedInner(expr.raw);
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

/** Render the `<subject> <op> <operand>` head shared by `if` and `else if`. */
function ifHead(step: Extract<StepDef, { type: "if" }>): string {
  const operandStr = step.operand.kind === "string_literal"
    ? `"${step.operand.value}"`
    : `/${step.operand.source}/`;
  return `${step.subject} ${step.operator} ${operandStr}`;
}

function emitStep(step: StepDef, pad: string, currentIndent: string, trivia: Trivia): string[] {
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
        const inner = msgTrivia.rawBody ?? decodeTripleQuotedInner(message.raw);
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
      lines.push(
        ...emitInlineScriptLines(`${ci}${verb} run`, message.body, message.lang, message.args, ci, `${ci}${pad}`),
      );
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
    if (body.kind === "inline_script") {
      lines.push(
        ...emitInlineScriptLines(`${ci}${capture}run`, body.body, body.lang, body.args, ci, `${ci}${pad}`),
      );
      return lines;
    }
    if (body.kind === "prompt") {
      const bodyTrivia = tn(trivia, body);
      const returns = body.returns ? ` returns "${body.returns}"` : "";
      if (bodyTrivia.bodyKind === "identifier" && bodyTrivia.bodyIdentifier) {
        lines.push(`${ci}${capture}prompt ${bodyTrivia.bodyIdentifier}${returns}`);
      } else if (bodyTrivia.bodyKind === "triple_quoted") {
        const inner = bodyTrivia.rawBody ?? decodeTripleQuotedInner(body.raw);
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
    if (tail.length === 0) {
      lines.push(`${ci}send ${head} -> ${step.channel}`);
    } else {
      lines.push(`${ci}send ${head}`);
      const last = tail[tail.length - 1]!;
      tail[tail.length - 1] = `${last} -> ${step.channel}`;
      lines.push(...tail);
    }
    return lines;
  }

  if (step.type === "if") {
    // Emit an `if` and any `else if` / `else` arms. A single-`if` `elseBody` is
    // the desugared shape of an `else if` arm, so collapse it back to `} else if`
    // rather than a nested `} else { if … }` block (round-trips author sugar).
    lines.push(`${ci}if ${ifHead(step)} {`);
    lines.push(...emitSteps(step.body, pad, ci + pad, trivia));
    let cur = step;
    while (cur.elseBody && cur.elseBody.length === 1 && cur.elseBody[0].type === "if") {
      const arm = cur.elseBody[0];
      lines.push(`${ci}} else if ${ifHead(arm)} {`);
      lines.push(...emitSteps(arm.body, pad, ci + pad, trivia));
      cur = arm;
    }
    if (cur.elseBody) {
      lines.push(`${ci}} else {`);
      lines.push(...emitSteps(cur.elseBody, pad, ci + pad, trivia));
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
