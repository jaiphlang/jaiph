import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROMPT_RETRY_DELAYS_MS,
  defaultPromptSleep,
  formatRetryDelay,
  isPromptRetryAbortError,
  PromptRetryAbortError,
  resolvePromptRetryDelays,
  summarizeError,
} from "./prompt-retry";

describe("resolvePromptRetryDelays", () => {
  it("returns the default schedule when env is empty", () => {
    assert.deepEqual(resolvePromptRetryDelays({}), [
      15_000, 60_000, 600_000, 1_800_000, 7_200_000,
    ]);
  });

  it("matches the documented default constant", () => {
    assert.deepEqual([...DEFAULT_PROMPT_RETRY_DELAYS_MS], resolvePromptRetryDelays({}));
  });

  it("disables retries when JAIPH_PROMPT_RETRY=0", () => {
    assert.deepEqual(resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY: "0" }), []);
  });

  it("disable switch trims whitespace", () => {
    assert.deepEqual(resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY: "  0  " }), []);
  });

  it("parses JAIPH_PROMPT_RETRY_DELAYS as comma-separated ms", () => {
    assert.deepEqual(
      resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY_DELAYS: "10,20,30" }),
      [10, 20, 30],
    );
  });

  it("trims whitespace around each delay entry", () => {
    assert.deepEqual(
      resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY_DELAYS: " 10 , 20 ,30 " }),
      [10, 20, 30],
    );
  });

  it("throws on non-numeric entries", () => {
    assert.throws(
      () => resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY_DELAYS: "10,abc,30" }),
      /JAIPH_PROMPT_RETRY_DELAYS contains invalid entry "abc"/,
    );
  });

  it("throws on negative-looking entries (sign chars are rejected)", () => {
    assert.throws(
      () => resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY_DELAYS: "10,-5" }),
      /JAIPH_PROMPT_RETRY_DELAYS contains invalid entry "-5"/,
    );
  });

  it("throws on empty list when the var is set with only commas/whitespace", () => {
    assert.throws(
      () => resolvePromptRetryDelays({ JAIPH_PROMPT_RETRY_DELAYS: " , , " }),
      /JAIPH_PROMPT_RETRY_DELAYS is set but has no delay entries/,
    );
  });
});

describe("defaultPromptSleep", () => {
  it("resolves after the requested ms when not aborted", async () => {
    const start = Date.now();
    const ctrl = new AbortController();
    await defaultPromptSleep(20, ctrl.signal);
    assert.ok(Date.now() - start >= 15, "should have actually waited (~20ms)");
  });

  it("rejects with PromptRetryAbortError when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => defaultPromptSleep(10_000, ctrl.signal),
      (err) => isPromptRetryAbortError(err) && err instanceof PromptRetryAbortError,
    );
  });

  it("rejects promptly when aborted mid-sleep", async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    const pending = defaultPromptSleep(10_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(pending, (err) => isPromptRetryAbortError(err));
    assert.ok(Date.now() - start < 500, "abort should short-circuit the wait");
  });
});

describe("formatRetryDelay", () => {
  it("renders sub-second values in ms", () => {
    assert.equal(formatRetryDelay(750), "750ms");
  });

  it("renders seconds for <60s values", () => {
    assert.equal(formatRetryDelay(15_000), "15s");
  });

  it("renders minutes for <60m values", () => {
    assert.equal(formatRetryDelay(60_000), "1m");
    assert.equal(formatRetryDelay(600_000), "10m");
    assert.equal(formatRetryDelay(1_800_000), "30m");
  });

  it("renders hours for >=60m values", () => {
    assert.equal(formatRetryDelay(7_200_000), "2h");
  });
});

describe("summarizeError", () => {
  it("returns first non-empty line, trimmed", () => {
    assert.equal(summarizeError("  first line  \nsecond line"), "first line");
  });

  it("placeholder when error is empty", () => {
    assert.equal(summarizeError(""), "(no error message)");
    assert.equal(summarizeError("   \n   "), "(no error message)");
  });

  it("truncates very long lines with an ellipsis marker", () => {
    const long = "x".repeat(400);
    const out = summarizeError(long);
    assert.ok(out.length <= 220);
    assert.match(out, /…$/);
  });
});
