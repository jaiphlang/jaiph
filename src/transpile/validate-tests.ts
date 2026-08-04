import type { Diagnostics } from "../diagnostics";
import type { jaiphModule, TestBlockDef } from "../types";

/**
 * Validate `*.test.jh` test blocks: reject mixing block-form and queued
 * prompt mocks, and check that every name referenced by a mock/expect step
 * is in scope (declared earlier in the same block). Split out of
 * `validate.ts` to keep that file under the analyzability line cap.
 */
export function validateTestBlocks(
  diag: Diagnostics,
  ast: jaiphModule,
  tests: TestBlockDef[],
): void {
  for (const tb of tests) {
    // Reject mixing `mock prompt { … }` with queued `mock prompt "…"` /
    // `mock prompt <const>` in one test block — previously the queue entries
    // were silently ignored when a block was present, so authored mocks
    // could mask bugs by going unused.
    diag.capture(() => {
      let blockStep: { loc: { line: number; col: number } } | undefined;
      let queueStep: { loc: { line: number; col: number } } | undefined;
      for (const step of tb.steps) {
        if (step.type === "test_mock_prompt_block" && !blockStep) blockStep = step;
        if (step.type === "test_mock_prompt" && !queueStep) queueStep = step;
        if (blockStep && queueStep) break;
      }
      if (blockStep && queueStep) {
        const loc = blockStep.loc.line > queueStep.loc.line ? blockStep.loc : queueStep.loc;
        diag.error(
          ast.filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          'cannot mix "mock prompt { … }" with queued "mock prompt …" in one test block; choose one style',
        );
      }
    });

    const inScope = new Set<string>();
    for (const step of tb.steps) {
      diag.capture(() => {
        if (step.type === "test_const") {
          inScope.add(step.name);
          return;
        }
        if (step.type === "test_run_workflow") {
          if (step.captureName) inScope.add(step.captureName);
          return;
        }
        if (step.type === "test_mock_prompt" && step.responseVar) {
          if (!inScope.has(step.responseVar)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `mock prompt: undefined name "${step.responseVar}" (declare it earlier with: const ${step.responseVar} = "…")`,
            );
          }
          return;
        }
        if (
          step.type === "test_expect_contain" ||
          step.type === "test_expect_not_contain" ||
          step.type === "test_expect_equal"
        ) {
          if (!inScope.has(step.variable)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `${step.type.replace("test_", "")}: undefined name "${step.variable}" (capture it first with: const ${step.variable} = run …)`,
            );
          }
          const refName =
            step.type === "test_expect_equal" ? step.expectedVar : step.substringVar;
          if (refName !== undefined && !inScope.has(refName)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `${step.type.replace("test_", "")}: undefined name "${refName}" (declare it earlier with: const ${refName} = "…")`,
            );
          }
        }
      });
    }
  }
}
