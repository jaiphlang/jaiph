import type { TestBlockDef, TestStepDef } from "../types";
import { encodeQuoted, type Trivia } from "../parser";
import { emitComments, tn } from "./emit-shared";
import { emitMatchArm, emitSteps } from "./emit-steps";

// `test "…" { … }` block emitters. Split from `emit-steps.ts` so both stay
// under the analyzability line cap. Reuses the step-tree emitters for the
// `mock def` / `mock prompt { … }` arms.

export function emitTestBlock(test: TestBlockDef, pad: string, trivia: Trivia): string {
  const lines: string[] = [];
  const lc = tn(trivia, test).leadingComments;
  if (lc?.length) {
    lines.push(...emitComments(lc));
  }
  lines.push(`test ${encodeQuoted(test.description)} {`);
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
      if (step.value.includes("\n")) {
        return [
          `${pad}const ${step.name} = """`,
          ...step.value.split("\n").map((l) => (l ? `${pad}${pad}${l}` : "")),
          `${pad}"""`,
        ];
      }
      return [`${pad}const ${step.name} = ${encodeQuoted(step.value)}`];
    case "test_mock_prompt":
      return step.responseVar
        ? [`${pad}mock prompt ${step.responseVar}`]
        : [`${pad}mock prompt ${encodeQuoted(step.response)}`];
    case "test_mock_prompt_block": {
      const lines = [`${pad}mock prompt {`];
      for (const arm of step.arms) {
        lines.push(...emitMatchArm(arm, `${pad}${pad}`, pad));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case "test_run_def": {
      const capture = step.captureName ? `const ${step.captureName} = ` : "";
      const args = step.args && step.args.length > 0 ? step.args.map((a) => encodeQuoted(a)).join(", ") : "";
      const allow = step.allowFailure ? " allow_failure" : "";
      return [`${pad}${capture}${step.defRef}(${args})${allow}`];
    }
    case "test_expect_contain":
      return step.substringVar
        ? [`${pad}expect_contain ${step.variable} ${step.substringVar}`]
        : [`${pad}expect_contain ${step.variable} ${encodeQuoted(step.substring)}`];
    case "test_expect_not_contain":
      return step.substringVar
        ? [`${pad}expect_not_contain ${step.variable} ${step.substringVar}`]
        : [`${pad}expect_not_contain ${step.variable} ${encodeQuoted(step.substring)}`];
    case "test_expect_equal":
      return step.expectedVar
        ? [`${pad}expect_equal ${step.variable} ${step.expectedVar}`]
        : [`${pad}expect_equal ${step.variable} ${encodeQuoted(step.expected)}`];
    case "test_mock_def": {
      const paramStr = `(${step.params.join(", ")})`;
      const lines = [`${pad}mock def ${step.ref}${paramStr} {`];
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
