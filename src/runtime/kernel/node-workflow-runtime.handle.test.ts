import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInvalidAsyncHandleError,
  SEND_OUTSIDE_DEF_CONTEXT_ERROR,
} from "./node-workflow-runtime";

test("formatInvalidAsyncHandleError: includes the handle id and consumption hint", () => {
  const msg = formatInvalidAsyncHandleError("__JAIPH_HANDLE__7");
  assert.match(msg, /invalid async handle "__JAIPH_HANDLE__7"/);
  assert.match(msg, /was never created or was already consumed/);
});

test("send-outside-context error names `def`, not the retired `workflow` noun", () => {
  assert.match(SEND_OUTSIDE_DEF_CONTEXT_ERROR, /\bdef\b/);
  assert.doesNotMatch(SEND_OUTSIDE_DEF_CONTEXT_ERROR, /workflow/);
});
