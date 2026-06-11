import test from "node:test";
import assert from "node:assert/strict";
import { formatInvalidAsyncHandleError } from "./node-workflow-runtime";

test("formatInvalidAsyncHandleError: includes the handle id and consumption hint", () => {
  const msg = formatInvalidAsyncHandleError("__JAIPH_HANDLE__7");
  assert.match(msg, /invalid async handle "__JAIPH_HANDLE__7"/);
  assert.match(msg, /was never created or was already consumed/);
});
