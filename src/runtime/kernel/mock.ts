// Test-mode mock response and dispatch helpers.

/**
 * Process-local queue of sequential prompt responses, populated from the JSON
 * env var on first call and consumed in order. Re-seeds when the JSON changes
 * (different test block / different workflow run).
 */
let cachedResponsesJson = "";
let responsesQueue: string[] = [];

/** Take the next sequential mock response. Returns null when the queue is empty. */
export function consumeNextMockResponse(json: string): string | null {
  if (json !== cachedResponsesJson) {
    cachedResponsesJson = json;
    try {
      responsesQueue = JSON.parse(json) as string[];
    } catch {
      process.stderr.write("jaiph: invalid JAIPH_MOCK_RESPONSES_JSON\n");
      return null;
    }
  }
  return responsesQueue.shift() ?? null;
}

/** Serialised arm form passed via JAIPH_MOCK_PROMPT_ARMS_JSON. */
export type MockPromptArm =
  | { kind: "string"; pattern: string; response: string }
  | { kind: "regex"; pattern: string; response: string }
  | { kind: "wildcard"; response: string };

/**
 * Match a prompt against the arms (in order), returning the first matching response.
 * If no arm matches and no wildcard is present, returns status=1 with a clear stderr.
 */
export function dispatchMockArms(
  promptText: string,
  arms: MockPromptArm[],
): { response: string; status: number } {
  for (const arm of arms) {
    if (arm.kind === "string") {
      if (promptText === arm.pattern) return { response: arm.response, status: 0 };
    } else if (arm.kind === "regex") {
      try {
        if (new RegExp(arm.pattern).test(promptText)) return { response: arm.response, status: 0 };
      } catch {
        // invalid regex — fall through to next arm
      }
    } else {
      return { response: arm.response, status: 0 };
    }
  }
  process.stderr.write(
    `jaiph: no mock matched prompt (no branch matched). Prompt preview: ${promptText.slice(0, 80)}...\n`,
  );
  return { response: "", status: 1 };
}
